// Admin REST API behind the login session.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpError, sendJson, readJson, baseUrl } from './http.js';
import { hashPassword, verifyPassword, makeSession, sessionCookie, randomToken, COOKIE } from './auth.js';
import {
  OPS, loadOutput, evaluateCategories, channelCompare, positionsOf, isNewCategory, channelState,
  DEFAULT_EMPTY_EVENT_PATTERNS, emptyEventPatterns, compilePatterns, isEmptyEvent,
  DEFAULT_GUIDE_PATTERNS, guidePatterns, guideHider, hiddenReason,
  checkNameRules, parseNameRules, nameCleaner, nowTitles, affixText,
} from './filters.js';
import { rematchSource } from './ingest.js';
import { JELLYFIN_CATEGORIES, parseJellyfin } from './outputs/epg.js';
import { exportSettings, importSettings } from './backup.js';
import { computeAlerts } from './alerts.js';
import { KEEP as AUTO_BACKUP_KEEP } from './autobackup.js';
import { autoLimit } from './streams.js';
import { now } from './db.js';
import { serveWatch } from './stream.js';
import { newSecret, checkCode, otpauthUri, qrSvg, newRecoveryCodes, useRecoveryCode } from './totp.js';
import { clientIp } from './viewers.js';
import { Attempts, isPrivateAddress } from './guard.js';
import { ENCODERS, DEFAULT_LIGHT_MAX, serveLight } from './light.js';

const UPLOAD_LIMIT = 1024 * 1024 * 1024;
const IMPORT_LIMIT = 50 * 1024 * 1024;
const LOGIN_LOCK_AFTER = 5;
const CONVERT_MODES = ['off', 'needed', 'always'];
const NEW_CHANNEL_S = 7 * 86400;
const LOGIN_LOCK_S = 60;

const str = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));
const optStr = (v, max = 2000) => {
  const s = str(v, max);
  return s ? s : null;
};
const int = (v, dflt, min = -Infinity, max = Infinity) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

function mustGet(db, table, id) {
  const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, [Number(id)]);
  if (!row) throw new HttpError(404, 'Not found');
  return row;
}

