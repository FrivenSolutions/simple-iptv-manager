import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline as pipelineRaw } from 'node:stream/promises';
import { openDb } from './db.js';
import { Router, HttpError, sendJson, sendText, baseUrl } from './http.js';
import { checkSession, hashPassword, randomToken } from './auth.js';
import { Jobs } from './jobs.js';
import { registerApi } from './api.js';
import { loadOutput, selectChannels, evaluateCategories, nameCleaner, checkNameRules, parseNameRules, categoryAffixer } from './filters.js';
import { buildM3U, streamUrl, streamExt, converts } from './outputs/m3u.js';
import { writeEpg, EpgCache } from './outputs/epg.js';
import { findXcOutput, playerApi } from './outputs/xc.js';
import { serveChannel, serveSegment, serveVod } from './stream.js';
import { vodTarget } from './outputs/xcvod.js';
import { Streams } from './streams.js';
import { Viewers, clientIp } from './viewers.js';
import { Attempts, isPrivateAddress } from './guard.js';
import { Light, serveLight } from './light.js';
import { HDHR_API } from './hdhomerun.js';
import { currentVersion } from './version.js';
import { UpdateChecker, installType, DEFAULT_UPDATE_REPO } from './updates.js';
import { WebUpdater } from './webupdate.js';
import { Alerts } from './alerts.js';
import { AutoBackup } from './autobackup.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
// Wrong Xtream Codes logins allowed from one address before it is blocked, and for how long.
const XC_MAX_FAILS = 10;
const XC_BLOCK_MS = 10 * 60 * 1000;
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const UI_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    // media-src/worker-src blob: for the Watch page's player (Media Source Extensions).
    "default-src 'self'; img-src * data:; style-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'",
};