function parseJson(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function sourceView(ctx, s) {
  const counts = ctx.db.get(
    `SELECT (SELECT COUNT(*) FROM channels WHERE source_id = ? AND active = 1) AS channels,
            (SELECT COUNT(*) FROM channels WHERE source_id = ? AND active = 1 AND epg_id IS NOT NULL) AS epg_matched,
            (SELECT COUNT(*) FROM categories WHERE source_id = ? AND active = 1 AND kind = 'live') AS categories,
            (SELECT COUNT(*) FROM vod_items WHERE source_id = ? AND active = 1 AND kind = 'movie') AS movies,
            (SELECT COUNT(*) FROM vod_items WHERE source_id = ? AND active = 1 AND kind = 'series') AS series`,
    [s.id, s.id, s.id, s.id, s.id],
  );
  return {
    ...s,
    xc_password: '',
    has_password: !!s.xc_password,
    live_only: !!s.live_only,
    enabled: !!s.enabled,
    stats: parseJson(s.stats),
    vod_stats: parseJson(s.vod_stats),
    account_info: parseJson(s.account_info),
    job: ctx.jobs.status(s.id),
    next_refresh_at: ctx.jobs.nextDue(s),
    counts,
    streams: {
      open: ctx.streams.open(s.id).size, limit: ctx.streams.limitFor(s.id), auto: autoLimit(s),
      // The latest stream the provider turned down (since the app started), and why.
      refused: ctx.streams.lastRefusal.get(s.id) || null,
    },
  };
}

function sourceFields(body, existing) {
  const type = existing?.type || (['xc', 'hdhr'].includes(body.type) ? body.type : 'm3u');
  const f = {
    name: str(body.name, 200) || existing?.name || 'Source',
    type,
    url: optStr(body.url),
    epg_urls: str(body.epg_urls, 20000),
    xc_host: optStr(body.xc_host),
    xc_username: optStr(body.xc_username, 200),
    // A blank password on edit keeps the stored one (the API never echoes it back).
    xc_password: str(body.xc_password, 200) || existing?.xc_password || null,
    xc_stream_ext: body.xc_stream_ext === 'm3u8' ? 'm3u8' : 'ts',
    hdhr_host: optStr(body.hdhr_host, 300),
    user_agent: str(body.user_agent, 500),
    live_only: body.live_only === undefined ? 1 : bool(body.live_only),
    refresh_minutes: int(body.refresh_minutes, 720, 0, 60 * 24 * 30),
    vod_refresh_minutes: body.vod_refresh_minutes === undefined ? existing?.vod_refresh_minutes ?? 1440
      : int(body.vod_refresh_minutes, 1440, 0, 60 * 24 * 30),
    enabled: body.enabled === undefined ? 1 : bool(body.enabled),
    // Blank = automatic, 0 = no limit.
    max_streams: body.max_streams === undefined ? existing?.max_streams ?? null
      : body.max_streams === '' || body.max_streams == null ? null : int(body.max_streams, null, 0, 1000),
  };
  if (type === 'xc') {
    if (!f.xc_host || !f.xc_username || !f.xc_password) throw new HttpError(400, 'Xtream Codes sources need a host, username and password');
  } else if (type === 'hdhr') {
    if (!f.hdhr_host) throw new HttpError(400, 'HDHomeRun sources need the box\'s IP address or hostname');
    if (/[\s?#]/.test(f.hdhr_host)) {
      throw new HttpError(400, 'Enter just the HDHomeRun\'s address, like 192.168.1.100');
    }
  } else if (f.url && !/^(https?:\/\/|upload:)/i.test(f.url)) {
    throw new HttpError(400, 'Playlist URL must start with http:// or https://');
  }
  return f;
}

export function validateRules(list) {
  return list
    .map((r) => {
      if (!['include', 'exclude'].includes(r.action)) throw new HttpError(400, 'Rule action must be include or exclude');
      if (!OPS.includes(r.op)) throw new HttpError(400, `Unknown rule operator: ${r.op}`);
      if (r.op === 'regex') {
        try {
          new RegExp(r.value);
        } catch {
          throw new HttpError(400, `Invalid regular expression: ${r.value}`);
        }
      }
      return {
        action: r.action, op: r.op, value: str(r.value, 500), source_id: r.source_id ? Number(r.source_id) : null,
        kind: ['movie', 'series'].includes(r.kind) ? r.kind : 'live',
      };
    })
    .filter((r) => r.value !== '');
}

export function validatePatterns(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Patterns must be a list');
  if (list.length > 50) throw new HttpError(400, 'At most 50 patterns');
  return list.map((p) => {
    const s = String(p ?? '').trim();
    if (!s) throw new HttpError(400, 'Patterns cannot be empty');
    if (s.length > 200) throw new HttpError(400, 'Patterns are limited to 200 characters');
    try {
      new RegExp(s, 'i');
    } catch {
      throw new HttpError(400, `Invalid regular expression: ${s}`);
    }
    return s;
  });
}

/** The output's saved name cleanup, for live TV or for movies and series. */
const cleanerFor = (o, kind) => nameCleaner(checkNameRules(parseNameRules(o.name_rules)).rules || [], kind === 'live' ? 'live' : 'vod');

function outputUrls(req, ctx, o) {
  const base = baseUrl(req, ctx.db.getSetting('base_url'));
  return {
    m3u: `${base}/o/${o.token}/playlist.m3u`,
    epg: `${base}/o/${o.token}/epg.xml`,
    epg_gz: `${base}/o/${o.token}/epg.xml.gz`,
    xc_server: o.xc_enabled ? base : null,
  };
}

function outputView(req, ctx, o, withDetail = false) {
  const sel = ctx.selection(o.id);
  const view = {
    id: o.id,
    name: o.name,
    token: o.token,
    stream_mode: o.stream_mode,
    include_all: !!o.include_all,
    include_all_movie: !!o.include_all_movie,
    include_all_series: !!o.include_all_series,
    number_start: o.number_start,
    epg_days: o.epg_days,
    xc_enabled: !!o.xc_enabled,
    vod_enabled: !!o.vod_enabled,
    light_enabled: !!o.light_enabled,
    convert_mode: o.convert_mode || 'off',
    cat_sort: o.cat_sort || 'provider',
    ch_sort: o.ch_sort || 'provider',
    paused: !!o.paused,
    xc_username: o.xc_username,
    xc_password: o.xc_password,
    updated_at: o.updated_at,
    channel_count: sel ? sel.channels.length : 0,
    category_count: sel ? new Set(sel.channels.map((c) => c.category_id)).size : 0,
    urls: outputUrls(req, ctx, o),
  };
  if (withDetail) {
    const attached = new Map(ctx.db.all('SELECT source_id, sort, cat_prefix, cat_suffix FROM output_sources WHERE output_id = ?', [o.id])
      .map((r) => [r.source_id, r]));
    view.sources = ctx.db.all('SELECT id, name, type FROM sources ORDER BY sort, id')
      .map((s) => {
        const a = attached.get(s.id);
        return { ...s, attached: !!a, sort: a?.sort ?? 999, cat_prefix: a?.cat_prefix || '', cat_suffix: a?.cat_suffix || '' };
      })
      .sort((a, b) => a.sort - b.sort || a.id - b.id);
    view.rules = ctx.db.all('SELECT id, source_id, kind, action, op, value FROM output_rules WHERE output_id = ? ORDER BY sort, id', [o.id]);
    view.name_rules = parseNameRules(o.name_rules);
    // Sorted by name (or username when unnamed), ignoring case.
    view.xc_logins = ctx.db.all(
      `SELECT id, name, username, password, enabled, created_at, last_used_at FROM output_xc_logins WHERE output_id = ?
        ORDER BY LOWER(CASE WHEN name <> '' THEN name ELSE username END), id`,
      [o.id],
    )
      .map((l) => ({ ...l, enabled: !!l.enabled }));
  }
  return view;
}

export function registerApi(router, ctx) {
  const { db } = ctx;
  // Wrong passwords and codes, per visitor address: a short lock after LOGIN_LOCK_AFTER of them.
  const failures = new Attempts({ max: LOGIN_LOCK_AFTER, windowMs: LOGIN_LOCK_S * 1000 });
  // And from everyone together: many in a short time means a spread-out guessing attack, so for a
  // while only addresses that signed in before, and the local network, may try at all.
  const everyone = new Attempts({ max: 50, windowMs: 15 * 60 * 1000 });
  const knownGood = new Set();

  const touch = () => ctx.bump();

  // --- session ---------------------------------------------------------------
  router.get('/api/session', (req, res) => {
    sendJson(res, 200, { setup_required: !db.getSetting('admin_hash'), authenticated: ctx.isAuthed(req) });
  });

  router.post('/api/setup', async (req, res) => {
    if (db.getSetting('admin_hash')) throw new HttpError(409, 'Already set up');
    // Whoever sets the first password owns the app: not someone who found it on the internet.
    if (!isPrivateAddress(clientIp(req))) {
      throw new HttpError(403, 'Set the first admin password from your local network, or with the ADMIN_PASSWORD setting.');
    }
    const { password } = await readJson(req);
    if (str(password).length < 8) throw new HttpError(400, 'Use at least 8 characters');
    db.setSetting('admin_hash', hashPassword(password));
    const s = makeSession(ctx.secret, ctx.sessionGen());
    res.setHeader('set-cookie', sessionCookie(s.value, s.maxAge, ctx.secureCookies(req)));
    sendJson(res, 200, { ok: true });
  });

  // --- two-factor sign-in (TOTP). Settings: totp_secret (on when set), totp_last_step (a code
  // works once), totp_recovery (hashes of unused recovery codes), totp_pending (during setup).
  const twoFactor = () => {
    const secret = db.getSetting('totp_secret');
    if (!secret) return null;
    let recovery = [];
    try {
      recovery = JSON.parse(db.getSetting('totp_recovery') || '[]');
    } catch {}
    return { secret, last: Number(db.getSetting('totp_last_step') ?? -1), recovery };
  };
  /** True if code is a fresh authenticator code or an unused recovery code (which is then used up). */
  const useSecondFactor = (code) => {
    const tf = twoFactor();
    if (!tf) return true;
    const step = checkCode(tf.secret, code, tf.last);
    if (step != null) {
      db.setSetting('totp_last_step', step);
      return true;
    }
    const left = useRecoveryCode(tf.recovery, code);
    if (!left) return false;
    db.setSetting('totp_recovery', JSON.stringify(left));
    ctx.log('Signed in with a two-factor recovery code');
    return true;
  };

  router.post('/api/login', async (req, res) => {
    const ip = clientIp(req);
    if (failures.blocked(ip)) throw new HttpError(429, 'Too many attempts; wait a minute');
    if (everyone.blocked('all') && !knownGood.has(ip) && !isPrivateAddress(ip)) {
      throw new HttpError(429, 'Too many failed sign-ins recently; try again later');
    }
    const fail = (message) => {
      if (failures.fail(ip)) ctx.log(`Sign-in: ${LOGIN_LOCK_AFTER} wrong attempts from ${ip}; blocked for ${LOGIN_LOCK_S} s`);
      if (everyone.fail('all')) {
        ctx.log('Sign-in: many wrong attempts from different addresses; for 15 minutes only addresses that signed in before, and the local network, can sign in');
      }
      throw new HttpError(401, message);
    };
    const { password, code } = await readJson(req);
    if (!verifyPassword(password || '', db.getSetting('admin_hash'))) fail('Wrong password');
    // Second step: the password was right; now the code (wrong ones count like wrong passwords).
    if (twoFactor()) {
      if (!code) return sendJson(res, 200, { two_factor_required: true });
      if (!useSecondFactor(code)) fail('That code is not right (or was already used)');
    }
    failures.ok(ip);
    knownGood.add(ip);
    const s = makeSession(ctx.secret, ctx.sessionGen());
    res.setHeader('set-cookie', sessionCookie(s.value, s.maxAge, ctx.secureCookies(req)));
    sendJson(res, 200, { ok: true });
  });

  // Every other signed-in browser is signed out (sessions carry a generation number); this one stays.
  router.post('/api/sessions/revoke', (req, res) => {
    db.setSetting('session_gen', ctx.sessionGen() + 1);
    const s = makeSession(ctx.secret, ctx.sessionGen());
    res.setHeader('set-cookie', sessionCookie(s.value, s.maxAge, ctx.secureCookies(req)));
    ctx.log('Signed out all other sessions');
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/logout', (req, res) => {
    res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/2fa', (req, res) => {
    const tf = twoFactor();
    sendJson(res, 200, { enabled: !!tf, recovery_left: tf ? tf.recovery.length : 0 });
  });
  // Start setup: a new secret, kept pending until a code from it is confirmed.
  router.post('/api/2fa/setup', (req, res) => {
    if (twoFactor()) throw new HttpError(400, 'Two-factor sign-in is already on');
    const secret = newSecret();
    db.setSetting('totp_pending', secret);
    const uri = otpauthUri(secret);
    sendJson(res, 200, { secret, uri, qr_svg: qrSvg(uri) });
  });
  // Finish setup: a code from the app proves it has the secret. Other sessions are signed out.
  router.post('/api/2fa/enable', async (req, res) => {
    const pending = db.getSetting('totp_pending');
    if (twoFactor()) throw new HttpError(400, 'Two-factor sign-in is already on');
    if (!pending) throw new HttpError(400, 'Start the setup first');
    const { code } = await readJson(req);
    const step = checkCode(pending, code);
    if (step == null) throw new HttpError(400, 'That code is not right. Check the time on your phone, and use the newest code.');
    const { codes, hashes } = newRecoveryCodes();
    db.tx(() => {
      db.setSetting('totp_secret', pending);
      db.setSetting('totp_last_step', step);
      db.setSetting('totp_recovery', JSON.stringify(hashes));
      db.setSetting('totp_pending', null);
      db.setSetting('session_gen', ctx.sessionGen() + 1);
    });
    const s = makeSession(ctx.secret, ctx.sessionGen());
    res.setHeader('set-cookie', sessionCookie(s.value, s.maxAge, ctx.secureCookies(req)));
    ctx.log('Two-factor sign-in turned on');
    sendJson(res, 200, { ok: true, recovery_codes: codes });
  });
  // Turning it off, or making new recovery codes, needs a current code (or a recovery code to turn it off).
  router.post('/api/2fa/disable', async (req, res) => {
    if (!twoFactor()) throw new HttpError(400, 'Two-factor sign-in is off');
    const { code } = await readJson(req);
    if (!useSecondFactor(code)) throw new HttpError(400, 'That code is not right (or was already used)');
    for (const k of ['totp_secret', 'totp_last_step', 'totp_recovery', 'totp_pending']) db.setSetting(k, null);
    ctx.log('Two-factor sign-in turned off');
    sendJson(res, 200, { ok: true });
  });
  router.post('/api/2fa/recovery', async (req, res) => {
    const tf = twoFactor();
    if (!tf) throw new HttpError(400, 'Two-factor sign-in is off');
    const { code } = await readJson(req);
    const step = checkCode(tf.secret, code, tf.last);
    if (step == null) throw new HttpError(400, 'Enter a current code from your authenticator app');
    const { codes, hashes } = newRecoveryCodes();
    db.setSetting('totp_last_step', step);
    db.setSetting('totp_recovery', JSON.stringify(hashes));
    sendJson(res, 200, { ok: true, recovery_codes: codes });
  });

  router.post('/api/password', async (req, res) => {
    const { current, next } = await readJson(req);
    if (!verifyPassword(current || '', db.getSetting('admin_hash'))) throw new HttpError(400, 'Current password is wrong');
    if (str(next).length < 8) throw new HttpError(400, 'Use at least 8 characters');
    db.setSetting('admin_hash', hashPassword(next));
    db.setSetting('session_gen', ctx.sessionGen() + 1);
    const s = makeSession(ctx.secret, ctx.sessionGen());
    res.setHeader('set-cookie', sessionCookie(s.value, s.maxAge, ctx.secureCookies(req)));
    sendJson(res, 200, { ok: true });
  });

  // --- settings --------------------------------------------------------------
  router.get('/api/settings', (req, res) => {
    sendJson(res, 200, {
      base_url: db.getSetting('base_url') || '',
      detected_base_url: baseUrl(req, ''),
      version: ctx.appVersion,
      empty_event_patterns: emptyEventPatterns(db),
      empty_event_defaults: DEFAULT_EMPTY_EVENT_PATTERNS,
      guide_patterns: guidePatterns(db),
      guide_defaults: DEFAULT_GUIDE_PATTERNS,
      // "Show advanced options" (UI only) and the advanced features it reveals.
      advanced: db.getSetting('ui_advanced') === '1',
      guide_logo_fallback: db.getSetting('guide_logo_fallback') === '1',
      notify_type: db.getSetting('notify_type') || '',
      notify_url: db.getSetting('notify_url') || '',
      light_encoder: ctx.light.setting(),
      light_max: ctx.light.max(),
    });
  });

  // Partial update: only the settings present in the body change.
  router.put('/api/settings', async (req, res) => {
    const body = await readJson(req);
    if (body.base_url !== undefined) {
      const b = str(body.base_url, 500).replace(/\/+$/, '');
      if (b && !/^https?:\/\/[^/]+(\/.*)?$/i.test(b)) throw new HttpError(400, 'Base URL must start with http:// or https://');
      db.setSetting('base_url', b);
    }
    if (body.update_check !== undefined) db.setSetting('update_check', bool(body.update_check));
    if (body.advanced !== undefined) db.setSetting('ui_advanced', bool(body.advanced));
    if (body.auto_backup !== undefined) db.setSetting('auto_backup', bool(body.auto_backup));
    if (body.notify_type !== undefined || body.notify_url !== undefined) {
      const type = body.notify_type === undefined ? db.getSetting('notify_type') || '' : String(body.notify_type || '');
      const url = body.notify_url === undefined ? db.getSetting('notify_url') || '' : str(body.notify_url, 1000);
      if (!['', 'ntfy', 'webhook'].includes(type)) throw new HttpError(400, 'Unknown notification type');
      if (type && !/^https?:\/\/\S+$/i.test(url)) throw new HttpError(400, 'Enter the full http(s):// address to send alerts to');
      db.setSetting('notify_type', type);
      db.setSetting('notify_url', url);
    }
    if (body.guide_logo_fallback !== undefined) db.setSetting('guide_logo_fallback', bool(body.guide_logo_fallback));
    if (body.light_encoder !== undefined) {
      if (!ENCODERS.includes(body.light_encoder)) throw new HttpError(400, 'Unknown encoder');
      db.setSetting('light_encoder', body.light_encoder);
      ctx.light.reset();
    }
    if (body.light_max !== undefined) db.setSetting('light_max', int(body.light_max, DEFAULT_LIGHT_MAX, 1, 16));
    if (body.empty_event_patterns !== undefined) {
      // null restores the defaults; a list (possibly empty) replaces them.
      db.setSetting('empty_event_patterns', body.empty_event_patterns === null ? null : JSON.stringify(validatePatterns(body.empty_event_patterns)));
    }
    touch();
    if (body.guide_patterns !== undefined) {
      db.setSetting('guide_patterns', body.guide_patterns === null ? null : JSON.stringify(validatePatterns(body.guide_patterns)));
    }
    sendJson(res, 200, { ok: true, empty_event_patterns: emptyEventPatterns(db), guide_patterns: guidePatterns(db) });
  });

  // --- light streams ----------------------------------------------------------
  // ffmpeg found or not, the encoder in use, and the light copies being made now.
  router.get('/api/light', async (req, res) => sendJson(res, 200, await ctx.light.status()));
  // A few seconds' test encode with the chosen encoder (or the one "auto" would pick).
  router.post('/api/light/test', async (req, res) => {
    const body = await readJson(req);
    ctx.light.reset();
    if (!(await ctx.light.ffmpeg())) return sendJson(res, 200, { ok: false, error: 'ffmpeg is not installed on this server' });
    const encoder = ENCODERS.includes(body.encoder) && body.encoder !== 'auto' ? body.encoder : await ctx.light.encoder();
    sendJson(res, 200, await ctx.light.test(encoder));
  });

  // --- alerts ------------------------------------------------------------------
  router.get('/api/alerts', (req, res) => sendJson(res, 200, computeAlerts(db)));
  // Who is watching what right now (see viewers.js for what each stream mode lets us see).
  // Each live stream also gets what its guide says is on now.
  router.get('/api/viewers', (req, res) => {
    const list = ctx.viewers.list();
    const ids = [...new Set(list.filter((v) => v.epg_id && v.source_id).map((v) => v.source_id))];
    const onNow = ids.length
      ? nowTitles(db, db.all(`SELECT id, epg_gen FROM sources WHERE id IN (${ids.map(() => '?').join(',')})`, ids))
      : new Map();
    sendJson(res, 200, list.map(({ source_id: sid, epg_id: epg, ...v }) => ({ ...v, program: epg ? onNow.get(`${sid}|${epg}`) || null : null })));
  });

  // --- Watch page: an output's channels, and playing one in the browser.
  // The format a browser player should ask for: HLS where the provider gives HLS, else MPEG-TS.
  const watchFormat = (sel, ch) => {
    if (ch.source_type === 'xc') return sel.output.sources.find((s) => s.id === ch.source_id)?.xc_stream_ext === 'm3u8' ? 'm3u8' : 'ts';
    return /\.m3u8(\?|$)/i.test(ch.url) ? 'm3u8' : 'ts';
  };
  router.get('/api/outputs/:id/lineup', (req, res, { params }) => {
    const sel = ctx.selection(Number(params.id));
    if (!sel) throw new HttpError(404, 'Not found');
    const onNow = nowTitles(db, sel.output.sources);
    sendJson(res, 200, {
      paused: !!sel.output.paused,
      // A channel's stream for player apps (VLC and the like) is this plus "<id>.ts": the output's
      // own stream link, following its stream mode.
      stream_base: `${baseUrl(req, db.getSetting('base_url'))}/s/${sel.output.token}/`,
      channels: sel.channels.map((ch) => ({
        id: ch.id, name: ch.name, logo: ch.logo, group: ch.group, chno: ch.chno, source_type: ch.source_type,
        format: watchFormat(sel, ch),
        // Xtream Codes accounts serve both; Safari plays HLS by itself.
        hls_available: ch.source_type === 'xc' || watchFormat(sel, ch) === 'm3u8',
        now: ch.epg_id ? onNow.get(`${ch.source_id}|${ch.epg_id}`) || null : null,
        // As last seen in its stream ({ video, audio, convert }), null until it has played.
        codecs: ctx.streams.codecs.get(ch.id) || null,
      })),
    });
  });
  router.get('/api/outputs/:id/watch/:chId', (req, res, { params, query }) => {
    const sel = ctx.selection(Number(params.id));
    const ch = sel?.byId.get(Number(params.chId));
    if (!ch) throw new HttpError(404, 'Channel is not in this output');
    const ext = ['ts', 'm3u8'].includes(query.get('format')) ? query.get('format') : watchFormat(sel, ch);
    const viewer = {
      outputId: sel.output.id, output: sel.output.name, who: 'Web player', username: null, ip: clientIp(req),
      what: ch.name, kind: 'live', source: sel.output.sources.find((s) => s.id === ch.source_id)?.name || null,
      sourceId: ch.source_id, epgId: ch.epg_id,
    };
    // ?convert=1: a copy the browser can play (H.264 and AAC), made by ffmpeg, for channels in
    // MPEG-2 video or Dolby (AC-3) sound.
    if (query.get('convert') === '1') return serveLight(ctx, res, ch, viewer, { profile: 'browser' });
    return serveWatch(ctx, res, sel.output, ch, ext, viewer);
  });
  router.post('/api/alerts/test', async (req, res) => {
    const { type, url } = ctx.alerts.target;
    if (!type || !url) throw new HttpError(400, 'Save a notification address first');
    try {
      await ctx.alerts.send('alert', {
        kind: 'test', level: 'warn', title: 'Simple IPTV Manager test alert', message: 'Alerts from Simple IPTV Manager will arrive here.',
      });
    } catch (e) {
      throw new HttpError(502, `Sending failed: ${e.message}`);
    }
    sendJson(res, 200, { ok: true });
  });

  // --- version & updates -----------------------------------------------------
  const updateView = () => ({
    version: ctx.build.version,
    commit: ctx.build.commit,
    commit_source: ctx.build.commitSource,
    install_type: ctx.build.installType,
    repo: ctx.build.repo,
    enabled: ctx.updates.enabled,
    ...ctx.updates.state(),
    web_update: ctx.webUpdate.view(),
  });
  router.get('/api/updates', (req, res) => sendJson(res, 200, updateView()));

  // --- Dashboard widget (Homepage's Custom API widget and the like): read-only numbers, with an
  // API key of its own (header X-API-Key, or ?key=). Off until a key is made in Settings.
  const widgetKeyOk = (req, query) => {
    const key = db.getSetting('widget_key');
    const given = String(req.headers['x-api-key'] || query.get('key') || '');
    return !!key && given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
  };
  router.get('/api/widget', (req, res, { query }) => {
    if (!db.getSetting('widget_key')) throw new HttpError(404, 'The widget API is off; turn it on in Settings');
    if (!widgetKeyOk(req, query)) throw new HttpError(401, 'Wrong or missing API key');
    const sources = db.all('SELECT id, enabled, last_status FROM sources');
    const count = (sql) => db.get(sql).n;
    const viewers = ctx.viewers.list();
    const watching = viewers.filter((v) => v.mode === 'proxy');
    const upd = ctx.updates.state();
    sendJson(res, 200, {
      watching: watching.length,
      recently_started: viewers.length - watching.length,
      // For Homepage's "dynamic-list" view: who on the left, what on the right.
      watching_list: watching.map((v) => ({ name: v.who, label: v.transcode ? `${v.what} (transcoding)` : v.what, output: v.output })),
      transcoding: watching.filter((v) => v.transcode).length,
      sources: sources.length,
      sources_ok: sources.filter((s) => s.enabled && s.last_status === 'ok').length,
      sources_warning: sources.filter((s) => s.enabled && s.last_status === 'warning').length,
      sources_error: sources.filter((s) => s.enabled && s.last_status === 'error').length,
      channels: count('SELECT COUNT(*) AS n FROM channels WHERE active = 1'),
      movies: count("SELECT COUNT(*) AS n FROM vod_items WHERE active = 1 AND kind = 'movie'"),
      series: count("SELECT COUNT(*) AS n FROM vod_items WHERE active = 1 AND kind = 'series'"),
      outputs: count('SELECT COUNT(*) AS n FROM outputs'),
      outputs_paused: count('SELECT COUNT(*) AS n FROM outputs WHERE paused = 1'),
      alerts: computeAlerts(db).length,
      update_available: (upd.behind || 0) > 0,
      version: ctx.build.version,
      commit: ctx.build.commit ? ctx.build.commit.slice(0, 7) : null,
    });
  });
  router.get('/api/widget-key', (req, res) => sendJson(res, 200, { key: db.getSetting('widget_key') || null }));
  // Make (or replace) the key; replacing one stops dashboards using the old key.
  router.post('/api/widget-key', (req, res) => {
    db.setSetting('widget_key', randomToken(24));
    sendJson(res, 200, { key: db.getSetting('widget_key') });
  });
  router.delete('/api/widget-key', (req, res) => {
    db.setSetting('widget_key', null);
    sendJson(res, 200, { key: null });
  });
  router.post('/api/updates/check', async (req, res) => {
    await ctx.updates.check();
    sendJson(res, 200, updateView());
  });
  // Ask the root updater (via its systemd path unit) to update now; see src/webupdate.js.
  router.post('/api/updates/apply', (req, res) => {
    if (!ctx.webUpdate.available) {
      throw new HttpError(409, 'Updating from the web is not set up on this install');
    }
    if (!ctx.webUpdate.request({ action: 'update' })) throw new HttpError(409, 'An update is already in progress');
    ctx.log('Update requested from the web interface');
    sendJson(res, 202, updateView());
  });
  // Turn nightly updates on (at HH:MM) or off; carried out by the root updater like Update now.
  router.post('/api/updates/auto', async (req, res) => {
    if (!ctx.webUpdate.available) throw new HttpError(409, 'Updating from the web is not set up on this install');
    const body = await readJson(req);
    const at = str(body.at || '04:00', 5);
    if (body.enabled && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new HttpError(400, 'Time must be HH:MM (24-hour)');
    const ok = ctx.webUpdate.request(body.enabled ? { action: 'enable-auto', at } : { action: 'disable-auto' });
    if (!ok) throw new HttpError(409, 'An update is in progress; try again when it finishes');
    sendJson(res, 202, updateView());
  });

  // --- backup ----------------------------------------------------------------
  router.get('/api/export', (req, res, { query }) => {
    const secrets = query.get('secrets') !== '0';
    const data = exportSettings(db, { secrets, appVersion: ctx.appVersion });
    const body = JSON.stringify(data, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="iptv-manager-settings-${stamp}.json"`,
      'cache-control': 'no-store',
    });
    res.end(body);
  });

  const applyImport = (data, label) => {
    // A refresh writing into a source the import is about to delete would fail half-way.
    if (ctx.jobs.running || ctx.jobs.queue.length) throw new HttpError(409, 'A source refresh is running; try again when it finishes');
    const result = importSettings(db, data);
    ctx.bump();
    for (const id of result.sourceIds) ctx.jobs.enqueue(id);
    ctx.log(`${label}: ${result.sources} sources, ${result.outputs} outputs`);
    return { ok: true, sources: result.sources, outputs: result.outputs };
  };

  router.post('/api/import', async (req, res) => {
    sendJson(res, 200, applyImport(await readJson(req, IMPORT_LIMIT), 'Imported settings'));
  });

  // --- automatic backups -------------------------------------------------------
  router.get('/api/backups', (req, res) => {
    sendJson(res, 200, { enabled: ctx.autoBackup.enabled, keep: AUTO_BACKUP_KEEP, files: ctx.autoBackup.list() });
  });
  router.post('/api/backups', (req, res) => {
    const name = ctx.autoBackup.run();
    sendJson(res, 200, { ok: true, name, files: ctx.autoBackup.list() });
  });
  router.get('/api/backups/:name', (req, res, { params }) => {
    const file = ctx.autoBackup.file(params.name);
    if (!file) throw new HttpError(404, 'No such backup');
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="iptv-manager-${params.name}"`,
      'cache-control': 'no-store',
    });
    res.end(body);
  });
  router.post('/api/backups/:name/restore', (req, res, { params }) => {
    const file = ctx.autoBackup.file(params.name);
    if (!file) throw new HttpError(404, 'No such backup');
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new HttpError(400, 'That backup file is damaged');
    }
    sendJson(res, 200, applyImport(data, `Restored ${params.name}`));
  });

  // --- sources ---------------------------------------------------------------
  router.get('/api/sources', (req, res) => {
    sendJson(res, 200, db.all('SELECT * FROM sources ORDER BY sort, id').map((s) => sourceView(ctx, s)));
  });

  router.get('/api/sources/:id', (req, res, { params }) => {
    const s = mustGet(db, 'sources', params.id);
    sendJson(res, 200, sourceView(ctx, s));
  });

  router.post('/api/sources', async (req, res) => {
    const f = sourceFields(await readJson(req));
    const r = db.get(
      `INSERT INTO sources (name, type, url, epg_urls, xc_host, xc_username, xc_password, xc_stream_ext, hdhr_host, user_agent,
                            live_only, refresh_minutes, enabled, max_streams, vod_refresh_minutes, sort, created_at)
       VALUES ($name, $type, $url, $epg_urls, $xc_host, $xc_username, $xc_password, $xc_stream_ext, $hdhr_host, $user_agent,
               $live_only, $refresh_minutes, $enabled, $max_streams, $vod_refresh_minutes, (SELECT COALESCE(MAX(sort), 0) + 1 FROM sources), $created_at)
       RETURNING id`,
      { ...f, created_at: now() },
    );
    // An M3U source without a URL waits for its playlist upload before the first refresh.
    if (f.enabled && (f.type !== 'm3u' || f.url)) ctx.jobs.enqueue(r.id);
    sendJson(res, 201, sourceView(ctx, mustGet(db, 'sources', r.id)));
  });

  router.put('/api/sources/:id', async (req, res, { params }) => {
    const existing = mustGet(db, 'sources', params.id);
    const f = sourceFields(await readJson(req), existing);
    db.run(
      `UPDATE sources SET name = $name, url = $url, epg_urls = $epg_urls, xc_host = $xc_host, xc_username = $xc_username,
         xc_password = $xc_password, xc_stream_ext = $xc_stream_ext, hdhr_host = $hdhr_host, user_agent = $user_agent, live_only = $live_only,
         refresh_minutes = $refresh_minutes, enabled = $enabled, max_streams = $max_streams,
         vod_refresh_minutes = $vod_refresh_minutes WHERE id = $id`,
      { ...f, id: existing.id },
    );
    const refetch = ['url', 'epg_urls', 'xc_host', 'xc_username', 'xc_password', 'xc_stream_ext', 'hdhr_host', 'user_agent', 'live_only']
      .some((k) => String(existing[k] ?? '') !== String(f[k] ?? ''));
    if (refetch && f.enabled) ctx.jobs.enqueue(existing.id, { forceVod: true });
    touch();
    sendJson(res, 200, sourceView(ctx, mustGet(db, 'sources', existing.id)));
  });

  router.delete('/api/sources/:id', (req, res, { params }) => {
    const s = mustGet(db, 'sources', params.id);
    db.run('DELETE FROM sources WHERE id = ?', [s.id]);
    const dir = path.join(ctx.dataDir, 'uploads');
    for (const kind of ['m3u', 'epg']) fs.rm(path.join(dir, `source-${s.id}-${kind}`), { force: true }, () => {});
    touch();
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/sources/:id/refresh', (req, res, { params }) => {
    const s = mustGet(db, 'sources', params.id);
    ctx.jobs.enqueue(s.id, { forceVod: true });
    sendJson(res, 202, { job: ctx.jobs.status(s.id) });
  });

  // Raw file upload (M3U or XMLTV, optionally gzipped); the source then reads it on every refresh.
  router.post('/api/sources/:id/upload', async (req, res, { params, query }) => {
    const s = mustGet(db, 'sources', params.id);
    const kind = query.get('kind') === 'epg' ? 'epg' : 'm3u';
    if (kind === 'm3u' && s.type !== 'm3u') throw new HttpError(400, 'Playlist upload is only for M3U sources');
    const dir = path.join(ctx.dataDir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const name = `source-${s.id}-${kind}`;
    const tmp = path.join(dir, `${name}.part`);
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > UPLOAD_LIMIT) req.destroy(new Error('Upload too large'));
    });
    await pipeline(req, fs.createWriteStream(tmp));
    if (!size) {
      fs.rmSync(tmp, { force: true });
      throw new HttpError(400, 'Empty upload');
    }
    fs.renameSync(tmp, path.join(dir, name));
    const ref = `upload:${name}`;
    if (kind === 'm3u') db.run('UPDATE sources SET url = ? WHERE id = ?', [ref, s.id]);
    else if (!s.epg_urls.split(/\r?\n/).includes(ref)) {
      db.run('UPDATE sources SET epg_urls = ? WHERE id = ?', [[s.epg_urls.trim(), ref].filter(Boolean).join('\n'), s.id]);
    }
    ctx.jobs.enqueue(s.id);
    sendJson(res, 200, { ok: true, size });
  });

  router.get('/api/sources/:id/categories', (req, res, { params }) => {
    const s = mustGet(db, 'sources', params.id);
    const rows = db.all(
      `SELECT c.id, c.name, c.custom_name, c.jellyfin, c.first_seen, c.added_in,
              (SELECT COUNT(*) FROM channels ch WHERE ch.category_id = c.id AND ch.active = 1) AS channel_count
         FROM categories c WHERE c.source_id = ? AND c.active = 1 AND c.kind = 'live' ORDER BY c.sort`,
      [s.id],
    );
    for (const r of rows) {
      r.is_new = isNewCategory(r);
      r.jellyfin = parseJellyfin(r.jellyfin);
    }
    sendJson(res, 200, rows);
  });

  // Partial update: only the fields present in the body change.
  router.put('/api/categories/:id', async (req, res, { params }) => {
    const c = mustGet(db, 'categories', params.id);
    const body = await readJson(req);
    const customName = body.custom_name === undefined ? c.custom_name : optStr(body.custom_name, 200);
    let jellyfin = c.jellyfin;
    if (body.jellyfin !== undefined) {
      const list = Array.isArray(body.jellyfin) ? body.jellyfin : [];
      const unknown = list.filter((v) => !JELLYFIN_CATEGORIES.some((j) => j.toLowerCase() === String(v).toLowerCase()));
      if (unknown.length) throw new HttpError(400, `Unknown Jellyfin category: ${unknown.join(', ')}`);
      jellyfin = parseJellyfin(list.join(',')).join(',') || null;
    }
    db.run('UPDATE categories SET custom_name = ?, jellyfin = ? WHERE id = ?', [customName, jellyfin, c.id]);
    touch();
    sendJson(res, 200, { ok: true, custom_name: customName, jellyfin: parseJellyfin(jellyfin) });
  });

  router.get('/api/sources/:id/channels', (req, res, { params, query }) => {
    const s = mustGet(db, 'sources', params.id);
    const where = ['ch.source_id = ?', 'ch.active = 1'];
    const args = [s.id];
    if (query.get('category_id')) {
      where.push('ch.category_id = ?');
      args.push(Number(query.get('category_id')));
    }
    const q = str(query.get('q'), 200);
    if (q) {
      where.push('(ch.name LIKE ? OR ch.custom_name LIKE ? OR ch.tvg_id LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (query.get('epg') === 'unmatched') where.push('ch.epg_id IS NULL');
    if (query.get('epg') === 'matched') where.push('ch.epg_id IS NOT NULL');
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM channels ch WHERE ${w}`, args).n;
    const limit = int(query.get('limit'), 200, 1, 1000);
    const offset = int(query.get('offset'), 0, 0);
    const items = db.all(
      `SELECT ch.id, ch.name, ch.tvg_id, ch.tvg_name, ch.logo, ch.chno, ch.epg_id, ch.epg_match,
              ch.custom_name, ch.custom_logo, ch.custom_epg_id, ch.custom_chno, ch.category_id,
              c.name AS category
         FROM channels ch LEFT JOIN categories c ON c.id = ch.category_id
        WHERE ${w} ORDER BY c.sort, ch.sort LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    sendJson(res, 200, { total, items });
  });

  router.get('/api/sources/:id/epg-channels', (req, res, { params, query }) => {
    const s = mustGet(db, 'sources', params.id);
    const q = str(query.get('q'), 200);
    const rows = db.all(
      `SELECT xml_id AS id, names, icon FROM epg_channels
        WHERE source_id = ? AND gen = ? AND (? = '' OR xml_id LIKE ? OR names LIKE ?)
        ORDER BY xml_id LIMIT 50`,
      [s.id, s.epg_gen, q, `%${q}%`, `%${q}%`],
    );
    sendJson(res, 200, rows.map((r) => ({ ...r, names: parseJson(r.names) || [] })));
  });

  router.put('/api/channels/:id', async (req, res, { params }) => {
    const ch = mustGet(db, 'channels', params.id);
    const body = await readJson(req);
    const f = {
      custom_name: optStr(body.custom_name, 300),
      custom_logo: optStr(body.custom_logo, 2000),
      custom_epg_id: optStr(body.custom_epg_id, 300),
      custom_chno: optStr(body.custom_chno, 20),
    };
    db.run(
      `UPDATE channels SET custom_name = $custom_name, custom_logo = $custom_logo, custom_epg_id = $custom_epg_id,
         custom_chno = $custom_chno WHERE id = $id`,
      { ...f, id: ch.id },
    );
    // Guide data is only stored for matched channels, so a new manual EPG id needs a fresh pull.
    if ((ch.custom_epg_id || null) !== f.custom_epg_id) {
      const known = f.custom_epg_id && db.get(
        'SELECT 1 FROM programmes p JOIN sources s ON s.id = p.source_id AND s.epg_gen = p.gen WHERE p.source_id = ? AND p.channel = ? LIMIT 1',
        [ch.source_id, f.custom_epg_id],
      );
      rematchSource(db, ch.source_id);
      if (f.custom_epg_id && !known) ctx.jobs.enqueue(ch.source_id);
    } else if ((ch.custom_name || null) !== f.custom_name) {
      rematchSource(db, ch.source_id);
    }
    touch();
    sendJson(res, 200, db.get('SELECT * FROM channels WHERE id = ?', [ch.id]));
  });

  // --- outputs ---------------------------------------------------------------
  router.get('/api/outputs', (req, res) => {
    sendJson(res, 200, db.all('SELECT * FROM outputs ORDER BY id').map((o) => outputView(req, ctx, o)));
  });

  router.post('/api/outputs', async (req, res) => {
    const body = await readJson(req);
    const t = now();
    const id = db.tx(() => {
      const r = db.get(
        'INSERT INTO outputs (name, token, stream_mode, epg_days, created_at, updated_at) VALUES (?, ?, ?, 7, ?, ?) RETURNING id',
        [str(body.name, 200) || 'New output', randomToken(), 'direct', t, t],
      );
      db.all('SELECT id FROM sources ORDER BY sort, id').forEach((s, i) => {
        db.run('INSERT INTO output_sources (output_id, source_id, sort) VALUES (?, ?, ?)', [r.id, s.id, i]);
      });
      return r.id;
    });
    touch();
    sendJson(res, 201, outputView(req, ctx, mustGet(db, 'outputs', id), true));
  });

  router.get('/api/outputs/:id', (req, res, { params }) => {
    sendJson(res, 200, outputView(req, ctx, mustGet(db, 'outputs', params.id), true));
  });

  router.put('/api/outputs/:id', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const body = await readJson(req);
    const xcEnabled = body.xc_enabled === undefined ? o.xc_enabled : bool(body.xc_enabled);
    const xcUser = body.xc_username === undefined ? o.xc_username : optStr(body.xc_username, 100);
    const xcPass = body.xc_password === undefined ? o.xc_password : optStr(body.xc_password, 100);
    if (xcEnabled && (!xcUser || !xcPass)) throw new HttpError(400, 'The Xtream Codes output needs a username and password');
    if (xcUser && /[/?#\s]/.test(xcUser)) throw new HttpError(400, 'The Xtream Codes username cannot contain spaces, "/", "?" or "#"');
    if (xcPass && /[/?#\s]/.test(xcPass)) throw new HttpError(400, 'The Xtream Codes password cannot contain spaces, "/", "?" or "#"');
    if (xcUser && (db.get('SELECT 1 FROM outputs WHERE xc_username = ? AND id <> ?', [xcUser, o.id])
      || db.get('SELECT 1 FROM output_xc_logins WHERE username = ?', [xcUser]))) {
      throw new HttpError(400, 'Another output already uses that Xtream Codes username');
    }
    const mode = body.stream_mode === undefined ? o.stream_mode : body.stream_mode;
    if (!['direct', 'redirect', 'proxy'].includes(mode)) throw new HttpError(400, 'Unknown stream mode');

    const rules = Array.isArray(body.rules) ? validateRules(body.rules) : null;
    const nameRules = body.name_rules === undefined ? null : checkNameRules(body.name_rules);
    if (nameRules?.error) throw new HttpError(400, nameRules.error);

    db.tx(() => {
      db.run(
        `UPDATE outputs SET name = ?, stream_mode = ?, include_all = ?, number_start = ?, epg_days = ?,
           xc_enabled = ?, xc_username = ?, xc_password = ?, vod_enabled = ?, updated_at = ? WHERE id = ?`,
        [
          body.name === undefined ? o.name : str(body.name, 200) || o.name,
          mode,
          body.include_all === undefined ? o.include_all : bool(body.include_all),
          body.number_start === undefined ? o.number_start : (body.number_start === '' || body.number_start == null ? null : int(body.number_start, null, 0, 1e6)),
          body.epg_days === undefined ? o.epg_days : int(body.epg_days, 7, 1, 14),
          xcEnabled, xcUser, xcPass, body.vod_enabled === undefined ? o.vod_enabled : bool(body.vod_enabled), now(), o.id,
        ],
      );
      if (nameRules) db.run('UPDATE outputs SET name_rules = ? WHERE id = ?', [JSON.stringify(nameRules.rules), o.id]);
      if (body.light_enabled !== undefined) db.run('UPDATE outputs SET light_enabled = ? WHERE id = ?', [bool(body.light_enabled), o.id]);
      if (body.convert_mode !== undefined) {
        if (!CONVERT_MODES.includes(body.convert_mode)) throw new HttpError(400, 'Unknown conversion setting');
        db.run('UPDATE outputs SET convert_mode = ? WHERE id = ?', [body.convert_mode, o.id]);
      }
      for (const kind of ['movie', 'series']) {
        const key = `include_all_${kind}`;
        if (body[key] !== undefined) db.run(`UPDATE outputs SET ${key} = ? WHERE id = ?`, [bool(body[key]), o.id]);
      }
      if (Array.isArray(body.source_ids)) {
        // Category prefixes and suffixes: as sent (source_affixes, keyed by source id), else kept.
        const sent = body.source_affixes && typeof body.source_affixes === 'object' ? body.source_affixes : {};
        const kept = new Map(db.all('SELECT source_id, cat_prefix, cat_suffix FROM output_sources WHERE output_id = ?', [o.id])
          .map((r) => [r.source_id, r]));
        db.run('DELETE FROM output_sources WHERE output_id = ?', [o.id]);
        body.source_ids.forEach((sid, i) => {
          sid = Number(sid);
          if (db.get('SELECT 1 FROM sources WHERE id = ?', [sid])) {
            const a = sent[sid] || kept.get(sid) || {};
            db.run('INSERT OR IGNORE INTO output_sources (output_id, source_id, sort, cat_prefix, cat_suffix) VALUES (?, ?, ?, ?, ?)',
              [o.id, sid, i, affixText(a.cat_prefix), affixText(a.cat_suffix)]);
          }
        });
      }
      if (rules) {
        db.run('DELETE FROM output_rules WHERE output_id = ?', [o.id]);
        rules.forEach((r, i) => {
          if (r.source_id && !db.get('SELECT 1 FROM sources WHERE id = ?', [r.source_id])) r.source_id = null;
          db.run('INSERT INTO output_rules (output_id, source_id, kind, action, op, value, sort) VALUES (?, ?, ?, ?, ?, ?, ?)', [
            o.id, r.source_id, r.kind, r.action, r.op, r.value, i,
          ]);
        });
      }
    });
    touch();
    sendJson(res, 200, outputView(req, ctx, mustGet(db, 'outputs', o.id), true));
  });

  router.delete('/api/outputs/:id', (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    db.run('DELETE FROM outputs WHERE id = ?', [o.id]);
    ctx.epgCache.drop(o.id);
    touch();
    sendJson(res, 200, { ok: true });
  });

  // A copy of an output with everything in it: sources, rules of every kind, hand picks, channel
  // rules, per-category switches and name cleanup. It gets its own URLs; its Xtream Codes login
  // starts off, since a username can only belong to one output.
  router.post('/api/outputs/:id/clone', (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const t = now();
    const id = db.tx(() => {
      const copyId = db.get(
        `INSERT INTO outputs (name, token, stream_mode, include_all, include_all_movie, include_all_series, number_start, epg_days,
                              xc_enabled, xc_username, xc_password, name_rules, vod_enabled, light_enabled, convert_mode, cat_sort, ch_sort, paused, created_at, updated_at)
         SELECT ?, ?, stream_mode, include_all, include_all_movie, include_all_series, number_start, epg_days,
                0, NULL, NULL, name_rules, vod_enabled, light_enabled, convert_mode, cat_sort, ch_sort, paused, ?, ?
           FROM outputs WHERE id = ? RETURNING id`,
        [`${o.name} (copy)`.slice(0, 200), randomToken(), t, t, o.id],
      ).id;
      db.run(`INSERT INTO output_sources (output_id, source_id, sort, cat_prefix, cat_suffix)
              SELECT ?, source_id, sort, cat_prefix, cat_suffix FROM output_sources WHERE output_id = ?`, [copyId, o.id]);
      db.run(`INSERT INTO output_rules (output_id, source_id, kind, action, op, value, sort)
              SELECT ?, source_id, kind, action, op, value, sort FROM output_rules WHERE output_id = ? ORDER BY sort, id`, [copyId, o.id]);
      db.run(`INSERT INTO output_channel_rules (output_id, category_id, action, op, value, sort)
              SELECT ?, category_id, action, op, value, sort FROM output_channel_rules WHERE output_id = ? ORDER BY sort, id`, [copyId, o.id]);
      db.run('INSERT INTO output_category_overrides (output_id, category_id, state) SELECT ?, category_id, state FROM output_category_overrides WHERE output_id = ?', [copyId, o.id]);
      db.run('INSERT INTO output_channel_overrides (output_id, channel_id, state) SELECT ?, channel_id, state FROM output_channel_overrides WHERE output_id = ?', [copyId, o.id]);
      db.run('INSERT INTO output_vod_overrides (output_id, item_id, state) SELECT ?, item_id, state FROM output_vod_overrides WHERE output_id = ?', [copyId, o.id]);
      db.run(`INSERT INTO output_category_settings (output_id, category_id, hide_empty, hide_by_guide, hide_unlisted, unlisted_hours, ch_sort)
              SELECT ?, category_id, hide_empty, hide_by_guide, hide_unlisted, unlisted_hours, ch_sort FROM output_category_settings WHERE output_id = ?`, [copyId, o.id]);
      db.run('INSERT INTO output_category_order (output_id, category_id, position) SELECT ?, category_id, position FROM output_category_order WHERE output_id = ?', [copyId, o.id]);
      db.run('INSERT INTO output_channel_order (output_id, channel_id, position) SELECT ?, channel_id, position FROM output_channel_order WHERE output_id = ?', [copyId, o.id]);
      return copyId;
    });
    touch();
    sendJson(res, 201, outputView(req, ctx, mustGet(db, 'outputs', id), true));
  });

  // --- extra Xtream Codes logins of an output (sharing it; each one removable on its own)
  const checkLogin = (username, password, exceptLogin = 0) => {
    if (!username || !password) throw new HttpError(400, 'A login needs a username and a password');
    if (/[/?#\s]/.test(username) || /[/?#\s]/.test(password)) throw new HttpError(400, 'Usernames and passwords cannot contain spaces, "/", "?" or "#"');
    if (db.get('SELECT 1 FROM outputs WHERE xc_username = ?', [username])
      || db.get('SELECT 1 FROM output_xc_logins WHERE username = ? AND id <> ?', [username, exceptLogin])) {
      throw new HttpError(400, `The username "${username}" is already in use`);
    }
  };
  const loginOf = (outputId, loginId) => {
    const l = db.get('SELECT * FROM output_xc_logins WHERE id = ? AND output_id = ?', [Number(loginId), Number(outputId)]);
    if (!l) throw new HttpError(404, 'Not found');
    return l;
  };
  router.post('/api/outputs/:id/logins', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const body = await readJson(req);
    const username = str(body.username, 100);
    const password = str(body.password, 100);
    checkLogin(username, password);
    const l = db.get(
      'INSERT INTO output_xc_logins (output_id, name, username, password, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?) RETURNING *',
      [o.id, str(body.name, 100), username, password, now()],
    );
    sendJson(res, 201, { ...l, enabled: true });
  });
  router.put('/api/outputs/:id/logins/:loginId', async (req, res, { params }) => {
    const l = loginOf(params.id, params.loginId);
    const body = await readJson(req);
    const username = body.username === undefined ? l.username : str(body.username, 100);
    const password = body.password === undefined ? l.password : str(body.password, 100);
    checkLogin(username, password, l.id);
    db.run('UPDATE output_xc_logins SET name = ?, username = ?, password = ?, enabled = ? WHERE id = ?', [
      body.name === undefined ? l.name : str(body.name, 100), username, password,
      body.enabled === undefined ? l.enabled : bool(body.enabled), l.id,
    ]);
    const r = db.get('SELECT * FROM output_xc_logins WHERE id = ?', [l.id]);
    sendJson(res, 200, { ...r, enabled: !!r.enabled });
  });
  router.delete('/api/outputs/:id/logins/:loginId', (req, res, { params }) => {
    const l = loginOf(params.id, params.loginId);
    db.run('DELETE FROM output_xc_logins WHERE id = ?', [l.id]);
    sendJson(res, 200, { ok: true });
  });

  // Pause (or resume) an output: its URLs and every login stop answering; nothing is deleted.
  router.post('/api/outputs/:id/pause', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const { paused } = await readJson(req);
    db.run('UPDATE outputs SET paused = ?, updated_at = ? WHERE id = ?', [bool(paused), now(), o.id]);
    touch();
    sendJson(res, 200, outputView(req, ctx, mustGet(db, 'outputs', o.id), true));
  });

  // Refresh every source this output uses (movies and series included).
  router.post('/api/outputs/:id/refresh', (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const ids = db.all(
      'SELECT s.id FROM output_sources os JOIN sources s ON s.id = os.source_id WHERE os.output_id = ? AND s.enabled = 1 ORDER BY os.sort',
      [o.id],
    ).map((r) => r.id);
    for (const sid of ids) ctx.jobs.enqueue(sid, { forceVod: true });
    sendJson(res, 202, { sources: ids.length });
  });

  router.post('/api/outputs/:id/token', (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    db.run('UPDATE outputs SET token = ?, updated_at = ? WHERE id = ?', [randomToken(), now(), o.id]);
    touch();
    sendJson(res, 200, outputView(req, ctx, mustGet(db, 'outputs', o.id), true));
  });

  router.get('/api/outputs/:id/categories', (req, res, { params, query }) => {
    const o = loadOutput(db, Number(params.id));
    if (!o) throw new HttpError(404, 'Not found');
    const kind = ['movie', 'series'].includes(query.get('kind')) ? query.get('kind') : 'live';
    const clean = cleanerFor(o, kind);
    sendJson(res, 200, evaluateCategories(db, o, kind).map((c) => ({ ...c, clean_name: clean.category(c.name) })));
  });

  // The titles of one movie or series category in an output, each with its hand pick (if any)
  // and whether it is in: a title is in when its category is and it isn't picked out by hand.
  router.get('/api/outputs/:id/titles', (req, res, { params, query }) => {
    const o = loadOutput(db, Number(params.id));
    if (!o) throw new HttpError(404, 'Not found');
    const c = mustGet(db, 'categories', query.get('category_id'));
    if (c.kind === 'live') throw new HttpError(400, 'Not a movie or series category');
    const cat = evaluateCategories(db, o, c.kind).find((x) => x.id === c.id);
    if (!cat) throw new HttpError(404, 'Category is not part of this output');
    const LIMIT = 5000;
    const clean = cleanerFor(o, c.kind);
    const rows = db.all(
      `SELECT v.id, v.name, v.custom_name, x.state AS override FROM vod_items v
         LEFT JOIN output_vod_overrides x ON x.item_id = v.id AND x.output_id = ?
        WHERE v.category_id = ? AND v.active = 1 ORDER BY v.sort LIMIT ?`,
      [o.id, c.id, LIMIT + 1],
    );
    sendJson(res, 200, {
      category_included: cat.included,
      total: cat.channel_count,
      truncated: rows.length > LIMIT,
      titles: rows.slice(0, LIMIT).map((r) => ({ ...r, clean_name: clean.channel(r.name), included: cat.included && r.override !== 'exclude' })),
    });
  });

  // Pick titles in or out by hand (state null clears the pick): by ids, or a whole category.
  router.put('/api/outputs/:id/titles', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const { ids, category_id: categoryId, state } = await readJson(req);
    if (state != null && !['include', 'exclude'].includes(state)) throw new HttpError(400, 'state must be include, exclude or null');
    let list;
    if (categoryId != null) list = db.all('SELECT id FROM vod_items WHERE category_id = ? AND active = 1', [Number(categoryId)]).map((r) => r.id);
    else if (Array.isArray(ids)) list = ids.map(Number);
    else throw new HttpError(400, 'Give ids or a category_id');
    db.tx(() => {
      for (const id of list) {
        if (state) {
          db.run(
            `INSERT INTO output_vod_overrides (output_id, item_id, state) SELECT ?, id, ? FROM vod_items WHERE id = ?
             ON CONFLICT (output_id, item_id) DO UPDATE SET state = excluded.state`,
            [o.id, state, id],
          );
        } else {
          db.run('DELETE FROM output_vod_overrides WHERE output_id = ? AND item_id = ?', [o.id, id]);
        }
      }
    });
    touch();
    sendJson(res, 200, { ok: true, count: list.length });
  });

  // A title's own display name, in every output (blank goes back to the provider's).
  router.put('/api/vod/:id', async (req, res, { params }) => {
    const it = mustGet(db, 'vod_items', params.id);
    const body = await readJson(req);
    db.run('UPDATE vod_items SET custom_name = ? WHERE id = ?', [optStr(body.custom_name, 300), it.id]);
    touch();
    sendJson(res, 200, { ok: true, custom_name: db.get('SELECT custom_name FROM vod_items WHERE id = ?', [it.id]).custom_name });
  });

  router.put('/api/outputs/:id/categories', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const { ids, state } = await readJson(req);
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be a list');
    if (state != null && !['include', 'exclude'].includes(state)) throw new HttpError(400, 'state must be include, exclude or null');
    db.tx(() => {
      for (const id of ids) {
        if (state) {
          db.run(
            `INSERT INTO output_category_overrides (output_id, category_id, state) VALUES (?, ?, ?)
             ON CONFLICT (output_id, category_id) DO UPDATE SET state = excluded.state`,
            [o.id, Number(id), state],
          );
        } else {
          db.run('DELETE FROM output_category_overrides WHERE output_id = ? AND category_id = ?', [o.id, Number(id)]);
        }
      }
    });
    touch();
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/outputs/:id/channels', (req, res, { params, query }) => {
    const o = loadOutput(db, Number(params.id));
    if (!o) throw new HttpError(404, 'Not found');
    const catId = Number(query.get('category_id'));
    const cat = evaluateCategories(db, o).find((c) => c.id === catId);
    if (!cat) throw new HttpError(404, 'Category is not part of this output');
    const overrides = new Map(db.all('SELECT channel_id, state FROM output_channel_overrides WHERE output_id = ?', [o.id])
      .map((r) => [r.channel_id, r.state]));
    const rows = db.all(
      `SELECT id, name, custom_name, logo, custom_logo, epg_id, custom_epg_id, tvg_id, sort, first_seen
         FROM channels WHERE category_id = ? AND active = 1 ORDER BY sort`,
      [catId],
    );
    rows.sort(channelCompare(o, cat, cleanerFor(o, 'live'), positionsOf(db, 'output_channel_order', 'channel_id', o.id)));
    const firstRefresh = db.get('SELECT first_refresh_at FROM sources WHERE id = ?', [cat.source_id])?.first_refresh_at || 0;
    const emptyRegexes = compilePatterns(emptyEventPatterns(db));
    const clean = cleanerFor(o, 'live');
    // What is on now is shown even with the toggle off, so its effect can be judged first.
    const guide = guideHider(db, o, [{ ...cat, hide_by_guide: true }]);
    sendJson(res, 200, {
      category_included: cat.included,
      ch_sort: cat.ch_sort, // this category's own sort, null when it follows the output
      sort_mode: cat.ch_sort || o.ch_sort || 'provider',
      hide_empty: cat.hide_empty,
      hide_by_guide: cat.hide_by_guide,
      hide_unlisted: cat.hide_unlisted,
      unlisted_hours: cat.unlisted_hours,
      // False when the source's guide has nothing airing now at all (stale or failed refresh).
      guide_current: guide.guideCurrent({ source_id: cat.source_id }),
      rules: cat.channel_rules.map(({ id, action, op, value }) => ({ id, action, op, value })),
      channels: rows.map((r) => {
        const override = overrides.get(r.id) || null;
        const ch = { ...r, source_id: cat.source_id };
        return {
          ...r, override,
          clean_name: clean.channel(r.name),
          // Added since the source's first refresh, in the last week.
          is_new: r.first_seen > firstRefresh + 60 && r.first_seen > now() - NEW_CHANNEL_S,
          is_empty_event: isEmptyEvent(r.name, emptyRegexes),
          now_title: guide.titleOf(ch),
          is_guide_placeholder: guide.isPlaceholder(ch),
          is_unlisted: guide.isUnlisted(ch, cat.unlisted_hours),
          // Nothing on now: the next listing within the look-ahead, if any.
          next: guide.titleOf(ch) ? null : guide.nextOf(ch),
          ...channelState(r.name, cat.included, cat.channel_rules, override, hiddenReason(cat, ch, emptyRegexes, guide)),
        };
      }),
    });
  });

  // What (unsaved) name cleanup rules would do: counts and a few before/after examples, over the
  // channels of categories currently in the output, with custom names left alone as on output.
  router.post('/api/outputs/:id/name-preview', async (req, res, { params }) => {
    const o = loadOutput(db, Number(params.id));
    if (!o) throw new HttpError(404, 'Not found');
    const checked = checkNameRules((await readJson(req)).rules);
    if (checked.error) throw new HttpError(400, checked.error);
    const clean = nameCleaner(checked.rules);
    const vodClean = nameCleaner(checked.rules, 'vod');
    const cats = evaluateCategories(db, o).filter((c) => c.included);
    const SAMPLES = 8;
    const tally = (names, fn) => {
      const out = { changed: 0, total: names.length, samples: [] };
      for (const name of names) {
        const after = fn(name);
        if (after === name) continue;
        out.changed++;
        if (out.samples.length < SAMPLES) out.samples.push([name, after]);
      }
      return out;
    };
    const chNames = cats.length
      ? db.all(
        `SELECT name FROM channels WHERE active = 1 AND custom_name IS NULL AND category_id IN (${cats.map(() => '?').join(',')})
          ORDER BY category_id, sort`,
        cats.map((c) => c.id),
      ).map((r) => r.name)
      : [];
    // Movies and series, when the output includes them: titles and categories currently in it.
    let vod = null;
    if (o.vod_enabled) {
      const vodCats = [...evaluateCategories(db, o, 'movie'), ...evaluateCategories(db, o, 'series')].filter((c) => c.included);
      const titles = vodCats.length
        ? db.all(
          `SELECT name FROM vod_items WHERE active = 1 AND custom_name IS NULL AND category_id IN (${vodCats.map(() => '?').join(',')}) ORDER BY category_id, sort`,
          vodCats.map((c) => c.id),
        ).map((r) => r.name)
        : [];
      vod = {
        titles: tally(titles, vodClean.channel),
        categories: tally(vodCats.filter((c) => !c.custom_name).map((c) => c.name), vodClean.category),
      };
    }
    sendJson(res, 200, {
      channels: tally(chNames, clean.channel),
      categories: tally(cats.filter((c) => !c.custom_name).map((c) => c.name), clean.category),
      vod,
    });
  });

  // Find channels by name across every category of an output's attached sources, with the same
  // included/reason a category's channel list would show. Saved state only (not unsaved edits).
  router.get('/api/outputs/:id/search', (req, res, { params, query }) => {
    const o = loadOutput(db, Number(params.id));
    if (!o) throw new HttpError(404, 'Not found');
    const q = String(query.get('q') || '').trim().toLowerCase();
    if (q.length < 2) return sendJson(res, 200, { matches: [], total: 0 });
    const LIMIT = 200;
    const kind = ['movie', 'series'].includes(query.get('kind')) ? query.get('kind') : 'live';
    const cats = new Map(evaluateCategories(db, o, kind).map((c) => [c.id, c]));
    if (!cats.size) return sendJson(res, 200, { matches: [], total: 0 });
    // Movies and series: a title is in when its category is and it isn't picked out by hand.
    if (kind !== 'live') {
      const titles = db.all(
        `SELECT v.id, v.category_id, v.name, v.custom_name, x.state AS override FROM vod_items v
           LEFT JOIN output_vod_overrides x ON x.item_id = v.id AND x.output_id = ?
          WHERE v.active = 1 AND v.category_id IN (${[...cats.keys()].map(() => '?').join(',')})
          ORDER BY v.category_id, v.sort`,
        [o.id, ...cats.keys()],
      ).filter((r) => r.name.toLowerCase().includes(q) || (r.custom_name || '').toLowerCase().includes(q));
      return sendJson(res, 200, {
        total: titles.length,
        matches: titles.slice(0, LIMIT).map((r) => {
          const cat = cats.get(r.category_id);
          const included = cat.included && r.override !== 'exclude';
          return { ...r, included, reason: !cat.included ? 'category' : r.override ? 'manual' : 'category' };
        }),
      });
    }
    // LIKE is only ASCII case-insensitive, so the final match is done here in JS.
    const rows = db.all(
      `SELECT id, category_id, name, custom_name, epg_id, custom_epg_id, tvg_id
         FROM channels WHERE active = 1 AND category_id IN (${[...cats.keys()].map(() => '?').join(',')})
        ORDER BY category_id, sort`,
      [...cats.keys()],
    ).filter((r) => r.name.toLowerCase().includes(q) || (r.custom_name || '').toLowerCase().includes(q));
    const shown = rows.slice(0, LIMIT);
    const overrides = new Map(db.all('SELECT channel_id, state FROM output_channel_overrides WHERE output_id = ?', [o.id])
      .map((r) => [r.channel_id, r.state]));
    const hitCats = [...new Set(shown.map((r) => r.category_id))].map((cid) => cats.get(cid));
    const emptyRegexes = compilePatterns(emptyEventPatterns(db));
    const guide = guideHider(db, o, hitCats);
    sendJson(res, 200, {
      total: rows.length,
      matches: shown.map((r) => {
        const cat = cats.get(r.category_id);
        const ch = { ...r, source_id: cat.source_id };
        const override = overrides.get(r.id) || null;
        const st = channelState(r.name, cat.included, cat.channel_rules, override, hiddenReason(cat, ch, emptyRegexes, guide));
        return { id: r.id, category_id: r.category_id, name: r.name, custom_name: r.custom_name, override, included: st.included, reason: st.reason };
      }),
    });
  });

  // Per-category switches for one output; only the switches present in the body change.
  router.put('/api/outputs/:id/categories/:catId/options', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const cat = mustGet(db, 'categories', params.catId);
    const body = await readJson(req);
    const cur = db.get('SELECT hide_empty, hide_by_guide, hide_unlisted, unlisted_hours FROM output_category_settings WHERE output_id = ? AND category_id = ?', [o.id, cat.id])
      || { hide_empty: 0, hide_by_guide: 0, hide_unlisted: 0, unlisted_hours: 24 };
    const val = (k) => (body[k] === undefined ? cur[k] : bool(body[k]));
    // Look-ahead for "nothing listed": 1 hour to a week.
    const hours = body.unlisted_hours === undefined ? cur.unlisted_hours : int(body.unlisted_hours, 24, 1, 168);
    db.run(
      `INSERT INTO output_category_settings (output_id, category_id, hide_empty, hide_by_guide, hide_unlisted, unlisted_hours) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (output_id, category_id) DO UPDATE SET
         hide_empty = excluded.hide_empty, hide_by_guide = excluded.hide_by_guide, hide_unlisted = excluded.hide_unlisted,
         unlisted_hours = excluded.unlisted_hours`,
      [o.id, cat.id, val('hide_empty'), val('hide_by_guide'), val('hide_unlisted'), hours],
    );
    touch();
    sendJson(res, 200, { ok: true });
  });

  // Replace the channel rules of one category in this output.
  // Order: the output's sorts (category and channel), and arrangements made by hand.
  const replaceOrder = (table, column, outputId, ids) => db.tx(() => {
    ids.forEach((id, i) => {
      db.run(`INSERT INTO ${table} (output_id, ${column}, position) VALUES (?, ?, ?)
              ON CONFLICT(output_id, ${column}) DO UPDATE SET position = excluded.position`, [outputId, Number(id), i]);
    });
  });
  const idList = (ids) => {
    if (!Array.isArray(ids) || !ids.every((x) => Number.isInteger(x))) throw new HttpError(400, 'ids must be a list of ids');
    return ids;
  };
  router.put('/api/outputs/:id/sort', async (req, res, { params }) => {
    const o = loadOutput(db, Number(params.id));
    if (!o) throw new HttpError(404, 'Not found');
    const { cat_sort: catSort, ch_sort: chSort } = await readJson(req);
    if (catSort !== undefined) {
      if (!['provider', 'name', 'custom'].includes(catSort)) throw new HttpError(400, 'Unknown sort');
      // First time on Custom: start from the order on screen rather than jump back to the provider's.
      if (catSort === 'custom' && !db.get('SELECT 1 FROM output_category_order WHERE output_id = ? LIMIT 1', [o.id])) {
        for (const kind of ['live', 'movie', 'series']) replaceOrder('output_category_order', 'category_id', o.id, evaluateCategories(db, o, kind).map((c) => c.id));
      }
      db.run('UPDATE outputs SET cat_sort = ? WHERE id = ?', [catSort, o.id]);
    }
    if (chSort !== undefined) {
      if (!['provider', 'name'].includes(chSort)) throw new HttpError(400, 'Unknown sort');
      db.run('UPDATE outputs SET ch_sort = ? WHERE id = ?', [chSort, o.id]);
    }
    touch();
    sendJson(res, 200, { ok: true });
  });
  router.put('/api/outputs/:id/category-order', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    replaceOrder('output_category_order', 'category_id', o.id, idList((await readJson(req)).ids));
    touch();
    sendJson(res, 200, { ok: true });
  });
  // One category's sort: null follows the output.
  router.put('/api/outputs/:id/categories/:catId/channel-sort', async (req, res, { params }) => {
    const o = loadOutput(db, Number(params.id));
    if (!o) throw new HttpError(404, 'Not found');
    const cat = evaluateCategories(db, o).find((c) => c.id === Number(params.catId));
    if (!cat) throw new HttpError(404, 'Category is not part of this output');
    const { mode = null } = await readJson(req);
    if (![null, 'provider', 'name', 'custom'].includes(mode)) throw new HttpError(400, 'Unknown sort');
    if (mode === 'custom') {
      const rows = db.all('SELECT id, name, custom_name, sort FROM channels WHERE category_id = ? AND active = 1 ORDER BY sort', [cat.id]);
      const positions = positionsOf(db, 'output_channel_order', 'channel_id', o.id);
      // First time on Custom for this category: start from the order on screen.
      if (!rows.some((r) => positions.has(r.id))) {
        rows.sort(channelCompare(o, cat, cleanerFor(o, 'live'), positions));
        replaceOrder('output_channel_order', 'channel_id', o.id, rows.map((r) => r.id));
      }
    }
    db.run(`INSERT INTO output_category_settings (output_id, category_id, ch_sort) VALUES (?, ?, ?)
            ON CONFLICT(output_id, category_id) DO UPDATE SET ch_sort = excluded.ch_sort`, [o.id, cat.id, mode]);
    touch();
    sendJson(res, 200, { ok: true });
  });
  router.put('/api/outputs/:id/categories/:catId/channel-order', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    replaceOrder('output_channel_order', 'channel_id', o.id, idList((await readJson(req)).ids));
    touch();
    sendJson(res, 200, { ok: true });
  });

  router.put('/api/outputs/:id/categories/:catId/channel-rules', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const cat = mustGet(db, 'categories', params.catId);
    const body = await readJson(req);
    if (!Array.isArray(body.rules)) throw new HttpError(400, 'rules must be a list');
    const rules = validateRules(body.rules);
    db.tx(() => {
      db.run('DELETE FROM output_channel_rules WHERE output_id = ? AND category_id = ?', [o.id, cat.id]);
      rules.forEach((r, i) => {
        db.run('INSERT INTO output_channel_rules (output_id, category_id, action, op, value, sort) VALUES (?, ?, ?, ?, ?, ?)', [
          o.id, cat.id, r.action, r.op, r.value, i,
        ]);
      });
    });
    touch();
    sendJson(res, 200, { ok: true });
  });

  router.put('/api/outputs/:id/channels', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const { ids, state } = await readJson(req);
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be a list');
    if (state != null && !['include', 'exclude'].includes(state)) throw new HttpError(400, 'state must be include, exclude or null');
    db.tx(() => {
      for (const id of ids) {
        if (state) {
          db.run(
            `INSERT INTO output_channel_overrides (output_id, channel_id, state) VALUES (?, ?, ?)
             ON CONFLICT (output_id, channel_id) DO UPDATE SET state = excluded.state`,
            [o.id, Number(id), state],
          );
        } else {
          db.run('DELETE FROM output_channel_overrides WHERE output_id = ? AND channel_id = ?', [o.id, Number(id)]);
        }
      }
    });
    touch();
    sendJson(res, 200, { ok: true });
  });
}