export function createApp({
  dataDir, adminPassword = '', log = defaultLog, hdhrApiBase = HDHR_API,
  updateApiBase = 'https://api.github.com', updateRepo = process.env.IPTV_UPDATE_REPO || DEFAULT_UPDATE_REPO,
  updateCheckDelayMs = 60_000, appCommit, webUpdatePathUnit, autoBackupDelayMs = 2 * 60_000,
  disableTwoFactor = false,
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.rmSync(path.join(dataDir, 'tmp'), { recursive: true, force: true });
  const db = openDb(path.join(dataDir, 'iptv-manager.db'));

  if (!db.getSetting('secret')) db.setSetting('secret', randomToken(32));
  // ADMIN_PASSWORD is applied on every start, which doubles as password recovery.
  if (adminPassword) db.setSetting('admin_hash', hashPassword(adminPassword));
  // DISABLE_2FA=1: the way back in after losing the authenticator and the recovery codes.
  if (disableTwoFactor && db.getSetting('totp_secret')) {
    for (const k of ['totp_secret', 'totp_last_step', 'totp_recovery', 'totp_pending']) db.setSetting(k, null);
    log('Two-factor sign-in turned off (DISABLE_2FA is set; remove it again)');
  }

  let version = 1;
  const selections = new Map();
  const vodSelections = new Map();

  const ctx = {
    db,
    dataDir,
    log,
    hdhrApi: hdhrApiBase,
    appVersion: APP_VERSION,
    secret: db.getSetting('secret'),
    get version() {
      return version;
    },
    bump() {
      version++;
    },
    sessionGen: () => Number(db.getSetting('session_gen', '1')),
    isAuthed: (req) => checkSession(req, ctx.secret, ctx.sessionGen()),
    secureCookies: (req) => req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').startsWith('https'),
    /**
     * Resolved channel list for an output, cached until the next data change. With a category
     * hiding channels by what the guide says is on now, the list changes over time too, so for
     * at most a minute, unless anyOld says a list a little behind the guide will do.
     */
    selection(outputId, { anyOld = false } = {}) {
      const minute = Math.floor(Date.now() / 60_000);
      const hit = selections.get(outputId);
      if (hit && hit.version === version && (anyOld || !hit.timed || hit.minute === minute)) return hit.sel;
      const output = loadOutput(db, outputId);
      if (!output) return null;
      const { categories, channels } = selectChannels(db, output);
      const signature = crypto.createHash('sha1').update(channels.map((c) => c.id).join(',')).digest('hex').slice(0, 12);
      const sel = { output, channels, signature, byId: new Map(channels.map((c) => [c.id, c])) };
      selections.set(outputId, { version, minute, timed: categories.some((c) => c.hide_by_guide), sel });
      return sel;
    },
    /**
     * Movies and series of an output, or null when it doesn't include them: for each kind, its
     * categories with their decisions, the included ids, and their order. Cached until data changes.
     */
    vod(outputId) {
      const hit = vodSelections.get(outputId);
      if (hit && hit.version === version) return hit.vod;
      const output = loadOutput(db, outputId);
      let vod = null;
      if (output?.vod_enabled) {
        vod = {};
        const clean = nameCleaner(checkNameRules(parseNameRules(output.name_rules)).rules || [], 'vod');
        const affix = categoryAffixer(output);
        // Titles picked out by hand (picks in are the default already).
        const excluded = new Set(db.all("SELECT item_id FROM output_vod_overrides WHERE output_id = ? AND state = 'exclude'", [outputId]).map((r) => r.item_id));
        for (const kind of ['movie', 'series']) {
          const cats = evaluateCategories(db, output, kind);
          vod[kind] = {
            cats,
            clean,
            affix,
            excluded,
            included: new Set(cats.filter((c) => c.included).map((c) => c.id)),
            order: new Map(cats.map((c, i) => [c.id, i])),
          };
        }
      }
      vodSelections.set(outputId, { version, vod });
      return vod;
    },
    epgCache: new EpgCache(path.join(dataDir, 'cache')),
  };
  ctx.jobs = new Jobs(ctx);
  const running = currentVersion(ROOT);
  ctx.build = {
    version: APP_VERSION,
    commit: appCommit === undefined ? running.commit : appCommit,
    commitSource: appCommit === undefined ? running.source : 'test',
    installType: installType(ROOT),
    repo: updateRepo,
  };
  ctx.webUpdate = new WebUpdater({ dataDir, pathUnit: webUpdatePathUnit });
  ctx.alerts = new Alerts(ctx);
  ctx.autoBackup = new AutoBackup(ctx, { firstDelayMs: autoBackupDelayMs });
  ctx.streams = new Streams(ctx);
  ctx.viewers = new Viewers();
  ctx.light = new Light(ctx);
  ctx.updates = new UpdateChecker({
    db, commit: ctx.build.commit, apiBase: updateApiBase, repo: updateRepo, delayMs: updateCheckDelayMs, log,
  });

  const router = new Router();
  registerApi(router, ctx);

  const statics = new Map();
  for (const f of fs.readdirSync(PUBLIC)) {
    const type = STATIC_TYPES[path.extname(f)];
    if (type) statics.set(`/${f}`, { body: fs.readFileSync(path.join(PUBLIC, f)), type });
  }
  statics.set('/', statics.get('/index.html'));
  // Player libraries for the Watch page, served from the installed packages (loaded only there).
  for (const [url, file] of [['/vendor/mpegts.js', 'mpegts.js/dist/mpegts.js'], ['/vendor/hls.js', 'hls.js/dist/hls.light.min.js']]) {
    const p = path.join(ROOT, 'node_modules', file);
    if (fs.existsSync(p)) statics.set(url, { body: fs.readFileSync(p), type: STATIC_TYPES['.js'] });
  }

  // --- published outputs ---------------------------------------------------
  const byToken = (token) => {
    const row = db.get('SELECT id, paused FROM outputs WHERE token = ?', [String(token)]);
    if (!row) throw new HttpError(404, 'Unknown output');
    if (row.paused) throw new HttpError(503, 'This output is paused');
    return ctx.selection(row.id);
  };
  const base = (req) => baseUrl(req, db.getSetting('base_url'));

  const sendPlaylist = (req, res, sel, urlFor, lightFor) => {
    const body = buildM3U(sel.output, sel.channels, base(req), urlFor, lightFor);
    sendText(res, 200, body, 'audio/x-mpegurl; charset=utf-8', {
      'content-disposition': 'inline; filename="playlist.m3u"',
      'cache-control': 'no-cache',
    });
  };

  // A player closing the connection mid-download is routine, not a server error.
  const pipeline = (...streams) => pipelineRaw(...streams).catch((e) => {
    if (e.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw e;
  });

  const sendEpg = async (req, res, sel, gzipped) => {
    // Keyed by the channel list too, so the guide follows channels hidden or shown by the clock.
    const file = await ctx.epgCache.get(sel.output.id, `${version}-${sel.signature}`, (f) => writeEpg(db, sel.output, sel.channels, f));
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const headers = { 'cache-control': 'no-cache' };
    if (gzipped) {
      res.writeHead(200, { ...headers, 'content-type': 'application/gzip', 'content-length': fs.statSync(file).size });
      if (req.method === 'HEAD') return res.end();
      return pipeline(fs.createReadStream(file), res);
    }
    if (acceptsGzip) {
      res.writeHead(200, { ...headers, 'content-type': 'application/xml; charset=utf-8', 'content-encoding': 'gzip', vary: 'accept-encoding' });
      if (req.method === 'HEAD') return res.end();
      return pipeline(fs.createReadStream(file), res);
    }
    res.writeHead(200, { ...headers, 'content-type': 'application/xml; charset=utf-8' });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(file), zlib.createGunzip(), res);
  };

  router.get('/healthz', (req, res) => sendJson(res, 200, { ok: true }));

  for (const name of ['playlist.m3u', 'playlist.m3u8', 'get.m3u']) {
    router.get(`/o/:token/${name}`, (req, res, { params }) => {
      const sel = byToken(params.token);
      sendPlaylist(req, res, sel, (ch) => streamUrl(base(req), sel.output, ch));
    });
  }
  router.get('/o/:token/epg.xml', (req, res, { params }) => sendEpg(req, res, byToken(params.token), false));
  router.get('/o/:token/epg.xml.gz', (req, res, { params }) => sendEpg(req, res, byToken(params.token), true));

  const channelOf = (sel, id) => {
    const ch = sel.byId.get(Number(id));
    if (!ch) throw new HttpError(404, 'Channel is not in this output');
    return ch;
  };
  // Who is watching (for the dashboard): the login's name when it has one, else its username;
  // the output's token URLs don't say who is using them.
  const whoOf = (username) => (username
    ? db.get('SELECT name FROM output_xc_logins WHERE username = ?', [String(username)])?.name || String(username)
    : 'Playlist link');
  const viewerOf = (req, sel, username, what, kind, sourceId, epgId = null) => ({
    outputId: sel.output.id, output: sel.output.name, who: whoOf(username), username: username || null,
    ip: clientIp(req), what, kind, source: sel.output.sources.find((s) => s.id === sourceId)?.name || null,
    sourceId, epgId,
  });
  const liveViewer = (req, sel, ch, username = null) => viewerOf(req, sel, username, ch.name, 'live', ch.source_id, ch.epg_id);

  router.get('/s/:token/seg/:id', (req, res, { params, query }) => {
    const sel = byToken(params.token);
    const ch = channelOf(sel, params.id);
    return serveSegment(ctx, res, sel.output, ch, query.get('u'), query.get('sig'), liveViewer(req, sel, ch));
  });
  // A stream link with ?light=1 asks for the channel's light copy (light.js), for players that
  // can't see tileiptv-light (an Xtream Codes login has no playlist attributes). Ignored when the
  // output doesn't offer light copies: the player gets the original and notices.
  const wantsLight = (sel, query) => query.get('light') === '1' && !!sel.output.light_enabled;
  router.get('/s/:token/:id.:ext', (req, res, { params, query }) => {
    const sel = byToken(params.token);
    const ch = channelOf(sel, params.id);
    if (wantsLight(sel, query)) return serveLight(ctx, res, ch, lightViewer(req, sel, ch));
    return serveChannel(ctx, res, sel.output, ch, params.ext, liveViewer(req, sel, ch));
  });

  // Light copies (light.js): always through this server, whatever the output's stream mode.
  const lightViewer = (req, sel, ch, username = null) => viewerOf(req, sel, username, ch.name, 'live', ch.source_id, ch.epg_id);
  const lightOf = (sel, file) => {
    if (!sel.output.light_enabled) throw new HttpError(404, 'This output does not offer light streams');
    return channelOf(sel, String(file).replace(/\.ts$/i, ''));
  };
  router.get('/light/:token/:file', (req, res, { params }) => {
    const sel = byToken(params.token);
    const ch = lightOf(sel, params.file);
    return serveLight(ctx, res, ch, lightViewer(req, sel, ch));
  });

  // --- Xtream Codes compatible endpoints -----------------------------------
  // Wrong Xtream Codes logins per visitor address: blocked for a while after XC_MAX_FAILS, so the
  // usernames and passwords can't be guessed. Devices on the local network aren't limited (a TV
  // with an old password keeps retrying; that's not an attack).
  const xcFails = new Attempts({ max: XC_MAX_FAILS, windowMs: XC_BLOCK_MS });
  const xcAuth = (req, username, password) => {
    const ip = clientIp(req);
    const limited = !isPrivateAddress(ip);
    if (limited && xcFails.blocked(ip)) throw new HttpError(429, 'Too many wrong logins; try again later');
    const id = findXcOutput(db, username, password);
    if (id) {
      if (limited) xcFails.ok(ip);
      return ctx.selection(id);
    }
    if (limited && xcFails.fail(ip)) ctx.log(`Xtream Codes login: ${XC_MAX_FAILS} wrong attempts from ${ip}; blocked for ${XC_BLOCK_MS / 60_000} minutes`);
    return null;
  };
  // Stream links carry the credentials of the login that asked for the playlist, never another's.
  const xcUrl = (req, sel, username, password) => (ch) => {
    if (sel.output.stream_mode === 'direct' && !converts(sel.output)) return ch.url;
    return `${base(req)}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${ch.id}.${streamExt(ch.url)}`;
  };

  const xcApi = async (req, res, { query }) => {
    const sel = xcAuth(req, query.get('username'), query.get('password'));
    if (!sel) return sendJson(res, 200, { user_info: { auth: 0 } });
    sendJson(res, 200, await playerApi(db, sel.output, sel, base(req), query, ctx.vod(sel.output.id)));
  };
  router.get('/player_api.php', xcApi);
  router.post('/player_api.php', xcApi);
  router.get('/get.php', (req, res, { query }) => {
    const sel = xcAuth(req, query.get('username'), query.get('password'));
    if (!sel) throw new HttpError(401, 'Invalid credentials');
    const [u, p] = [query.get('username'), query.get('password')];
    sendPlaylist(req, res, sel, xcUrl(req, sel, u, p), (ch) => `${base(req)}/light/${encodeURIComponent(u)}/${encodeURIComponent(p)}/${ch.id}.ts`);
  });
  router.get('/xmltv.php', (req, res, { query }) => {
    const sel = xcAuth(req, query.get('username'), query.get('password'));
    if (!sel) throw new HttpError(401, 'Invalid credentials');
    return sendEpg(req, res, sel, false);
  });
  const xcStream = (req, res, { params, query }) => {
    const sel = xcAuth(req, params.u, params.p);
    if (!sel) throw new HttpError(401, 'Invalid credentials');
    const [id, ext = 'ts'] = params.file.split('.');
    const ch = channelOf(sel, id);
    if (wantsLight(sel, query)) return serveLight(ctx, res, ch, lightViewer(req, sel, ch, params.u));
    return serveChannel(ctx, res, sel.output, ch, ext, liveViewer(req, sel, ch, params.u));
  };
  router.get('/live/:u/:p/:file', xcStream);
  router.get('/light/:u/:p/:file', (req, res, { params }) => {
    const sel = xcAuth(req, params.u, params.p);
    if (!sel) throw new HttpError(401, 'Invalid credentials');
    const ch = lightOf(sel, params.file);
    return serveLight(ctx, res, ch, lightViewer(req, sel, ch, params.u));
  });
  // Movies and series episodes: ids are this server's, checked against the output's categories.
  for (const kind of ['movie', 'series']) {
    router.get(`/${kind}/:u/:p/:file`, (req, res, { params }) => {
      const sel = xcAuth(req, params.u, params.p);
      if (!sel) throw new HttpError(401, 'Invalid credentials');
      const vod = ctx.vod(sel.output.id);
      const target = vod && vodTarget(db, vod, kind, params.file.split('.')[0]);
      if (!target) throw new HttpError(404, `${kind === 'movie' ? 'Movie' : 'Episode'} is not in this output`);
      return serveVod(ctx, req, res, sel.output, target,
        viewerOf(req, sel, params.u, target.title, kind === 'movie' ? 'movie' : 'episode', target.src.id));
    });
  }
  router.get('/:u/:p/:file', xcStream);

  // --- request dispatch ----------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;
    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && statics.has(pathname)) {
        const s = statics.get(pathname);
        res.writeHead(200, { 'content-type': s.type, 'content-length': s.body.length, 'cache-control': 'no-cache', ...UI_HEADERS });
        return res.end(req.method === 'HEAD' ? undefined : s.body);
      }
      const m = router.match(req.method, pathname);
      if (!m) throw new HttpError(404, 'Not found');
      if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');

      if (pathname.startsWith('/api/')) {
        // /api/widget checks its own key (for dashboards such as Homepage) instead of a session.
        const open = ['/api/session', '/api/setup', '/api/login', '/api/widget'].includes(pathname);
        if (!open && !ctx.isAuthed(req)) throw new HttpError(401, 'Not logged in');
        // Custom header blocks cross-site form posts (CSRF) without a token dance.
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'fetch') {
          throw new HttpError(403, 'Missing X-Requested-With header');
        }
      }
      await m.handler(req, res, { params: m.params, query: url.searchParams });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`Error handling ${req.method} ${pathname}: ${e.stack || e}`);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal error' : e.message });
      else res.destroy();
    }
  });

  return {
    server,
    ctx,
    start(port, host) {
      ctx.jobs.start();
      ctx.updates.start();
      ctx.alerts.start();
      ctx.autoBackup.start();
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    async close() {
      ctx.jobs.stop();
      ctx.updates.stop();
      ctx.alerts.stop();
      ctx.autoBackup.stop();
      ctx.streams.stop();
      ctx.light.stop();
      await new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      await ctx.jobs.idle();
      db.close();
    },
  };
}

function defaultLog(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}
