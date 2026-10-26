// End-to-end: a fake provider (M3U + gzipped XMLTV + Xtream Codes + HLS) feeding the real app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { tsStart } from './ts.mjs';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { importSettings } from '../src/backup.js';

const PASSWORD = 'correct horse';
let upstream;
let up; // upstream base URL
let app;
let base;
let cookie = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-test-'));

// Mutable provider state so tests can simulate a provider adding categories.
const xcCats = [
  { category_id: '10', category_name: 'US| NEWS' },
  { category_id: '11', category_name: 'US| ADULT' },
  { category_id: '12', category_name: 'UK| SPORTS' },
];
// Movies and series of the fake XC account. One series category shares a live category's name.
const vodData = {
  movieCats: [
    { category_id: '201', category_name: 'EN| ACTION' },
    { category_id: '202', category_name: 'EN| KIDS' },
    { category_id: '203', category_name: 'FR| FILMS' },
  ],
  movies: [
    { num: 1, name: 'Tower Siege', stream_id: 5001, stream_icon: 'http://p/dh.jpg', rating: '8', added: '1700000000', category_id: '201', container_extension: 'mkv' },
    { num: 2, name: 'City Chase', stream_id: 5002, stream_icon: '', rating: '7', added: '1700000001', category_id: '201', container_extension: 'mp4' },
    { num: 3, name: 'Snow Day', stream_id: 5003, stream_icon: '', added: '1700000002', category_id: '202', container_extension: 'mp4' },
    { num: 4, name: 'Caméra Obscura', stream_id: 5004, stream_icon: '', added: '1700000003', category_id: '203', container_extension: 'mp4' },
  ],
  seriesCats: [
    { category_id: '301', category_name: 'EN| DRAMA' },
    { category_id: '302', category_name: 'US| NEWS' },
  ],
  series: [
    { num: 1, name: 'Bad Chemistry', series_id: 7001, cover: 'http://p/bb.jpg', plot: 'Chemistry', last_modified: '1700000100', category_id: '301' },
    { num: 2, name: 'The Night Desk', series_id: 7002, cover: '', last_modified: '1700000101', category_id: '302' },
  ],
};

const xcStreams = [
  { num: 1, name: 'US: NewsNet HD', stream_id: 101, stream_icon: 'http://logo/newsnet.png', epg_channel_id: 'newsnet.us', category_id: '10' },
  { num: 2, name: 'US: Daily News', stream_id: 102, stream_icon: '', epg_channel_id: '', category_id: '10' },
  { num: 3, name: 'Late Night', stream_id: 103, stream_icon: '', epg_channel_id: '', category_id: '11' },
  { num: 4, name: 'UK: Arena Sports', stream_id: 104, stream_icon: '', epg_channel_id: 'arena.uk', category_id: '12' },
];

// DeviceAuth deliberately contains characters that must be URL-encoded.
const HDHR_AUTH = 'aB3+/x=Zq';
const hdhr = { xmltvAllowed: false, guideRequests: 0 };
// The "running" commit the app reports, and what the fake GitHub says is latest.
const RUNNING = 'a'.repeat(40);
const gh = { latest: RUNNING, newer: [], fail: false };
// Extra guide channels served by the fake xmltv.php: [{ id, title-airing-now }].
const eventGuide = [];
// The fake XC account's expiry, and what the fake ntfy/webhook receiver got.
const xcAccount = { exp: 1900000000 };
const notified = [];
// Continuous live streams (XC stream ids 950-959): upstream connections open per id, and made.
// Live channels 95x stream continuously; ids in live.paused send nothing until removed, and 958
// sends 64 KB every 20 ms (a fast channel, for a viewer that falls behind).
// Ids in live.bursty send only in the first 40 ms of every 400 ms, like a provider that delivers
// a channel segment by segment.
// Ids in live.doubled do the same but skip every third burst (gaps of 360 and 760 ms), like a provider
// that now and then sends two bursts together.
const live = { open: new Map(), requests: 0, paused: new Set(), bursty: new Set(), doubled: new Set() };

const xmltvTime = (d) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
function guide(ids) {
  const now = Date.now();
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';
  for (const [id, name] of ids) x += `<channel id="${id}"><display-name>${name}</display-name></channel>\n`;
  for (const [id, name] of ids) {
    for (let h = -1; h < 3; h++) {
      const s = new Date(now + h * 3600_000);
      const e = new Date(now + (h + 1) * 3600_000);
      x += `<programme start="${xmltvTime(s)}" stop="${xmltvTime(e)}" channel="${id}"><title>${name} show ${h}</title><desc>About ${name}</desc></programme>\n`;
    }
  }
  // A stale program outside the window must be dropped.
  x += `<programme start="20000101000000 +0000" stop="20000101010000 +0000" channel="${ids[0][0]}"><title>Old</title></programme>\n`;
  return x + '</tv>\n';
}

function startUpstream() {
  upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (u.pathname === '/playlist.m3u') {
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end([
        `#EXTM3U url-tvg="${up}/m3u-guide.xml.gz"`,
        '#EXTINF:-1 tvg-id="kingdom1.uk" tvg-logo="http://logo/bbc.png" group-title="UK| GENERAL",Kingdom One HD',
        `${up}/hls/kingdom/index.m3u8`,
        '#EXTINF:-1 tvg-id="" group-title="UK| GENERAL",Vista 1',
        'http://streams/itv.ts',
        '#EXTINF:-1 tvg-id="newsnet.us" group-title="US| NEWS",NewsNet',
        'http://streams/newsnet.ts',
        '#EXTINF:-1 group-title="MOVIES",Some Movie',
        'http://h/movie/u/p/5.mp4',
        '#EXTINF:-1 tvg-logo="http://logo/lost.png" group-title="SHOWS",Lost S01 E01',
        'http://h/series/u/p/77.mkv',
        '#EXTINF:-1 group-title="SHOWS",Lost S01 E02',
        'http://h/series/u/p/78.mkv',
      ].join('\n'));
    }
    if (u.pathname === '/m3u-guide.xml.gz') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(zlib.gzipSync(guide([['kingdom1.uk', 'Kingdom One'], ['vista1.uk', 'Vista 1'], ['newsnet.us', 'NewsNet M3U']])));
    }
    if (u.pathname === '/player_api.php') {
      if (u.searchParams.get('username') !== 'xu' || u.searchParams.get('password') !== 'xp') return json({ user_info: { auth: 0 } });
      const action = u.searchParams.get('action');
      if (!action) return json({ user_info: { auth: 1, status: 'Active', exp_date: String(xcAccount.exp), max_connections: '2' }, server_info: {} });
      if (action === 'get_live_categories') return json(xcCats);
      if (action === 'get_live_streams') return json(xcStreams);
      if (action === 'get_vod_categories') return json(vodData.movieCats);
      if (action === 'get_vod_streams') return json(vodData.movies);
      if (action === 'get_series_categories') return json(vodData.seriesCats);
      if (action === 'get_series') return json(vodData.series);
      if (action === 'get_vod_info') {
        return json({ info: { plot: 'A cop in a tower', tmdb_id: '562' }, movie_data: { stream_id: Number(u.searchParams.get('vod_id')), container_extension: 'mkv' } });
      }
      if (action === 'get_series_info' && u.searchParams.get('series_id') === '7001') {
        return json({
          seasons: [{ season_number: 1, name: 'Season 1' }],
          info: { name: 'Bad Chemistry', plot: 'Chemistry teacher' },
          episodes: { 1: [
            { id: '90001', episode_num: 1, title: 'Pilot', container_extension: 'mkv', season: 1, info: { duration: '00:58:00' } },
            { id: '90002', episode_num: 2, title: 'Cat in the Bag', container_extension: 'mkv', season: 1, info: {} },
          ] },
        });
      }
      return json([]);
    }
    if (u.pathname === '/xmltv.php') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      // Event channels whose program airing now has a chosen title (e.g. "No Game Today").
      // Deliberately appended after the other programs, like a merged guide: ingest must
      // still match these late <channel> entries.
      const now = Date.now();
      // fromH/toH place the listing in time (default: airing now); channelOnly lists the channel
      // with no programs at all.
      const events = eventGuide.map(({ id, title, fromH = -1, toH = 1, channelOnly, icon }) =>
        `<channel id="${id}"><display-name>${id}</display-name>${icon ? `<icon src="${icon}"/>` : ''}</channel>\n` +
        (channelOnly ? '' : `<programme start="${xmltvTime(new Date(now + fromH * 3600_000))}" stop="${xmltvTime(new Date(now + toH * 3600_000))}" channel="${id}"><title>${title}</title></programme>\n`)).join('');
      return res.end(guide([['newsnet.us', 'NewsNet'], ['arena.uk', 'Arena Sports'], ['dailynews.us', 'Daily News']]).replace('</tv>', `${events}</tv>`));
    }
    // Real MPEG-TS tables: 960 is an old tuner channel (MPEG-2 video, AC-3 sound), 961 H.264 + AAC.
    const tsId = /^\/live\/xu\/xp\/(96\d)\.ts$/.exec(u.pathname)?.[1];
    if (tsId) {
      live.requests++;
      live.open.set(tsId, (live.open.get(tsId) || 0) + 1);
      const tables = tsStart(tsId === '960' ? [{ type: 0x02 }, { type: 0x81 }] : [{ type: 0x1b }, { type: 0x0f }]);
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.write(tables);
      const timer = setInterval(() => res.write(tables), 20);
      res.on('close', () => {
        clearInterval(timer);
        live.open.set(tsId, live.open.get(tsId) - 1);
      });
      return;
    }
    const liveId = /^\/live\/xu\/xp\/(95\d)\.ts$/.exec(u.pathname)?.[1];
    if (liveId) {
      live.requests++;
      live.open.set(liveId, (live.open.get(liveId) || 0) + 1);
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      const fat = liveId === '958' ? Buffer.alloc(65536, 0x47) : null;
      const timer = setInterval(() => {
        if (live.paused.has(liveId) || (live.bursty.has(liveId) && Date.now() % 400 >= 40)) return;
        if (live.doubled.has(liveId) && (Date.now() % 400 >= 40 || Math.floor(Date.now() / 400) % 3 === 0)) return;
        res.write(fat || `chunk-${liveId};`);
      }, 20);
      res.on('close', () => {
        clearInterval(timer);
        live.open.set(liveId, live.open.get(liveId) - 1);
      });
      return;
    }
    // Movie and episode files, with Range support like a real server.
    const vodFile = /^\/(movie|series)\/xu\/xp\/(\d+)\.(\w+)$/.exec(u.pathname);
    if (vodFile) {
      const body = Buffer.from(`${vodFile[1].toUpperCase()}-${vodFile[2]}-`.padEnd(100, '.'));
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        const from = Number(range[1]);
        const to = range[2] ? Number(range[2]) : body.length - 1;
        res.writeHead(206, { 'content-type': 'video/x-matroska', 'content-range': `bytes ${from}-${to}/${body.length}`, 'accept-ranges': 'bytes', 'content-length': to - from + 1 });
        return res.end(body.subarray(from, to + 1));
      }
      res.writeHead(200, { 'content-type': 'video/x-matroska', 'accept-ranges': 'bytes', 'content-length': body.length });
      return res.end(body);
    }
    if (u.pathname.startsWith('/live/xu/xp/')) {
      if (req.headers['user-agent'] !== 'TestAgent/1') {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end(`TS-${u.pathname.split('/').pop()}`);
    }
    // A fake ntfy / webhook receiver for alerts.
    if (u.pathname === '/notify') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        notified.push({ title: req.headers.title || null, priority: req.headers.priority || null, type: req.headers['content-type'] || '', body });
        res.writeHead(200);
        res.end('ok');
      });
      return;
    }
    // A fake GitHub API for the update check.
    if (u.pathname.startsWith('/repos/test/repo/')) {
      if (gh.fail) {
        res.writeHead(500);
        return res.end();
      }
      if (u.pathname === '/repos/test/repo/commits/main') {
        return json({ sha: gh.latest, commit: { message: 'Latest change\n\nLonger body', committer: { date: '2026-09-24T12:00:00Z' } } });
      }
      const m = /^\/repos\/test\/repo\/compare\/(\w+)\.\.\.(\w+)$/.exec(u.pathname);
      if (m) {
        if (m[1] !== RUNNING) {
          res.writeHead(404);
          return res.end();
        }
        return json({
          ahead_by: gh.newer.length,
          behind_by: 0,
          commits: gh.newer.map((msg, i) => ({ sha: String(i).repeat(40), commit: { message: msg, committer: { date: '2026-09-2' + i + 'T00:00:00Z' } } })),
        });
      }
    }
    // A fake HDHomeRun box and SiliconDust guide service.
    if (u.pathname === '/hdhr/discover.json') {
      return json({ DeviceID: '1234ABCD', DeviceAuth: HDHR_AUTH, ModelNumber: 'HDFX-4K', TunerCount: 4, FirmwareVersion: '20240101' });
    }
    if (u.pathname === '/hdhr/lineup.json') {
      return json([
        { GuideNumber: '2.1', GuideName: 'WCBS-HD', HD: 1, URL: `${up}/hdhr/auto/v2.1` },
        { GuideNumber: '4.1', GuideName: 'WNBC-HD', HD: 1, URL: `${up}/hdhr/auto/v4.1` },
        { GuideNumber: '13.1', GuideName: 'PREMIUM', DRM: 1, URL: `${up}/hdhr/auto/v13.1` },
      ]);
    }
    if (u.pathname.startsWith('/api/')) {
      if (u.searchParams.get('DeviceAuth') !== HDHR_AUTH) {
        res.writeHead(401);
        return res.end();
      }
      if (u.pathname === '/api/xmltv') {
        if (!hdhr.xmltvAllowed) {
          res.writeHead(403);
          return res.end('subscription required');
        }
        const s = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
        const e = new Date(s.getTime() + 3600_000);
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<?xml version="1.0"?><tv>
<channel id="US101.hdhomerun.com"><display-name>2.1</display-name><display-name>WCBS</display-name></channel>
<channel id="US102.hdhomerun.com"><display-name>4.1</display-name><display-name>WNBC</display-name></channel>
<programme start="${xmltvTime(s)}" stop="${xmltvTime(e)}" channel="US101.hdhomerun.com"><title>Feed News</title></programme>
<programme start="${xmltvTime(s)}" stop="${xmltvTime(e)}" channel="US102.hdhomerun.com"><title>Feed Movie</title></programme>
</tv>`);
      }
      if (u.pathname === '/api/guide') {
        hdhr.guideRequests++;
        // Each page covers 4 hours from Start, as two 2-hour shows; nothing past 8 hours.
        const anchor = Math.floor(Date.now() / 3600_000) * 3600;
        const start = Math.floor(Number(u.searchParams.get('Start')) / 3600) * 3600;
        if (start >= anchor + 8 * 3600) return json([]);
        const shows = (num, title, filter) => [0, 1].map((i) => ({
          StartTime: start + i * 7200, EndTime: start + (i + 1) * 7200, Title: `${title} ${i}`, EpisodeTitle: 'Pilot',
          Synopsis: `About ${title}`, EpisodeNumber: 'S02E05', Filter: filter, ImageURL: 'http://img/x.jpg',
        }));
        return json([
          { GuideNumber: '2.1', GuideName: 'WCBS', Affiliate: 'CBS', Guide: shows('2.1', 'Evening News', ['News']) },
          { GuideNumber: '4.1', GuideName: 'WNBC', Affiliate: 'NBC', Guide: shows('4.1', 'Big Film', ['Movies']) },
        ]);
      }
    }
    if (u.pathname === '/hls/kingdom/index.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n');
    }
    if (u.pathname === '/hls/kingdom/seg1.ts') {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end('SEGMENT-1');
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((r) => upstream.listen(0, '127.0.0.1', () => {
    up = `http://127.0.0.1:${upstream.address().port}`;
    r();
  }));
}

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

before(async () => {
  await startUpstream();
  app = createApp({
    dataDir, adminPassword: PASSWORD, log: () => {}, hdhrApiBase: up,
    updateApiBase: up, updateRepo: 'test/repo', appCommit: RUNNING, updateCheckDelayMs: 1e9,
  });
  const addr = await app.start(0, '127.0.0.1');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.close();
  await new Promise((r) => upstream.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let m3uId;
let xcId;
let outputId;
let token;

test('admin API requires login and the CSRF header', async () => {
  assert.equal((await api('GET', '/api/sources')).status, 401);
  assert.equal((await api('POST', '/api/login', { password: 'nope' })).status, 401);
  assert.equal((await api('POST', '/api/login', { password: PASSWORD })).status, 200);
  assert.equal((await api('GET', '/api/sources')).status, 200);
  const res = await fetch(`${base}/api/outputs`, { method: 'POST', headers: { cookie } });
  assert.equal(res.status, 403);
});

test('M3U source: parses, skips VOD, auto-associates the header EPG', async () => {
  const r = await api('POST', '/api/sources', { name: 'M3U', type: 'm3u', url: `${up}/playlist.m3u` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  m3uId = r.data.id;
  await app.ctx.jobs.idle();
  const s = (await api('GET', `/api/sources/${m3uId}`)).data;
  assert.equal(s.last_status, 'ok', s.last_error);
  assert.equal(s.counts.channels, 3);
  assert.equal(s.counts.categories, 2);
  // kingdom1.uk by tvg-id, Vista 1 by name, newsnet.us by tvg-id
  assert.equal(s.counts.epg_matched, 3);
  const chans = (await api('GET', `/api/sources/${m3uId}/channels`)).data.items;
  assert.equal(chans.find((c) => c.name === 'Vista 1').epg_match, 'name');
});

test('Xtream Codes source: categories, streams, account info and EPG', async () => {
  const r = await api('POST', '/api/sources', {
    name: 'XC', type: 'xc', xc_host: up, xc_username: 'xu', xc_password: 'xp', user_agent: 'TestAgent/1',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  xcId = r.data.id;
  assert.equal(r.data.xc_password, '', 'password is never echoed');
  await app.ctx.jobs.idle();
  const s = (await api('GET', `/api/sources/${xcId}`)).data;
  assert.equal(s.last_status, 'ok', s.last_error);
  assert.equal(s.counts.channels, 4);
  assert.equal(s.counts.categories, 3);
  assert.equal(s.account_info.max_connections, '2');
  assert.equal(s.counts.epg_matched, 3); // newsnet.us, arena.uk by id; Daily News by name
});

test('bad XC credentials produce an error status without wiping data', async () => {
  const bad = await api('POST', '/api/sources', { name: 'Bad', type: 'xc', xc_host: up, xc_username: 'no', xc_password: 'no' });
  await app.ctx.jobs.idle();
  const s = (await api('GET', `/api/sources/${bad.data.id}`)).data;
  assert.equal(s.last_status, 'error');
  assert.match(s.last_error, /rejected/);
  await api('DELETE', `/api/sources/${bad.data.id}`);
});

test('output with rules across two sources', async () => {
  const o = await api('POST', '/api/outputs', { name: 'Family' });
  assert.equal(o.status, 201);
  outputId = o.data.id;
  token = o.data.token;
  const r = await api('PUT', `/api/outputs/${outputId}`, {
    source_ids: [xcId, m3uId],
    stream_mode: 'proxy',
    number_start: 100,
    xc_enabled: true,
    xc_username: 'family',
    xc_password: 'pw123',
    rules: [
      { action: 'include', op: 'starts_with', value: 'us|' },
      { action: 'include', op: 'contains', value: 'general', source_id: m3uId },
      { action: 'exclude', op: 'contains', value: 'adult' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cats = (await api('GET', `/api/outputs/${outputId}/categories`)).data;
  const state = Object.fromEntries(cats.map((c) => [`${c.source_id}:${c.name}`, c.included]));
  assert.deepEqual(state, {
    [`${xcId}:US| NEWS`]: true,
    [`${xcId}:US| ADULT`]: false,
    [`${xcId}:UK| SPORTS`]: false,
    [`${m3uId}:UK| GENERAL`]: true,
    [`${m3uId}:US| NEWS`]: true,
  });
});

test('M3U output: order, numbering, proxied URLs and EPG link', async () => {
  const res = await fetch(`${base}/o/${token}/playlist.m3u`);
  assert.equal(res.status, 200);
  const text = await res.text();
  const names = [...text.matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
  assert.deepEqual(names, ['US: NewsNet HD', 'US: Daily News', 'Kingdom One HD', 'Vista 1', 'NewsNet']);
  assert.match(text, /^#EXTM3U url-tvg="http:\/\/127\.0\.0\.1:\d+\/o\/[^/]+\/epg\.xml"/);
  assert.match(text, /tvg-chno="100"[^\n]*,US: NewsNet HD/);
  assert.match(text, /tvg-chno="104"[^\n]*,NewsNet/);
  // newsnet.us exists in both sources: the second gets a source-scoped id.
  assert.match(text, /tvg-id="newsnet\.us"[^\n]*,US: NewsNet HD/);
  assert.match(text, new RegExp(`tvg-id="newsnet\\.us\\.s${m3uId}"[^\\n]*,NewsNet`));
  assert.ok(!text.includes('xu/xp'), 'provider credentials must not leak in proxy mode');
  assert.equal((await fetch(`${base}/o/nottoken/playlist.m3u`)).status, 404);
});

test('EPG output contains only selected channels, in window, with renamed ids', async () => {
  const res = await fetch(`${base}/o/${token}/epg.xml`, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(res.status, 200);
  const xml = await res.text();
  const channelIds = [...xml.matchAll(/<channel id="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(channelIds, ['kingdom1.uk', 'newsnet.us', `newsnet.us.s${m3uId}`, 'dailynews.us', 'vista1.uk'].sort());
  assert.ok(!xml.includes('arena.uk'));
  assert.ok(!xml.includes('>Old<'), 'stale programs are dropped');
  assert.match(xml, new RegExp(`channel="newsnet\\.us\\.s${m3uId}"><title>NewsNet M3U show 0</title>`));
  assert.match(xml, /channel="newsnet\.us"><title>NewsNet show 0<\/title>/);
  const gz = await fetch(`${base}/o/${token}/epg.xml.gz`);
  assert.equal(zlib.gunzipSync(Buffer.from(await gz.arrayBuffer())).toString(), xml);
});

test('Jellyfin categories on a group tag every program of its channels, and only those', async () => {
  const cats = (await api('GET', `/api/sources/${xcId}/categories`)).data;
  const news = cats.find((c) => c.name === 'US| NEWS');
  assert.equal((await api('PUT', `/api/categories/${news.id}`, { jellyfin: ['Sports'] })).status, 200);
  assert.equal((await api('PUT', `/api/categories/${news.id}`, { jellyfin: ['Cartoons'] })).status, 400);
  // Partial update: changing the name keeps the tag, and vice versa.
  await api('PUT', `/api/categories/${news.id}`, { custom_name: 'US News' });
  const r = await api('PUT', `/api/categories/${news.id}`, { jellyfin: ['news', 'Kids'] });
  assert.deepEqual(r.data, { ok: true, custom_name: 'US News', jellyfin: ['News', 'Kids'] });

  const xml = await (await fetch(`${base}/o/${token}/epg.xml`, { headers: { 'accept-encoding': 'identity' } })).text();
  const programmes = (id) => [...xml.matchAll(new RegExp(`<programme [^>]*channel="${id.replace(/\./g, '\\.')}">(.*?)</programme>`, 'g'))].map((m) => m[1]);
  const tagged = [...programmes('newsnet.us'), ...programmes('dailynews.us')];
  assert.ok(tagged.length >= 6);
  for (const p of tagged) {
    assert.match(p, /<\/desc><category lang="en">News<\/category><category lang="en">Kids<\/category>$/);
  }
  // Same group name from the M3U source is a different group: untouched.
  for (const p of [...programmes(`newsnet.us.s${m3uId}`), ...programmes('kingdom1.uk')]) assert.doesNotMatch(p, /<category/);

  const m3u = await (await fetch(`${base}/o/${token}/playlist.m3u`)).text();
  assert.match(m3u, /group-title="US News",US: NewsNet HD/);
  await api('PUT', `/api/categories/${news.id}`, { custom_name: '' });
});

test('proxy mode relays TS with the source user agent and rewrites HLS', async () => {
  const text = await (await fetch(`${base}/o/${token}/playlist.m3u`)).text();
  const newsnet = text.split('\n').find((l) => /\/s\/.+\.ts$/.test(l));
  const ts = await fetch(newsnet);
  assert.equal(ts.status, 200);
  assert.equal(await ts.text(), 'TS-101.ts');

  const hlsUrl = text.split('\n').find((l) => l.endsWith('.m3u8'));
  const playlist = await (await fetch(hlsUrl)).text();
  const seg = playlist.split('\n').find((l) => l.startsWith('/s/'));
  assert.ok(seg, playlist);
  assert.equal(await (await fetch(base + seg)).text(), 'SEGMENT-1');
  assert.equal((await fetch(base + seg.replace(/sig=.*/, 'sig=forged'))).status, 403);
});

test('Xtream Codes output API', async () => {
  const q = (action, extra = '') => fetch(`${base}/player_api.php?username=family&password=pw123&action=${action}${extra}`).then((r) => r.json());
  const info = await (await fetch(`${base}/player_api.php?username=family&password=pw123`)).json();
  assert.equal(info.user_info.auth, 1);
  assert.equal((await (await fetch(`${base}/player_api.php?username=family&password=wrong`)).json()).user_info.auth, 0);
  const cats = await q('get_live_categories');
  assert.deepEqual(cats.map((c) => c.category_name), ['US| NEWS', 'UK| GENERAL', 'US| NEWS']);
  const streams = await q('get_live_streams');
  assert.equal(streams.length, 5);
  const inCat = await q('get_live_streams', `&category_id=${cats[1].category_id}`);
  assert.deepEqual(inCat.map((s) => s.name), ['Kingdom One HD', 'Vista 1']);
  assert.deepEqual(await q('get_vod_streams'), []);
  const epg = await q('get_short_epg', `&stream_id=${streams[0].stream_id}&limit=2`);
  assert.equal(epg.epg_listings.length, 2);
  assert.equal(Buffer.from(epg.epg_listings[0].title, 'base64').toString(), 'NewsNet show 0');
  assert.equal(Buffer.from(epg.epg_listings[0].description, 'base64').toString(), 'About NewsNet');
  const live = await fetch(`${base}/live/family/pw123/${streams[0].stream_id}.ts`);
  assert.equal(await live.text(), 'TS-101.ts');
  assert.equal((await fetch(`${base}/live/family/bad/${streams[0].stream_id}.ts`)).status, 401);
  const m3u = await (await fetch(`${base}/get.php?username=family&password=pw123&type=m3u_plus`)).text();
  assert.match(m3u, /\/live\/family\/pw123\/\d+\.ts/);
});

test('new upstream categories that match rules join automatically; manual overrides stick', async () => {
  xcCats.push({ category_id: '13', category_name: 'US| SPORTS' }, { category_id: '14', category_name: 'FR| INFO' });
  xcStreams.push(
    { num: 5, name: 'US: Sportsline', stream_id: 105, epg_channel_id: '', category_id: '13' },
    { num: 6, name: 'France 24', stream_id: 106, epg_channel_id: '', category_id: '14' },
  );
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  const cats = (await api('GET', `/api/outputs/${outputId}/categories`)).data;
  const sports = cats.find((c) => c.name === 'US| SPORTS');
  const fr = cats.find((c) => c.name === 'FR| INFO');
  assert.equal(sports.included, true);
  assert.equal(sports.is_new, true);
  assert.equal(fr.included, false);
  assert.equal(fr.is_new, true);

  await api('PUT', `/api/outputs/${outputId}/categories`, { ids: [sports.id], state: 'exclude' });
  await api('PUT', `/api/outputs/${outputId}/categories`, { ids: [fr.id], state: 'include' });
  let text = await (await fetch(`${base}/o/${token}/playlist.m3u`)).text();
  assert.ok(!text.includes('US: Sportsline'));
  assert.ok(text.includes('France 24'));

  // Survives another refresh.
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  text = await (await fetch(`${base}/o/${token}/playlist.m3u`)).text();
  assert.ok(!text.includes('US: Sportsline'));
  assert.ok(text.includes('France 24'));
});

test('channel edits and per-output channel overrides', async () => {
  const chans = (await api('GET', `/api/sources/${m3uId}/channels?q=Vista`)).data.items;
  const itv = chans[0];
  const r = await api('PUT', `/api/channels/${itv.id}`, { custom_name: 'ITV One', custom_logo: 'http://logo/itv.png' });
  assert.equal(r.status, 200);
  const bbc = (await api('GET', `/api/sources/${m3uId}/channels?q=Kingdom`)).data.items[0];
  await api('PUT', `/api/outputs/${outputId}/channels`, { ids: [bbc.id], state: 'exclude' });
  const text = await (await fetch(`${base}/o/${token}/playlist.m3u`)).text();
  assert.match(text, /tvg-logo="http:\/\/logo\/itv\.png"[^\n]*,ITV One/);
  assert.ok(!text.includes('Kingdom One'));
});

test('channel rules inside one category; manual channel picks still win', async () => {
  const cats = (await api('GET', `/api/outputs/${outputId}/categories`)).data;
  const news = cats.find((c) => c.name === 'US| NEWS' && c.source_id === xcId);
  const names = async () => [...(await (await fetch(`${base}/o/${token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);

  assert.equal((await api('PUT', `/api/outputs/${outputId}/categories/${news.id}/channel-rules`, { rules: [{ action: 'exclude', op: 'wat', value: 'x' }] })).status, 400);
  await api('PUT', `/api/outputs/${outputId}/categories/${news.id}/channel-rules`, { rules: [{ action: 'exclude', op: 'contains', value: 'daily' }] });
  let list = await names();
  assert.ok(list.includes('US: NewsNet HD') && !list.includes('US: Daily News'));
  // The M3U source's "US| NEWS" is a different category and is untouched.
  assert.ok(list.includes('NewsNet'));

  const view = (await api('GET', `/api/outputs/${outputId}/channels?category_id=${news.id}`)).data;
  assert.deepEqual(view.rules.map((r) => [r.action, r.op, r.value]), [['exclude', 'contains', 'daily']]);
  const fox = view.channels.find((c) => c.name === 'US: Daily News');
  assert.deepEqual([fox.included, fox.reason], [false, 'rule']);

  await api('PUT', `/api/outputs/${outputId}/channels`, { ids: [fox.id], state: 'include' });
  assert.ok((await names()).includes('US: Daily News'), 'manual include beats the rule');
  await api('PUT', `/api/outputs/${outputId}/channels`, { ids: [fox.id], state: null });

  await api('PUT', `/api/outputs/${outputId}/categories/${news.id}/channel-rules`, { rules: [{ action: 'include', op: 'starts_with', value: 'us: newsnet' }] });
  list = await names();
  assert.ok(list.includes('US: NewsNet HD') && !list.includes('US: Daily News'));
  const newsnet = (await api('GET', `/api/outputs/${outputId}/channels?category_id=${news.id}`)).data.channels.find((c) => c.name === 'US: NewsNet HD');
  assert.equal(newsnet.reason, 'rule');
});

test('find a channel across an output: every attached source, with its state and why', async () => {
  const find = async (q) => (await api('GET', `/api/outputs/${outputId}/search?q=${encodeURIComponent(q)}`)).data;
  const cats = new Map((await api('GET', `/api/outputs/${outputId}/categories`)).data.map((c) => [c.id, c]));
  const brief = (r) => r.matches.map((m) => [m.name, cats.get(m.category_id).source_id === xcId ? 'xc' : 'm3u', m.included, m.reason]);

  // Case-insensitive, from both sources; the XC news category still has 'starts with "us: newsnet"'.
  let r = await find('NeWsNeT');
  assert.deepEqual(brief(r).sort(), [['NewsNet', 'm3u', true, 'category'], ['US: NewsNet HD', 'xc', true, 'rule']]);
  assert.equal(r.total, 2);
  r = await find('daily news');
  assert.deepEqual(brief(r).filter((m) => m[1] === 'xc'), [['US: Daily News', 'xc', false, 'nomatch']]);
  r = await find('arena sports');
  assert.deepEqual(brief(r), [['UK: Arena Sports', 'xc', false, 'category']], 'channels of excluded categories are found too');
  assert.deepEqual(await find('c'), { matches: [], total: 0 }, 'two characters at least');
  assert.deepEqual((await find('no such channel zz')).matches, []);
  assert.equal((await api('GET', '/api/outputs/99999/search?q=newsnet')).status, 404);
});

test('an excluded category excludes its channels even if picked by hand; picks return when included', async () => {
  const cats = (await api('GET', `/api/outputs/${outputId}/categories`)).data;
  const uk = cats.find((c) => c.name === 'UK| SPORTS' && c.source_id === xcId);
  assert.equal(uk.included, false);
  const sky = (await api('GET', `/api/outputs/${outputId}/channels?category_id=${uk.id}`)).data.channels[0];
  await api('PUT', `/api/outputs/${outputId}/channels`, { ids: [sky.id], state: 'include' });
  const has = async () => (await (await fetch(`${base}/o/${token}/playlist.m3u`)).text()).includes('UK: Arena Sports');
  assert.equal(await has(), false, 'a hand pick cannot pull a channel out of an excluded category');
  const view = (await api('GET', `/api/outputs/${outputId}/channels?category_id=${uk.id}`)).data;
  assert.deepEqual([view.category_included, view.channels[0].included, view.channels[0].override], [false, false, 'include']);

  // Include the category, but exclude its channel by hand: the stored pick applies again.
  await api('PUT', `/api/outputs/${outputId}/channels`, { ids: [sky.id], state: 'exclude' });
  await api('PUT', `/api/outputs/${outputId}/categories`, { ids: [uk.id], state: 'include' });
  assert.equal(await has(), false);
  await api('PUT', `/api/outputs/${outputId}/channels`, { ids: [sky.id], state: null });
  assert.equal(await has(), true);
  await api('PUT', `/api/outputs/${outputId}/categories`, { ids: [uk.id], state: null });
});

test('ends with / does not end with, for categories and channels', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Endings' })).data;
  const r = await api('PUT', `/api/outputs/${o.id}`, {
    source_ids: [xcId],
    rules: [{ action: 'include', op: 'ends_with', value: 'news' }, { action: 'exclude', op: 'not_ends_with', value: 's' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cats = (await api('GET', `/api/outputs/${o.id}/categories`)).data;
  assert.deepEqual(cats.filter((c) => c.included).map((c) => c.name), ['US| NEWS']);

  const news = cats.find((c) => c.name === 'US| NEWS');
  await api('PUT', `/api/outputs/${o.id}/categories/${news.id}/channel-rules`, { rules: [{ action: 'exclude', op: 'not_ends_with', value: ' hd' }] });
  const names = [...(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
  assert.deepEqual(names, ['US: NewsNet HD']);
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('a second output with different criteria and direct mode', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Sports' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId], rules: [{ action: 'include', op: 'contains', value: 'sports' }] });
  const text = await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text();
  const names = [...text.matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
  assert.deepEqual(names, ['UK: Arena Sports', 'US: Sportsline']);
  assert.match(text, /\/live\/xu\/xp\/104\.ts/, 'direct mode hands out provider URLs');
  const list = (await api('GET', '/api/outputs')).data;
  assert.equal(list.length, 2);
});

test('an empty upstream response keeps the previous channels', async () => {
  const saved = xcStreams.splice(0);
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  xcStreams.push(...saved);
  const s = (await api('GET', `/api/sources/${xcId}`)).data;
  assert.equal(s.last_status, 'error');
  assert.equal(s.counts.channels, 6);
});

test('export, then import into a fresh instance, reproduces every output', async () => {
  // A category prefix and suffix on one source of the output, to see it come back.
  const attached = (await api('GET', `/api/outputs/${outputId}`)).data.sources.filter((x) => x.attached).map((x) => x.id);
  await api('PUT', `/api/outputs/${outputId}`, { source_ids: attached, source_affixes: { [xcId]: { cat_prefix: 'UK |', cat_suffix: '[P1]' } } });
  const full = (await api('GET', '/api/export')).data;
  assert.deepEqual(full.outputs.find((x) => x.token === token).category_affixes, [{ source: xcId, prefix: 'UK |', suffix: '[P1]' }]);
  assert.equal(full.format, 'iptv-manager-settings');
  assert.equal(full.sources.find((s) => s.type === 'xc').xc_password, 'xp');
  const bare = (await api('GET', '/api/export?secrets=0')).data;
  assert.equal(bare.sources.find((s) => s.type === 'xc').xc_password, null);
  assert.equal(bare.outputs.find((o) => o.xc_username === 'family').xc_password, null);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-import-'));
  const app2 = createApp({ dataDir: dir2, adminPassword: PASSWORD, log: () => {} });
  const base2 = `http://127.0.0.1:${(await app2.start(0, '127.0.0.1')).port}`;
  try {
    const login = await fetch(`${base2}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie2 = login.headers.get('set-cookie').split(';')[0];
    const post = (body) => fetch(`${base2}/api/import`, {
      method: 'POST', headers: { cookie: cookie2, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(body),
    });
    assert.equal((await post({ format: 'something-else' })).status, 400);
    const r = await post(full);
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await r.json(), { ok: true, sources: 2, outputs: 2 });
    await app2.ctx.jobs.idle();

    // Same tokens, same lineups: names, groups, logos, numbering, tvg ids, category and channel picks.
    const norm = (text, b) => text.split(b).join('BASE').replace(/\/s\/([^/]+)\/\d+\./g, '/s/$1/N.');
    for (const o of full.outputs) {
      const before = norm(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text(), base);
      const after = norm(await (await fetch(`${base2}/o/${o.token}/playlist.m3u`)).text(), base2);
      assert.equal(after, before, `output "${o.name}" differs after import`);
    }
    const restored = await (await fetch(`${base2}/o/${token}/playlist.m3u`)).text();
    assert.match(restored, /group-title="UK \| [^"]+ \[P1\]"/, 'category prefix and suffix restored');
    const o2 = (await (await fetch(`${base2}/api/outputs`, { headers: { cookie: cookie2 } })).json()).find((x) => x.token === token);
    const src2 = (await (await fetch(`${base2}/api/outputs/${o2.id}`, { headers: { cookie: cookie2 } })).json()).sources
      .filter((x) => x.cat_prefix || x.cat_suffix).map((x) => [x.type, x.cat_prefix, x.cat_suffix]);
    assert.deepEqual(src2, [['xc', 'UK |', '[P1]']], 'only on the source it was set on, after the source ids changed');
    const xml = await (await fetch(`${base2}/o/${token}/epg.xml`, { headers: { 'accept-encoding': 'identity' } })).text();
    assert.match(xml, /<category lang="en">Kids<\/category>/, 'Jellyfin tags survive the round trip');
    const info = await (await fetch(`${base2}/player_api.php?username=family&password=pw123`)).json();
    assert.equal(info.user_info.auth, 1);
    // New categories seen for the first time on the imported instance are not flagged "new".
    const cats = await (await fetch(`${base2}/api/sources`, { headers: { cookie: cookie2 } })).json();
    assert.equal(cats.length, 2);
  } finally {
    await app2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
    await api('PUT', `/api/outputs/${outputId}`, { source_ids: attached, source_affixes: { [xcId]: { cat_prefix: '', cat_suffix: '' } } });
  }
});

let hdhrId;
let hdhrToken;

test('HDHomeRun: lineup from the box, guide from the free JSON service when the XMLTV feed is refused', async () => {
  assert.equal((await api('POST', '/api/sources', { name: 'Antenna', type: 'hdhr' })).status, 400);
  assert.equal((await api('POST', '/api/sources', { name: 'Antenna', type: 'hdhr', hdhr_host: 'http://x/y?z' })).status, 400);
  const r = await api('POST', '/api/sources', { name: 'Antenna', type: 'hdhr', hdhr_host: `${up}/hdhr` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  hdhrId = r.data.id;
  await app.ctx.jobs.idle();

  const s = (await api('GET', `/api/sources/${hdhrId}`)).data;
  assert.equal(s.last_status, 'ok', s.last_error);
  assert.equal(s.counts.channels, 3);
  assert.equal(s.counts.categories, 2); // HDHomeRun + HDHomeRun (DRM)
  assert.equal(s.counts.epg_matched, 2); // 13.1 has no listings
  assert.equal(s.account_info.model, 'HDFX-4K');
  assert.equal(s.account_info.tuners, 4);
  assert.match(s.stats.epg.hdhr, /guide service .*XMLTV feed unavailable: HTTP 403/);
  assert.ok(!JSON.stringify(s).includes(HDHR_AUTH), 'DeviceAuth never lands in stored status');
  assert.ok(hdhr.guideRequests >= 2, 'the JSON guide is paged through time');
  assert.equal(s.stats.epg.programmes, 8); // 2 channels x 8 hours of 2-hour shows

  const o = (await api('POST', '/api/outputs', { name: 'OTA' })).data;
  hdhrToken = o.token;
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [hdhrId], include_all: true });
  const m3u = await (await fetch(`${base}/o/${hdhrToken}/playlist.m3u`)).text();
  // Names keep the tuner number so channels sharing a call sign stay distinguishable.
  assert.match(m3u, new RegExp(`tvg-id="2\\.1" tvg-name="2\\.1 WCBS-HD"[^\\n]*tvg-chno="2\\.1" group-title="HDHomeRun",2\\.1 WCBS-HD\\n${up.replace(/\./g, '\\.')}/hdhr/auto/v2\\.1`));
  assert.match(m3u, /group-title="HDHomeRun \(DRM\)",13\.1 PREMIUM/);

  const xml = await (await fetch(`${base}/o/${hdhrToken}/epg.xml`, { headers: { 'accept-encoding': 'identity' } })).text();
  const film = /<programme [^>]*channel="4\.1">(.*?)<\/programme>/.exec(xml)[1];
  assert.match(film, /<title>Big Film 0<\/title><sub-title>Pilot<\/sub-title><desc>About Big Film<\/desc>/);
  // The service says "Movies"; Jellyfin needs "Movie" too.
  assert.match(film, /<category lang="en">Movies<\/category><category lang="en">Movie<\/category>/);
  assert.match(film, /<episode-num system="xmltv_ns">1\.4\.<\/episode-num><episode-num system="onscreen">S02E05<\/episode-num>/);
  assert.match(xml, /<channel id="2\.1"><display-name>2\.1 WCBS-HD<\/display-name>/);
});

test('HDHomeRun: the XMLTV feed is used when available, matched to tuner numbers', async () => {
  hdhr.xmltvAllowed = true;
  const before = hdhr.guideRequests;
  await api('POST', `/api/sources/${hdhrId}/refresh`);
  await app.ctx.jobs.idle();
  const s = (await api('GET', `/api/sources/${hdhrId}`)).data;
  assert.equal(s.last_status, 'ok', s.last_error);
  assert.equal(s.stats.epg.hdhr, 'SiliconDust XMLTV feed');
  assert.equal(hdhr.guideRequests, before, 'no JSON fallback needed');
  // Feed channel ids are opaque; the tuner number is one of their display names.
  assert.equal(s.counts.epg_matched, 2);
  const xml = await (await fetch(`${base}/o/${hdhrToken}/epg.xml`, { headers: { 'accept-encoding': 'identity' } })).text();
  assert.match(xml, /channel="2\.1"><title>Feed News<\/title>/);
  assert.match(xml, /channel="4\.1"><title>Feed Movie<\/title>/);
});

test('HDHomeRun: an unreachable box is a clear error and keeps the last lineup', async () => {
  await api('PUT', `/api/sources/${hdhrId}`, { name: 'Antenna', hdhr_host: '127.0.0.1:9' });
  await app.ctx.jobs.idle();
  const s = (await api('GET', `/api/sources/${hdhrId}`)).data;
  assert.equal(s.last_status, 'error');
  assert.match(s.last_error, /No HDHomeRun answered at http:\/\/127\.0\.0\.1:9/);
  assert.equal(s.counts.channels, 3);
});

test('hide empty event channels: per-category toggle, editable patterns, backup round trip', async () => {
  xcCats.push({ category_id: '20', category_name: 'US| MATCH EVENTS' });
  const events = ['Match 01:', 'Match 02: Team A vs Team B', 'Match 03 -', 'Match 04', 'Match 05 NO EVENT', 'Match 06: Team C - Team D'];
  events.forEach((name, i) => xcStreams.push({ num: 50 + i, name, stream_id: 500 + i, epg_channel_id: '', category_id: '20' }));
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();

  const o = (await api('POST', '/api/outputs', { name: 'Events' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId], rules: [{ action: 'include', op: 'contains', value: 'match events' }] });
  const cat = (await api('GET', `/api/outputs/${o.id}/categories`)).data.find((c) => c.name === 'US| MATCH EVENTS');
  const names = async () => [...(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
  assert.equal((await names()).length, 6, 'off by default');

  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_empty: true });
  assert.deepEqual(await names(), ['Match 02: Team A vs Team B', 'Match 06: Team C - Team D']);
  const view = (await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data;
  assert.equal(view.hide_empty, true);
  assert.deepEqual(view.channels.filter((c) => c.reason === 'empty').map((c) => c.name), ['Match 01:', 'Match 03 -', 'Match 04', 'Match 05 NO EVENT']);

  // A hand pick still wins over the toggle.
  const idle = view.channels.find((c) => c.name === 'Match 04');
  await api('PUT', `/api/outputs/${o.id}/channels`, { ids: [idle.id], state: 'include' });
  assert.ok((await names()).includes('Match 04'));
  await api('PUT', `/api/outputs/${o.id}/channels`, { ids: [idle.id], state: null });

  // Edit the patterns: drop "ends with a number", keep the rest.
  assert.equal((await api('PUT', '/api/settings', { empty_event_patterns: ['('] })).status, 400);
  const s = await api('PUT', '/api/settings', { empty_event_patterns: [':\\s*$', '-\\s*$', 'no event\\s*$'] });
  assert.equal(s.status, 200);
  assert.deepEqual(await names(), ['Match 02: Team A vs Team B', 'Match 04', 'Match 06: Team C - Team D']);
  const settings = (await api('GET', '/api/settings')).data;
  assert.equal(settings.empty_event_patterns.length, 3);
  assert.equal(settings.base_url, '', 'saving patterns leaves other settings alone');

  // Export keeps both the custom patterns and the toggle; a fresh instance reproduces the output.
  const exported = (await api('GET', '/api/export')).data;
  assert.deepEqual(exported.settings.empty_event_patterns, [':\\s*$', '-\\s*$', 'no event\\s*$']);
  assert.deepEqual(exported.outputs.find((x) => x.token === o.token).category_options, [{ source: xcId, category: 'US| MATCH EVENTS', hide_empty: true, hide_by_guide: false, hide_unlisted: false, unlisted_hours: 24 }]);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-import2-'));
  const app2 = createApp({ dataDir: dir2, adminPassword: PASSWORD, log: () => {} });
  const base2 = `http://127.0.0.1:${(await app2.start(0, '127.0.0.1')).port}`;
  try {
    const login = await fetch(`${base2}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie2 = login.headers.get('set-cookie').split(';')[0];
    const r = await fetch(`${base2}/api/import`, { method: 'POST', headers: { cookie: cookie2, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(exported) });
    assert.equal(r.status, 200, await r.clone().text());
    await app2.ctx.jobs.idle();
    const after = [...(await (await fetch(`${base2}/o/${o.token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
    assert.deepEqual(after, await names());
  } finally {
    await app2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // null restores the defaults.
  await api('PUT', '/api/settings', { empty_event_patterns: null });
  assert.deepEqual(await names(), ['Match 02: Team A vs Team B', 'Match 06: Team C - Team D']);
});

test('export/import of empty-event settings: defaults, empty list, old files, bad files', async () => {
  // A fresh instance to import into, reset for each case.
  const fresh = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-ee-'));
    const a = createApp({ dataDir: dir, adminPassword: PASSWORD, log: () => {} });
    const b = `http://127.0.0.1:${(await a.start(0, '127.0.0.1')).port}`;
    const login = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie2 = login.headers.get('set-cookie').split(';')[0];
    const call = async (method, p, body) => {
      const r = await fetch(b + p, { method, headers: { cookie: cookie2, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: body && JSON.stringify(body) });
      return { status: r.status, data: await r.json() };
    };
    return { a, b, call, close: async () => { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  };
  const names = async (b, tok) => [...(await (await fetch(`${b}/o/${tok}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);

  // 1. Defaults export as null, so a restore follows the built-in defaults.
  await api('PUT', '/api/settings', { empty_event_patterns: null });
  let file = (await api('GET', '/api/export')).data;
  assert.equal(file.settings.empty_event_patterns, null);
  const events = file.outputs.find((o) => o.name === 'Events');
  assert.deepEqual(events.category_options, [{ source: xcId, category: 'US| MATCH EVENTS', hide_empty: true, hide_by_guide: false, hide_unlisted: false, unlisted_hours: 24 }]);

  // 2. The toggle's category does not exist on the new instance until its first refresh;
  //    the import creates it as a placeholder and the toggle applies once channels arrive.
  let t = await fresh();
  try {
    const custom = await t.call('PUT', '/api/settings', { empty_event_patterns: ['x$'] });
    assert.equal(custom.status, 200);
    assert.equal((await t.call('POST', '/api/import', file)).status, 200);
    await t.a.ctx.jobs.idle();
    assert.equal((await t.call('GET', '/api/settings')).data.empty_event_patterns.length, 4, 'defaults restored over the custom list');
    assert.deepEqual(await names(t.b, events.token), ['Match 02: Team A vs Team B', 'Match 06: Team C - Team D']);
  } finally {
    await t.close();
  }

  // 3. An empty list round-trips as "no patterns": the toggle then hides nothing.
  await api('PUT', '/api/settings', { empty_event_patterns: [] });
  file = (await api('GET', '/api/export')).data;
  assert.deepEqual(file.settings.empty_event_patterns, []);
  t = await fresh();
  try {
    assert.equal((await t.call('POST', '/api/import', file)).status, 200);
    await t.a.ctx.jobs.idle();
    assert.deepEqual((await t.call('GET', '/api/settings')).data.empty_event_patterns, []);
    assert.equal((await names(t.b, events.token)).length, 6);
  } finally {
    await t.close();
    await api('PUT', '/api/settings', { empty_event_patterns: null });
  }

  // 4. A file from before these settings existed restores the defaults, and toggles are simply off.
  const old = JSON.parse(JSON.stringify(file));
  delete old.settings.empty_event_patterns;
  for (const o of old.outputs) delete o.category_options;
  t = await fresh();
  try {
    await t.call('PUT', '/api/settings', { empty_event_patterns: ['x$'] });
    assert.equal((await t.call('POST', '/api/import', old)).status, 200);
    await t.a.ctx.jobs.idle();
    assert.equal((await t.call('GET', '/api/settings')).data.empty_event_patterns.length, 4);
    assert.equal((await names(t.b, events.token)).length, 6);
  } finally {
    await t.close();
  }

  // 5. Bad files are rejected before anything is replaced.
  t = await fresh();
  try {
    const bad1 = { ...file, settings: { ...file.settings, empty_event_patterns: ['('] } };
    const bad2 = JSON.parse(JSON.stringify(file));
    bad2.outputs[0].category_options = [{ source: 999, category: 'X', hide_empty: true }];
    for (const bad of [bad1, bad2]) {
      const r = await t.call('POST', '/api/import', bad);
      assert.equal(r.status, 400, JSON.stringify(r.data));
      assert.match(r.data.error, /Invalid settings file/);
    }
    assert.equal((await t.call('GET', '/api/outputs')).data.length, 0, 'nothing imported');
  } finally {
    await t.close();
  }
});

test('hide channels by guide: title airing now, separate from the name toggle, clock-driven, backed up', async () => {
  xcCats.push({ category_id: '30', category_name: 'US| Gameday SUNDAY' });
  xcStreams.push(
    { num: 70, name: 'Gameday 01', stream_id: 700, epg_channel_id: 'gameday1', category_id: '30' },
    { num: 71, name: 'Gameday 02', stream_id: 701, epg_channel_id: 'gameday2', category_id: '30' },
    { num: 72, name: 'Gameday 03', stream_id: 702, epg_channel_id: '', category_id: '30' }, // no guide at all
    { num: 73, name: 'Gameday 04', stream_id: 703, epg_channel_id: 'gameday4', category_id: '30' },
  );
  eventGuide.push({ id: 'gameday1', title: 'No Game Today' }, { id: 'gameday2', title: 'Team C at Team D' }, { id: 'gameday4', title: 'Off Air' });
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();

  const o = (await api('POST', '/api/outputs', { name: 'Gameday' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId], rules: [{ action: 'include', op: 'contains', value: 'gameday' }] });
  const cat = (await api('GET', `/api/outputs/${o.id}/categories`)).data.find((c) => c.name === 'US| Gameday SUNDAY');
  const names = async () => [...(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
  assert.deepEqual(await names(), ['Gameday 01', 'Gameday 02', 'Gameday 03', 'Gameday 04'], 'off by default');

  // The panel shows what is on now even before the toggle is on.
  let view = (await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data;
  assert.deepEqual(view.channels.map((c) => [c.name, c.now_title, c.is_guide_placeholder]),
    [['Gameday 01', 'No Game Today', true], ['Gameday 02', 'Team C at Team D', false], ['Gameday 03', null, false], ['Gameday 04', 'Off Air', true]]);

  // Separate toggle: guide on, names off (these names end in numbers, which the name toggle would hide).
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_by_guide: true });
  assert.deepEqual(await names(), ['Gameday 02', 'Gameday 03'], 'placeholders hidden; no listing means not hidden');
  view = (await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data;
  assert.deepEqual([view.hide_by_guide, view.hide_empty], [true, false]);
  assert.equal(view.channels.find((c) => c.name === 'Gameday 01').reason, 'guide');
  const xml = await (await fetch(`${base}/o/${o.token}/epg.xml`, { headers: { 'accept-encoding': 'identity' } })).text();
  assert.ok(!xml.includes('channel="gameday1"') && xml.includes('channel="gameday2"'), 'the guide output follows the playlist');

  // Turning on the name toggle too does not undo the guide one (partial update of options).
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_empty: true });
  assert.deepEqual(await names(), []);
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_empty: false });

  // The clock: once the placeholder's slot has ended, the channel returns without any refresh.
  const src = app.ctx.db.get('SELECT epg_gen FROM sources WHERE id = ?', [xcId]);
  const t = Math.floor(Date.now() / 1000);
  app.ctx.db.run('UPDATE programmes SET stop_ts = ? WHERE source_id = ? AND gen = ? AND channel = ?', [t - 1, xcId, src.epg_gen, 'gameday1']);
  app.ctx.bump(); // stands in for the one-minute cache expiring
  assert.deepEqual(await names(), ['Gameday 01', 'Gameday 02', 'Gameday 03']);

  // Hand picks win; custom patterns apply; settings are partial.
  const gameday4 = view.channels.find((c) => c.name === 'Gameday 04');
  await api('PUT', `/api/outputs/${o.id}/channels`, { ids: [gameday4.id], state: 'include' });
  assert.ok((await names()).includes('Gameday 04'));
  await api('PUT', `/api/outputs/${o.id}/channels`, { ids: [gameday4.id], state: null });
  assert.equal((await api('PUT', '/api/settings', { guide_patterns: ['['] })).status, 400);
  await api('PUT', '/api/settings', { guide_patterns: ['^team c'] });
  assert.deepEqual(await names(), ['Gameday 01', 'Gameday 03', 'Gameday 04']);
  const s = (await api('GET', '/api/settings')).data;
  assert.deepEqual([s.guide_patterns, s.empty_event_patterns.length], [['^team c'], 4]);

  // Backup: guide patterns and the toggle travel with the export.
  const file = (await api('GET', '/api/export')).data;
  assert.deepEqual(file.settings.guide_patterns, ['^team c']);
  assert.deepEqual(file.outputs.find((x) => x.token === o.token).category_options,
    [{ source: xcId, category: 'US| Gameday SUNDAY', hide_empty: false, hide_by_guide: true, hide_unlisted: false, unlisted_hours: 24 }]);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-guide-'));
  const app2 = createApp({ dataDir: dir2, adminPassword: PASSWORD, log: () => {} });
  const base2 = `http://127.0.0.1:${(await app2.start(0, '127.0.0.1')).port}`;
  try {
    const login = await fetch(`${base2}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ password: PASSWORD }) });
    const c2 = login.headers.get('set-cookie').split(';')[0];
    const r = await fetch(`${base2}/api/import`, { method: 'POST', headers: { cookie: c2, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(file) });
    assert.equal(r.status, 200, await r.clone().text());
    await app2.ctx.jobs.idle();
    // Fresh guide data on the new instance: gameday2 ("Team C at Team D") matches ^team c and is hidden.
    const after = [...(await (await fetch(`${base2}/o/${o.token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
    assert.deepEqual(after, ['Gameday 01', 'Gameday 03', 'Gameday 04']);
  } finally {
    await app2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  }
  await api('PUT', '/api/settings', { guide_patterns: null });
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('hide channels with nothing listed in the next N hours: sub-option of the guide toggle, with a stale-guide safety net', async () => {
  xcCats.push({ category_id: '31', category_name: 'US| Hoops LEAGUE PASS' });
  xcStreams.push(
    { num: 80, name: 'Hoops 01', stream_id: 800, epg_channel_id: 'hoops1', category_id: '31' }, // game on now
    { num: 81, name: 'Hoops 02', stream_id: 801, epg_channel_id: 'hoops2', category_id: '31' }, // game later tonight
    { num: 82, name: 'Hoops 03', stream_id: 802, epg_channel_id: 'hoops3', category_id: '31' }, // listed, no programs
    { num: 83, name: 'Hoops 04', stream_id: 803, epg_channel_id: 'hoops4', category_id: '31' }, // guide id unknown to the guide
    { num: 84, name: 'Hoops 05', stream_id: 804, epg_channel_id: '', category_id: '31' }, // no guide id at all
    { num: 85, name: 'Hoops 06', stream_id: 805, epg_channel_id: 'hoops6', category_id: '31' }, // blank title now
    { num: 86, name: 'Hoops 07', stream_id: 806, epg_channel_id: 'hoops7', category_id: '31' }, // game the day after tomorrow
  );
  eventGuide.push(
    { id: 'hoops1', title: 'Team A at Team B' },
    { id: 'hoops2', title: 'Knicks at City Chase', fromH: 2, toH: 4 },
    { id: 'hoops3', channelOnly: true },
    { id: 'hoops6', title: '' },
    { id: 'hoops7', title: 'Bulls at Suns', fromH: 30, toH: 33 },
  );
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();

  const o = (await api('POST', '/api/outputs', { name: 'Hoops' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId], rules: [{ action: 'include', op: 'contains', value: 'hoops' }] });
  const cat = (await api('GET', `/api/outputs/${o.id}/categories`)).data.find((c) => c.name === 'US| Hoops LEAGUE PASS');
  const names = async () => [...(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
  const all = ['Hoops 01', 'Hoops 02', 'Hoops 03', 'Hoops 04', 'Hoops 05', 'Hoops 06', 'Hoops 07'];

  // The sub-option does nothing without the guide toggle, and the guide toggle alone hides nothing here.
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_unlisted: true });
  assert.deepEqual(await names(), all);
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_by_guide: true, hide_unlisted: false });
  assert.deepEqual(await names(), all);

  // Looking 24 hours ahead by default: the game on now, the one tonight, and the channel with no
  // guide id stay; empty guides, a blank title and the game in 30 hours go.
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_unlisted: true });
  assert.deepEqual(await names(), ['Hoops 01', 'Hoops 02', 'Hoops 05']);
  let view = (await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data;
  assert.deepEqual([view.hide_by_guide, view.hide_unlisted, view.unlisted_hours, view.guide_current], [true, true, 24, true]);
  assert.deepEqual(view.channels.map((c) => [c.name, c.is_unlisted, c.reason]), [
    ['Hoops 01', false, 'category'], ['Hoops 02', false, 'category'], ['Hoops 03', true, 'unlisted'],
    ['Hoops 04', true, 'unlisted'], ['Hoops 05', false, 'category'], ['Hoops 06', true, 'unlisted'], ['Hoops 07', true, 'unlisted'],
  ]);
  // Nothing on now: the next listing within the look-ahead is reported (so it's clear why it stays).
  const hoops2 = view.channels.find((c) => c.name === 'Hoops 02');
  assert.equal(hoops2.next.title, 'Knicks at City Chase');
  assert.ok(Math.abs(hoops2.next.start - (Date.now() / 1000 + 2 * 3600)) < 120);
  assert.equal(view.channels.find((c) => c.name === 'Hoops 01').next, null, 'on now: no "next"');

  // The look-ahead is per category and changeable: 1 hour drops tonight's game, 48 brings in the later one.
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { unlisted_hours: 1 });
  assert.deepEqual(await names(), ['Hoops 01', 'Hoops 05']);
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { unlisted_hours: 48 });
  assert.deepEqual(await names(), ['Hoops 01', 'Hoops 02', 'Hoops 05', 'Hoops 07']);
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { unlisted_hours: 9999 });
  view = (await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data;
  assert.equal(view.unlisted_hours, 168, 'at most a week');
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { unlisted_hours: 24 });

  // Hand picks still win.
  const hoops3 = view.channels.find((c) => c.name === 'Hoops 03');
  await api('PUT', `/api/outputs/${o.id}/channels`, { ids: [hoops3.id], state: 'include' });
  assert.ok((await names()).includes('Hoops 03'));
  await api('PUT', `/api/outputs/${o.id}/channels`, { ids: [hoops3.id], state: null });

  // Safety net: if the source's guide has nothing airing now for any channel (it ran out or
  // failed to refresh), nothing is hidden as "unlisted".
  const gen = app.ctx.db.get('SELECT epg_gen FROM sources WHERE id = ?', [xcId]).epg_gen;
  const t = Math.floor(Date.now() / 1000);
  app.ctx.db.run('UPDATE programmes SET stop_ts = ? WHERE source_id = ? AND gen = ? AND start_ts <= ?', [t - 1, xcId, gen, t]);
  app.ctx.bump();
  assert.deepEqual(await names(), all);
  assert.equal((await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data.guide_current, false);

  // Backed up with the other switches.
  const file = (await api('GET', '/api/export')).data;
  assert.deepEqual(file.outputs.find((x) => x.token === o.token).category_options,
    [{ source: xcId, category: 'US| Hoops LEAGUE PASS', hide_empty: false, hide_by_guide: true, hide_unlisted: true, unlisted_hours: 24 }]);
  // Restore the guide for later tests.
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('guide logos fill in missing channel logos, only when the advanced setting is on', async () => {
  xcCats.push({ category_id: '32', category_name: 'US| LOGOS' });
  xcStreams.push(
    { num: 90, name: 'Logo Missing', stream_id: 900, stream_icon: '', epg_channel_id: 'logo1', category_id: '32' },
    { num: 91, name: 'Logo Own', stream_id: 901, stream_icon: 'http://provider/own.png', epg_channel_id: 'logo2', category_id: '32' },
  );
  eventGuide.push({ id: 'logo1', title: 'Show', icon: 'http://guide/logo1.png' }, { id: 'logo2', title: 'Show', icon: 'http://guide/logo2.png' });
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  const o = (await api('POST', '/api/outputs', { name: 'Logos' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId], rules: [{ action: 'include', op: 'equals', value: 'us| logos' }] });
  const logos = async () => Object.fromEntries([...(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text())
    .matchAll(/tvg-logo="([^"]*)"[^\n]*,([^\n]+)\n/g)].map((m) => [m[2], m[1]]));

  assert.equal((await api('GET', '/api/settings')).data.guide_logo_fallback, false, 'off by default');
  assert.deepEqual(await logos(), { 'Logo Missing': '', 'Logo Own': 'http://provider/own.png' });
  await api('PUT', '/api/settings', { guide_logo_fallback: true, advanced: true });
  assert.deepEqual(await logos(), { 'Logo Missing': 'http://guide/logo1.png', 'Logo Own': 'http://provider/own.png' }, 'provider logos still win');
  const xc = await (await fetch(`${base}/player_api.php?username=family&password=pw123&action=get_live_streams`)).json();
  assert.ok(Array.isArray(xc));
  const file = (await api('GET', '/api/export')).data;
  assert.deepEqual([file.settings.advanced, file.settings.guide_logo_fallback], [true, true]);
  await api('PUT', '/api/settings', { guide_logo_fallback: false, advanced: false });
  assert.equal((await logos())['Logo Missing'], '');
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('name cleanup: per-output find/replace on channel and category names, in every format', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Tidy' })).data;
  await api('PUT', `/api/outputs/${o.id}`, {
    source_ids: [xcId], rules: [{ action: 'include', op: 'equals', value: 'us| news' }],
    xc_enabled: true, xc_username: 'tidy', xc_password: 'pw',
  });
  const m3u = async () => [...(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text())
    .matchAll(/tvg-name="([^"]*)".*group-title="([^"]*)",([^\n]+)\n/g)].map((m) => [m[1], m[2], m[3]]);
  const before = await m3u();
  assert.deepEqual(before.map((r) => r[2]).sort(), ['US: Daily News', 'US: NewsNet HD']);

  const rules = [
    { scope: 'both', find: '^\\|?[A-Z]{2,3}\\s*[|:\\-]\\s*', replace: '' },
    { scope: 'channel', find: '\\s*\\b(?:HD|FHD)\\b', replace: '' },
    { scope: 'category', find: '^NEWS$', replace: 'News & Talk' },
  ];
  // Preview first: nothing is saved yet.
  let r = await api('POST', `/api/outputs/${o.id}/name-preview`, { rules });
  assert.deepEqual([r.data.channels.changed, r.data.channels.total, r.data.categories.changed, r.data.categories.total], [2, 2, 1, 1]);
  assert.deepEqual(r.data.categories.samples, [['US| NEWS', 'News & Talk']]);
  assert.deepEqual(r.data.channels.samples.find((s) => s[0] === 'US: NewsNet HD'), ['US: NewsNet HD', 'NewsNet']);
  assert.deepEqual(await m3u(), before);
  r = await api('POST', `/api/outputs/${o.id}/name-preview`, { rules: [{ scope: 'channel', find: '(', replace: '' }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Not a valid pattern: \( \(Unterminated group\)/);
  assert.equal((await api('PUT', `/api/outputs/${o.id}`, { name_rules: [{ scope: 'nope', find: 'x' }] })).status, 400);

  r = await api('PUT', `/api/outputs/${o.id}`, { name_rules: rules });
  assert.deepEqual(r.data.name_rules, rules.map((x) => ({ ...x, media: 'live' })), 'rules without a target are live TV');
  assert.deepEqual((await m3u()).sort(), [['Daily News', 'News & Talk', 'Daily News'], ['NewsNet', 'News & Talk', 'NewsNet']]);
  const xc = (action) => fetch(`${base}/player_api.php?username=tidy&password=pw&action=${action}`).then((x) => x.json());
  assert.deepEqual((await xc('get_live_categories')).map((c) => c.category_name), ['News & Talk']);
  assert.deepEqual((await xc('get_live_streams')).map((s) => s.name).sort(), ['Daily News', 'NewsNet']);
  assert.match(await (await fetch(`${base}/o/${o.token}/epg.xml`)).text(), /<display-name>NewsNet<\/display-name>/);

  // A name set by hand wins; saving other settings leaves the rules alone.
  const newsnet = (await api('GET', `/api/sources/${xcId}/channels?q=newsnet`)).data.items.find((c) => c.name === 'US: NewsNet HD');
  const edits = { custom_logo: newsnet.custom_logo, custom_epg_id: newsnet.custom_epg_id, custom_chno: newsnet.custom_chno };
  await api('PUT', `/api/channels/${newsnet.id}`, { ...edits, custom_name: 'US: NewsNet HD (mine)' });
  await api('PUT', `/api/outputs/${o.id}`, { name: 'Tidy 2' });
  assert.ok((await m3u()).some((x) => x[2] === 'US: NewsNet HD (mine)'));
  assert.equal((await api('GET', `/api/outputs/${o.id}`)).data.name_rules.length, 3);
  await api('PUT', `/api/channels/${newsnet.id}`, { ...edits, custom_name: newsnet.custom_name });

  // Backed up with the output, and checked on import.
  const file = (await api('GET', '/api/export')).data;
  const saved = file.outputs.find((x) => x.token === o.token);
  assert.deepEqual(saved.name_rules, rules.map((x) => ({ ...x, media: 'live' })));
  saved.name_rules = [{ scope: 'channel', find: '[', replace: '' }];
  r = await api('POST', '/api/import', file);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /output "Tidy 2": Not a valid pattern/);
  assert.equal((await api('GET', `/api/outputs/${o.id}`)).status, 200, 'a rejected import changes nothing');

  await api('PUT', `/api/outputs/${o.id}`, { name_rules: [] });
  assert.deepEqual((await m3u()).map((x) => x[2]).sort(), ['US: Daily News', 'US: NewsNet HD']);
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('category prefix and suffix per source in an output: around renamed and cleaned names, kept, copied, backed up', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Affixes' })).data;
  let r = await api('PUT', `/api/outputs/${o.id}`, {
    source_ids: [xcId, m3uId], rules: [{ action: 'include', op: 'equals', value: 'us| news' }],
    source_affixes: { [xcId]: { cat_prefix: '  UK   | ', cat_suffix: '[Provider\nA]' }, [m3uId]: { cat_prefix: 'x'.repeat(60) } },
  });
  assert.equal(r.status, 200);
  const view = (d) => Object.fromEntries(d.sources.filter((x) => [xcId, m3uId].includes(x.id)).map((x) => [x.id, [x.attached, x.cat_prefix, x.cat_suffix]]));
  assert.deepEqual(view(r.data), { [xcId]: [true, 'UK |', '[Provider A]'], [m3uId]: [true, 'x'.repeat(40), ''] }, 'one line, trimmed, 40 characters at most');
  const groups = async (token = o.token) => [...new Set([...(await (await fetch(`${base}/o/${token}/playlist.m3u`)).text())
    .matchAll(/group-title="([^"]*)"/g)].map((m) => m[1]))];
  // Both sources have a "US| NEWS"; now players can tell them apart.
  const X = 'x'.repeat(40);
  assert.deepEqual(await groups(), ['UK | US| NEWS [Provider A]', `${X} US| NEWS`]);

  // Around the name after cleanup, and around a name set by hand.
  await api('PUT', `/api/outputs/${o.id}`, { name_rules: [{ scope: 'category', find: '^US\\| ', replace: '' }] });
  assert.deepEqual(await groups(), ['UK | NEWS [Provider A]', `${X} NEWS`]);
  const news = (await api('GET', `/api/outputs/${o.id}/categories`)).data.find((c) => c.name === 'US| NEWS' && c.source_id === xcId);
  await api('PUT', `/api/categories/${news.id}`, { custom_name: 'News' });
  assert.deepEqual(await groups(), ['UK | News [Provider A]', `${X} NEWS`]);
  const live = await (await fetch(`${base}/player_api.php?username=family&password=pw123&action=get_live_categories`)).json();
  assert.ok(Array.isArray(live));

  // Kept when the source list is saved without them (re-ordered here); copied with the output; backed up.
  r = await api('PUT', `/api/outputs/${o.id}`, { source_ids: [m3uId, xcId] });
  assert.deepEqual(view(r.data)[xcId], [true, 'UK |', '[Provider A]']);
  const dupe = (await api('POST', `/api/outputs/${o.id}/clone`)).data;
  assert.deepEqual(await groups(dupe.token), [`${X} NEWS`, 'UK | News [Provider A]']);
  const saved = (await api('GET', '/api/export')).data.outputs.find((x) => x.name === 'Affixes');
  assert.deepEqual(saved.category_affixes.find((a) => a.source === xcId), { source: xcId, prefix: 'UK |', suffix: '[Provider A]' });

  // Detaching drops them; cleared ones go away.
  r = await api('PUT', `/api/outputs/${o.id}`, { source_ids: [m3uId], source_affixes: { [xcId]: { cat_prefix: 'Z', cat_suffix: '' } } });
  assert.deepEqual(view(r.data)[xcId], [false, '', '']);
  r = await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId] });
  assert.deepEqual(view(r.data)[xcId], [true, '', '']);
  assert.deepEqual(await groups(), ['News']);
  await api('PUT', `/api/categories/${news.id}`, { custom_name: '' });
  await api('DELETE', `/api/outputs/${dupe.id}`);
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('proxy mode: viewers of a channel share one upstream stream; a source is capped at its connection limit', async () => {
  xcCats.push({ category_id: '33', category_name: 'US| LIVE' });
  xcStreams.push(...[950, 951, 952].map((id, i) => ({ num: 95 + i, name: `Live ${i + 1}`, stream_id: id, stream_icon: '', epg_channel_id: '', category_id: '33' })));
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  const o = (await api('POST', '/api/outputs', { name: 'Live' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { stream_mode: 'proxy', source_ids: [xcId], rules: [{ action: 'include', op: 'equals', value: 'us| live' }] });
  const urls = (await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text()).split('\n').filter((l) => l.startsWith('http'));
  assert.equal(urls.length, 3);
  const until = async (cond, what) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(cond(), what);
  };
  // A viewer: the response, a reader that has received data, and a way to hang up.
  const watch = async (url) => {
    const ac = new AbortController();
    const r = await fetch(url, { signal: ac.signal });
    if (r.status !== 200) return { status: r.status, text: await r.text() };
    const reader = r.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    return { status: 200, first, stop: () => { ac.abort(); reader.cancel().catch(() => {}); } };
  };
  const streams = async () => (await api('GET', `/api/sources/${xcId}`)).data.streams;
  // The source form sends every field; a blank password keeps the stored one.
  const setMax = async (id, max) => {
    const src = (await api('GET', `/api/sources/${id}`)).data;
    assert.equal((await api('PUT', `/api/sources/${id}`, { ...src, max_streams: max })).status, 200);
  };
  const before = live.requests;

  const a = await watch(urls[0]);
  const b = await watch(urls[0]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.match(a.first + b.first, /chunk-950;/);
  assert.equal(live.requests - before, 1, 'two viewers, one upstream connection');
  assert.deepEqual(await streams(), { open: 1, limit: 2, auto: 2, refused: null }, 'the limit comes from the XC account (max_connections 2)');

  const c = await watch(urls[1]);
  assert.equal(c.status, 200);
  const d = await watch(urls[2]);
  assert.equal(d.status, 503, 'a third channel is over the limit');
  assert.match(d.text, /All 2 streams for this source are in use/);
  const b2 = await watch(urls[0]);
  assert.equal(b2.status, 200, 'more viewers of a channel already open are always let in');
  b2.stop();

  // The upstream stays open while anyone watches, and closes with the last viewer.
  a.stop();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(live.open.get('950'), 1);
  b.stop();
  await until(() => live.open.get('950') === 0, 'upstream closed after the last viewer left');
  const e = await watch(urls[2]);
  assert.equal(e.status, 200, 'the freed slot can be used');
  e.stop();
  c.stop();
  await until(() => live.open.get('951') === 0 && live.open.get('952') === 0, 'all upstreams closed');

  // Set by hand: 0 = no limit, a number overrides the account, blank goes back to automatic.
  await setMax(xcId, 0);
  const all = await Promise.all(urls.map(watch));
  assert.deepEqual(all.map((x) => x.status), [200, 200, 200]);
  assert.deepEqual(await streams(), { open: 3, limit: 0, auto: 2, refused: null });
  all.forEach((x) => x.stop());
  await until(() => [...live.open.values()].every((n) => n === 0), 'all upstreams closed');
  await setMax(xcId, 1);
  const one = await watch(urls[0]);
  assert.equal((await watch(urls[1])).status, 503);
  one.stop();
  const file = (await api('GET', '/api/export')).data;
  assert.equal(file.sources.find((x) => x.ref === xcId).max_streams, 1);
  await setMax(xcId, '');
  assert.equal((await api('GET', `/api/sources/${xcId}`)).data.max_streams, null);

  // HLS channels count while their playlist or segments are being fetched.
  await setMax(m3uId, 1);
  const o2 = (await api('POST', '/api/outputs', { name: 'HLS' })).data;
  await api('PUT', `/api/outputs/${o2.id}`, { stream_mode: 'proxy', source_ids: [m3uId], rules: [{ action: 'include', op: 'equals', value: 'uk| general' }] });
  const lines = (await (await fetch(`${base}/o/${o2.token}/playlist.m3u`)).text()).split('\n').filter((l) => l.startsWith('http'));
  const bbc = lines.find((l) => l.endsWith('.m3u8'));
  const other = lines.find((l) => l.endsWith('.ts'));
  assert.ok(bbc && other, lines.join('\n'));
  assert.equal((await fetch(bbc)).status, 200);
  assert.equal((await fetch(other)).status, 503, 'the HLS channel holds the only slot');
  assert.equal((await fetch(bbc)).status, 200);
  await api('DELETE', `/api/outputs/${o2.id}`);
  await setMax(m3uId, '');
  app.ctx.streams.hls.clear();

  // Redirect mode can't be counted: nothing is refused.
  await setMax(xcId, 1);
  await api('PUT', `/api/outputs/${o.id}`, { stream_mode: 'redirect' });
  const r = await Promise.all(urls.map((u) => fetch(u, { redirect: 'manual' })));
  assert.deepEqual(r.map((x) => x.status), [302, 302, 302]);
  await setMax(xcId, '');
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('light streams: a 720p copy made by ffmpeg while watched, shared, capped, stopped when the last viewer leaves', async () => {
  const light = app.ctx.light;
  const ffmpegLog = path.join(os.tmpdir(), `iptvm-fake-ffmpeg-${process.pid}.log`);
  fs.rmSync(ffmpegLog, { force: true });
  process.env.FAKE_FFMPEG_LOG = ffmpegLog;
  const realCmd = light.cmd;
  light.cmd = [process.execPath, fileURLToPath(new URL('./fake-ffmpeg.mjs', import.meta.url))];
  light.reset();
  const runs = () => (fs.existsSync(ffmpegLog) ? fs.readFileSync(ffmpegLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
    .filter((a) => a.includes('pipe:1') && !a.includes('lavfi'));
  const until = async (cond, what) => {
    for (let i = 0; i < 150 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(cond(), what);
  };
  const watch = async (url) => {
    const ac = new AbortController();
    const r = await fetch(url, { signal: ac.signal });
    if (r.status !== 200) return { status: r.status, text: await r.text() };
    const reader = r.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    return { status: 200, first, stop: () => { ac.abort(); reader.cancel().catch(() => {}); } };
  };
  const o = (await api('POST', '/api/outputs', { name: 'Multi' })).data;
  try {
    await api('PUT', `/api/outputs/${o.id}`, {
      stream_mode: 'proxy', source_ids: [xcId], xc_enabled: true, xc_username: 'multi', xc_password: 'mv',
      rules: [{ action: 'include', op: 'equals', value: 'us| live' }],
    });
    const playlist = async (url = `${base}/o/${o.token}/playlist.m3u`) => (await fetch(url)).text();
    const lightsOf = (text) => [...text.matchAll(/tileiptv-light="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(lightsOf(await playlist()), [], 'off by default');
    const chId = Number((await playlist()).split('\n').find((l) => l.startsWith('http')).match(/\/(\d+)\.ts$/)[1]);
    assert.equal((await fetch(`${base}/light/${o.token}/${chId}.ts`)).status, 404, 'no light copies from an output that does not offer them');
    const ignored = await fetch(`${base}/s/${o.token}/${chId}.ts?light=1`);
    const ignoredReader = ignored.body.getReader();
    const firstRead = await ignoredReader.read();
    assert.equal(ignored.status, 200);
    assert.match(new TextDecoder().decode(firstRead.value), /^chunk-950;/, '?light=1 is ignored there: the original is sent');
    assert.equal(light.jobs.size, 0);
    await ignoredReader.cancel().catch(() => {});
    await until(() => live.open.get('950') === 0, 'its provider connection closed');

    let r = await api('PUT', `/api/outputs/${o.id}`, { light_enabled: true });
    assert.equal(r.data.light_enabled, true);
    const text = await playlist();
    const lights = lightsOf(text);
    assert.equal(lights.length, 3);
    assert.equal(lights[0], `${base}/light/${o.token}/${chId}.ts`);
    assert.match(text, /group-title="[^"]*" tileiptv-light="[^"]+",Live 1\n/, 'on the #EXTINF line, before the name');
    const xcLights = lightsOf(await playlist(`${base}/get.php?username=multi&password=mv`));
    assert.equal(xcLights[0], `${base}/light/multi/mv/${chId}.ts`, 'an Xtream Codes login gets links with its own credentials');
    assert.deepEqual(lightsOf(await playlist(`${base}/o/${token}/playlist.m3u`)), [], 'other outputs are unchanged');

    let st = (await api('GET', '/api/light')).data;
    assert.deepEqual([st.ffmpeg, st.setting, st.encoder, st.max, st.active], ['7.1-fake', 'auto', 'software', 4, []], 'no GPU here: software');

    // A light viewer and a full-quality viewer of the same channel: one provider connection.
    const provider = ['950', '951', '952']; // the provider's stream ids of Live 1, 2 and 3
    const fullUrls = text.split('\n').filter((l) => l.startsWith('http'));
    const before = live.requests;
    const a = await watch(lights[0]);
    assert.equal(a.status, 200);
    assert.match(a.first, /^LIGHT\[libx264\];/);
    const full = await watch(fullUrls[0]);
    assert.equal(full.status, 200);
    const a2 = await watch(xcLights[0]);
    assert.equal(a2.status, 200, 'the Xtream Codes link works too');
    assert.match(a2.first, /chunk-\d+;/, 'a second light viewer joins the same ffmpeg mid-stream');
    assert.equal(live.requests - before, 1, 'one provider connection for all three');
    assert.equal(runs().length, 1, 'one ffmpeg');
    // ?light=1 on a stream URL (an Xtream Codes login has no playlist attributes): the same copy.
    for (const u of [`${base}/live/multi/mv/${chId}.ts?light=1`, `${base}/multi/mv/${chId}.ts?light=1`, `${fullUrls[0]}?light=1`]) {
      const x = await watch(u);
      assert.equal(x.status, 200, u);
      assert.equal(light.jobs.get(`${chId}|light`).clients.size, 3, `${u} joins the light copy`);
      x.stop();
      await until(() => light.jobs.get(`${chId}|light`).clients.size === 2, 'and leaves it');
    }
    assert.equal(runs().length, 1, 'still one ffmpeg');
    st = (await api('GET', '/api/light')).data;
    assert.deepEqual(st.active, [{ channel: 'Live 1', viewers: 2, profile: 'light' }]);
    const watching = (await api('GET', '/api/viewers')).data;
    const rows = watching.filter((v) => v.what === 'Live 1').map((v) => [v.who, v.transcode]).sort();
    // Both light viewers are this machine on one channel: one row, named by the login.
    assert.deepEqual(rows, [['Playlist link', null], ['multi', 'software']],
      'light viewers flagged with their encoder, in a row apart from the full-quality viewer');
    const widget = await (await fetch(`${base}/api/widget`)).status;
    assert.ok([404, 401].includes(widget), 'widget stays closed without a key');

    // The light copy counts against the source's connections like any channel (2 on this account).
    const b = await watch(lights[1]);
    assert.equal(b.status, 200);
    const c = await watch(lights[2]);
    assert.equal(c.status, 503);
    assert.match(c.text, /All 2 streams for this source are in use/);
    b.stop();
    await until(() => light.jobs.size === 1 && live.open.get(provider[1]) === 0, 'its ffmpeg and provider connection close');

    // Its own cap: ffmpeg runs at a time.
    await api('PUT', '/api/settings', { light_max: 1 });
    const d = await watch(lights[1]);
    assert.equal(d.status, 503);
    assert.match(d.text, /Light streams are all in use \(1 at a time\)/);
    await api('PUT', '/api/settings', { light_max: 4 });

    // Stopped as soon as its last viewer leaves; the provider connection stays for the full viewer.
    const proc = light.jobs.get(`${chId}|light`).proc;
    a.stop();
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(proc.exitCode, null, 'still running for the other light viewer');
    a2.stop();
    await until(() => !light.jobs.size && (proc.exitCode !== null || proc.signalCode !== null), 'ffmpeg stopped');
    assert.equal(live.open.get(provider[0]), 1, 'the full-quality viewer keeps watching');
    full.stop();
    await until(() => live.open.get(provider[0]) === 0, 'provider connection closed with the last viewer');

    // The Watch page's converted copy (?convert=1), for channels the browser can't decode: H.264 up
    // to 1080p at the channel's own frame rate, with AAC sound.
    const conv = await fetch(`${base}/api/outputs/${o.id}/watch/${chId}?convert=1`, { headers: { cookie } });
    assert.equal(conv.status, 200);
    const convReader = conv.body.getReader();
    assert.match(new TextDecoder().decode((await convReader.read()).value), /^LIGHT\[libx264\];/);
    const convArgs = runs().at(-1).join(' ');
    assert.ok(convArgs.includes('-c:a aac') && convArgs.includes("min(1080,ih)") && !convArgs.includes('source_fps'), convArgs);
    assert.equal(light.jobs.get(`${chId}|browser`).clients.size, 1, 'its own copy, apart from the light one');
    await convReader.cancel();
    await until(() => !light.jobs.has(`${chId}|browser`), 'stopped when the page stops watching');
    assert.equal((await fetch(`${base}/api/outputs/${o.id}/watch/${chId}?convert=1`)).status, 401, 'signed-in only');
    // Copy link: the output's own stream link for the channel.
    const lineup = (await api('GET', `/api/outputs/${o.id}/lineup`)).data;
    assert.equal(lineup.stream_base, `${base}/s/${o.token}/`);
    const linked = await fetch(`${lineup.stream_base}${chId}.ts`);
    assert.equal(linked.status, 200, 'it plays');
    await linked.body.cancel();

    // Settings, the test encode, and backups.
    assert.equal((await api('PUT', '/api/settings', { light_encoder: 'gpu' })).status, 400);
    await api('PUT', '/api/settings', { light_encoder: 'vaapi', light_max: 3 });
    const s = (await api('GET', '/api/settings')).data;
    assert.deepEqual([s.light_encoder, s.light_max], ['vaapi', 3]);
    let t = (await api('POST', '/api/light/test', { encoder: 'vaapi' })).data;
    assert.equal(t.ok, false);
    assert.match(t.error, /VAAPI/);
    t = (await api('POST', '/api/light/test', { encoder: 'software' })).data;
    assert.deepEqual(t, { ok: true, encoder: 'software', speed: 3.5 });
    const file = (await api('GET', '/api/export')).data;
    assert.deepEqual([file.settings.light_encoder, file.settings.light_max], ['vaapi', 3]);
    assert.equal(file.outputs.find((x) => x.token === o.token).light_enabled, true);
    const dbFile = path.join(os.tmpdir(), `iptvm-light-${process.pid}.db`);
    const db2 = openDb(dbFile);
    try {
      importSettings(db2, file);
      assert.equal(db2.get('SELECT light_enabled FROM outputs WHERE token = ?', [o.token]).light_enabled, 1);
      assert.equal(db2.get('SELECT light_enabled FROM outputs WHERE token = ?', [token]).light_enabled, 0);
      assert.deepEqual([db2.getSetting('light_encoder'), db2.getSetting('light_max')], ['vaapi', '3']);
    } finally {
      db2.close();
      for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
    }
    const dupe = (await api('POST', `/api/outputs/${o.id}/clone`)).data;
    assert.equal(dupe.light_enabled, true, 'duplicated with the output');
    await api('DELETE', `/api/outputs/${dupe.id}`);
    await api('PUT', '/api/settings', { light_encoder: 'auto', light_max: 4 });

    // Without ffmpeg: a clear refusal, so the player keeps the full stream.
    light.cmd = [path.join(os.tmpdir(), 'no-such-ffmpeg-here')];
    light.reset();
    assert.equal((await api('GET', '/api/light')).data.ffmpeg, null);
    const e = await watch(lights[0]);
    assert.equal(e.status, 503);
    assert.match(e.text, /need ffmpeg/);
    // Installed afterwards: found on the next look, no restart or reset needed.
    light.cmd = [process.execPath, fileURLToPath(new URL('./fake-ffmpeg.mjs', import.meta.url))];
    assert.equal((await api('GET', '/api/light')).data.ffmpeg, '7.1-fake');
    const f = await watch(lights[0]);
    assert.equal(f.status, 200);
    f.stop();
  } finally {
    light.stop();
    light.cmd = realCmd;
    light.reset();
    delete process.env.FAKE_FFMPEG_LOG;
    fs.rmSync(ffmpegLog, { force: true });
    await api('DELETE', `/api/outputs/${o.id}`);
  }
});

test('stall diagnostics: provider pauses and viewers falling behind, on the dashboard and in the log', async () => {
  xcCats.push({ category_id: '34', category_name: 'US| CHECKS' });
  xcStreams.push(
    { num: 97, name: 'Pausing', stream_id: 957, stream_icon: '', epg_channel_id: '', category_id: '34' },
    { num: 98, name: 'Fast', stream_id: 958, stream_icon: '', epg_channel_id: '', category_id: '34' },
  );
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  const o = (await api('POST', '/api/outputs', { name: 'Checks' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { stream_mode: 'proxy', source_ids: [xcId], rules: [{ action: 'include', op: 'equals', value: 'us| checks' }] });
  const text = await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text();
  const urlOf = (name) => text.split('\n')[text.split('\n').findIndex((l) => l.endsWith(`,${name}`)) + 1];
  const streams = app.ctx.streams;
  const saved = [streams.stallMs, streams.lagShowBytes, streams.lagLogBytes, streams.lagSustainMs, app.ctx.log];
  const logs = [];
  Object.assign(streams, { stallMs: 300, lagShowBytes: 256 * 1024, lagLogBytes: 512 * 1024, lagSustainMs: 1000 });
  app.ctx.log = (m) => logs.push(m);
  const until = async (cond, what, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end && !(await cond());) await new Promise((r) => setTimeout(r, 50));
    assert.ok(await cond(), what);
  };
  const row = async (what) => (await api('GET', '/api/viewers')).data.find((v) => v.what === what);
  try {
    // A viewer that keeps reading; the provider goes quiet, then resumes.
    const ac = new AbortController();
    const r = await fetch(urlOf('Pausing'), { signal: ac.signal });
    const reader = r.body.getReader();
    let reading = true;
    (async () => { while (reading) { const { done } = await reader.read().catch(() => ({ done: true })); if (done) break; } })();
    await until(async () => (await row('Pausing'))?.health, 'listed with health');
    assert.deepEqual((await row('Pausing')).health, { provider_pauses: 0, longest_pause_s: 0, silent_s: 0, burst_s: 0, behind_mb: 0 }, 'all well');
    live.paused.add('957');
    await until(async () => (await row('Pausing')).health.silent_s > 0, 'shown as silent while the provider sends nothing');
    live.paused.delete('957');
    await until(async () => (await row('Pausing')).health.provider_pauses === 1, 'counted once data flows again');
    const h = (await row('Pausing')).health;
    assert.deepEqual([h.silent_s, h.longest_pause_s >= 1, h.behind_mb], [0, true, 0], 'the viewer kept up: not its fault');
    assert.ok(logs.some((l) => /^Stream "Pausing": the provider sent nothing for \d+ s \(1st pause in [\d.]+ min\)$/.test(l)), logs.join('\n'));

    // A provider that sends in bursts: the rhythm is learned and shown, its gaps aren't pauses,
    // and only a gap well past it counts.
    live.bursty.add('957');
    await until(async () => (await row('Pausing')).health.burst_s > 0, 'rhythm learned');
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal((await row('Pausing')).health.provider_pauses, 1, 'bursts are not pauses');
    live.paused.add('957');
    await new Promise((res) => setTimeout(res, 1300));
    live.paused.delete('957');
    await until(async () => (await row('Pausing')).health.provider_pauses === 2, 'a gap well past the rhythm is');
    assert.ok(logs.some((l) => l.startsWith('Stream "Pausing": the provider sent nothing for') && l.includes('it usually sends every ~1 s; 2nd pause')), logs.join('\n'));
    live.bursty.delete('957');

    // Now and then two bursts together (a gap twice the usual): part of how the channel comes, not
    // a pause, once learned. A long silence still is one.
    live.doubled.add('957');
    await new Promise((res) => setTimeout(res, 5000)); // learning (three double-length gaps)
    const learned = (await row('Pausing')).health.provider_pauses;
    await new Promise((res) => setTimeout(res, 4000));
    assert.equal((await row('Pausing')).health.provider_pauses, learned, 'the double-length gaps are no longer pauses');
    live.paused.add('957');
    await new Promise((res) => setTimeout(res, 2500));
    live.paused.delete('957');
    await until(async () => (await row('Pausing')).health.provider_pauses === learned + 1, 'a long silence still is');
    live.doubled.delete('957');
    reading = false;
    ac.abort();

    // A viewer that keeps up with a fast channel is never flagged, even if a burst is briefly queued.
    const ac2 = new AbortController();
    const r2 = await fetch(urlOf('Fast'), { signal: ac2.signal });
    const reader2 = r2.body.getReader();
    let reading2 = true;
    (async () => { while (reading2) { const { done } = await reader2.read().catch(() => ({ done: true })); if (done) break; } })();
    await until(async () => (await row('Fast'))?.health, 'listed');
    for (let i = 0; i < 6; i++) {
      assert.equal((await row('Fast')).health.behind_mb, 0, 'keeping up');
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.ok(!logs.some((l) => l.includes('has been behind')));
    reading2 = false;
    ac2.abort();
    await until(() => live.open.get('958') === 0, 'that one closed');

    // A viewer that stops reading falls behind, and stays behind; the provider is fine.
    const req = http.get(urlOf('Fast'), (res) => res.pause());
    req.on('error', () => {});
    await until(async () => (await row('Fast'))?.health?.behind_mb > 0, 'shown as behind', 15000);
    const f = (await row('Fast')).health;
    assert.deepEqual([f.provider_pauses, f.silent_s], [0, 0]);
    await until(() => logs.some((l) => /^Stream "Fast": Playlist link \(.+\) has been behind for \d+ s, now [\d.]+ MB \(their device or network is not keeping up\)/.test(l)),
      'logged once, naming who', 15000);
    assert.equal(logs.filter((l) => l.includes('has been behind')).length, 1, 'only once per connection');
    req.destroy();
    await until(() => live.open.get('958') === 0 && live.open.get('957') === 0, 'upstreams closed');
  } finally {
    [streams.stallMs, streams.lagShowBytes, streams.lagLogBytes, streams.lagSustainMs, app.ctx.log] = saved;
    live.paused.clear();
    await api('DELETE', `/api/outputs/${o.id}`);
  }
});

test('a light-stream encoder buried under a burst skips ahead to live instead of stopping; a dropped viewer is logged once', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Skip' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { stream_mode: 'proxy', light_enabled: true, source_ids: [xcId], rules: [{ action: 'include', op: 'equals', value: 'us| checks' }] });
  const text = await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text();
  const lightOf = (name) => text.split('\n').find((l) => l.endsWith(`,${name}`)).match(/tileiptv-light="([^"]+)"/)[1];
  const urlOf = (name) => text.split('\n')[text.split('\n').findIndex((l) => l.endsWith(`,${name}`)) + 1];
  const { light, streams } = app.ctx;
  const saved = [light.cmd, streams.maxBehindBytes, app.ctx.log];
  const logs = [];
  app.ctx.log = (m) => logs.push(m);
  light.cmd = [process.execPath, fileURLToPath(new URL('./fake-ffmpeg.mjs', import.meta.url))];
  light.reset();
  streams.maxBehindBytes = 1024 * 1024;
  process.env.FAKE_FFMPEG_NOREAD = '1';
  const until = async (cond, what, ms = 10000) => {
    for (const end = Date.now() + ms; Date.now() < end && !(await cond());) await new Promise((r) => setTimeout(r, 50));
    assert.ok(await cond(), what);
  };
  try {
    // The fast channel (64 KB every 20 ms) into an encoder that reads nothing.
    const ac = new AbortController();
    const r = await fetch(lightOf('Fast'), { signal: ac.signal });
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    (async () => { for (;;) { const { done } = await reader.read().catch(() => ({ done: true })); if (done) break; } })();
    await until(() => logs.some((l) => l.includes('skipping ahead to live')), 'skips ahead');
    const job = [...light.jobs.values()][0];
    await new Promise((res) => setTimeout(res, 1000));
    assert.ok(job && !job.closed && job.proc.exitCode === null, 'the light copy keeps running');
    assert.equal(logs.filter((l) => l.includes('skipping ahead')).length, 1, 'logged once');
    assert.ok(!logs.some((l) => l.includes('dropped the light-stream encoder')));
    ac.abort();
    await until(() => !light.jobs.size, 'stopped with its viewer');

    // An ordinary viewer that stops reading is still dropped, and logged once.
    const req = http.get(urlOf('Fast'), (res) => res.pause());
    req.on('error', () => {});
    await until(() => logs.some((l) => l.includes('dropped Playlist link')), 'dropped');
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(logs.filter((l) => l.includes('dropped Playlist link')).length, 1, 'one line, not one per chunk');
    req.destroy();
    await until(() => live.open.get('958') === 0, 'upstream closed');
  } finally {
    delete process.env.FAKE_FFMPEG_NOREAD;
    light.stop();
    [light.cmd, streams.maxBehindBytes, app.ctx.log] = saved;
    light.reset();
    await api('DELETE', `/api/outputs/${o.id}`);
  }
});

test('Convert for playback: only channels in codecs that don\'t play everywhere go out as H.264 + AAC; the rest pass through', async () => {
  xcCats.push({ category_id: '36', category_name: 'US| CODECS' });
  xcStreams.push(
    { num: 160, name: 'Old Tuner', stream_id: 960, stream_icon: '', epg_channel_id: '', category_id: '36' },
    { num: 161, name: 'Modern', stream_id: 961, stream_icon: '', epg_channel_id: '', category_id: '36' },
  );
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  const { light } = app.ctx;
  const ffmpegLog = path.join(os.tmpdir(), `iptvm-convert-${process.pid}.log`);
  fs.rmSync(ffmpegLog, { force: true });
  process.env.FAKE_FFMPEG_LOG = ffmpegLog;
  const saved = light.cmd;
  light.cmd = [process.execPath, fileURLToPath(new URL('./fake-ffmpeg.mjs', import.meta.url))];
  light.reset();
  const runs = () => (fs.existsSync(ffmpegLog) ? fs.readFileSync(ffmpegLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
    .filter((a) => a.includes('pipe:1') && !a.includes('lavfi'));
  const until = async (cond, what) => {
    for (const end = Date.now() + 8000; Date.now() < end && !(await cond());) await new Promise((r) => setTimeout(r, 30));
    assert.ok(await cond(), what);
  };
  // The first bytes a player gets, then hang up.
  const first = async (url) => {
    const r = await fetch(url);
    if (r.status !== 200) return { status: r.status };
    const reader = r.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    return { status: 200, bytes: Buffer.from(value) };
  };
  const o = (await api('POST', '/api/outputs', { name: 'Recorder' })).data;
  try {
    assert.equal((await api('PUT', `/api/outputs/${o.id}`, { convert_mode: 'sometimes' })).status, 400);
    let r = await api('PUT', `/api/outputs/${o.id}`, {
      stream_mode: 'direct', convert_mode: 'needed', xc_enabled: true, xc_username: 'rec', xc_password: 'rp', source_ids: [xcId],
      rules: [{ action: 'include', op: 'equals', value: 'us| codecs' }],
    });
    assert.equal(r.data.convert_mode, 'needed');
    // Direct output, but its streams go through here so they can be converted.
    const text = await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text();
    const urls = text.split('\n').filter((l) => l.startsWith('http'));
    assert.ok(urls.every((u) => u.startsWith(`${base}/s/${o.token}/`)), urls.join('\n'));
    const urlOf = (name) => text.split('\n')[text.split('\n').findIndex((l) => l.endsWith(`,${name}`)) + 1];

    // MPEG-2 + AC-3: converted (the stand-in ffmpeg marks its output).
    const old = await first(urlOf('Old Tuner'));
    assert.equal(old.status, 200);
    assert.match(old.bytes.toString('latin1'), /^LIGHT\[libx264\];/);
    const args = runs().at(-1).join(' ');
    assert.ok(args.includes('-c:a aac') && args.includes('min(1080,ih)'), args);
    // H.264 + AAC: the provider's bytes, untouched; no ffmpeg.
    const before = runs().length;
    const modern = await first(urlOf('Modern'));
    assert.equal(modern.status, 200);
    assert.equal(modern.bytes[0], 0x47, 'MPEG-TS straight from the provider');
    assert.equal(runs().length, before);
    await until(() => !light.jobs.size, 'conversion stopped with its viewer');

    // What was found shows in the lineup.
    const lineup = (await api('GET', `/api/outputs/${o.id}/lineup`)).data;
    const codecs = Object.fromEntries(lineup.channels.map((c) => [c.name, c.codecs]));
    assert.deepEqual(codecs, { 'Old Tuner': { video: 'mpeg2', audio: 'ac3', convert: true }, Modern: { video: 'h264', audio: 'aac', convert: false } });

    // Through the Xtream Codes login too; HLS requests stay HLS.
    assert.match((await first(`${base}/live/rec/rp/${lineup.channels.find((c) => c.name === 'Old Tuner').id}.ts`)).bytes.toString('latin1'), /^LIGHT\[/);
    // "Always": every channel.
    await api('PUT', `/api/outputs/${o.id}`, { convert_mode: 'always' });
    assert.match((await first(urlOf('Modern'))).bytes.toString('latin1'), /^LIGHT\[/);
    await until(() => !light.jobs.size, 'stopped');

    // Without ffmpeg: everything passes through as it is.
    await api('PUT', `/api/outputs/${o.id}`, { convert_mode: 'needed' });
    light.cmd = [path.join(os.tmpdir(), 'no-such-ffmpeg-here')];
    light.reset();
    assert.equal((await first(urlOf('Old Tuner'))).bytes[0], 0x47);

    // Kept in backups and copies; off again gives the provider's own links in Direct mode.
    assert.equal((await api('GET', '/api/export')).data.outputs.find((x) => x.token === o.token).convert_mode, 'needed');
    const dupe = (await api('POST', `/api/outputs/${o.id}/clone`)).data;
    assert.equal(dupe.convert_mode, 'needed');
    await api('DELETE', `/api/outputs/${dupe.id}`);
    await api('PUT', `/api/outputs/${o.id}`, { convert_mode: 'off' });
    const direct = (await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text()).split('\n').filter((l) => l.startsWith('http'));
    assert.ok(direct.every((u) => u.startsWith(`${up}/live/xu/xp/`)), direct.join('\n'));
    await until(() => live.open.get('960') === 0 && live.open.get('961') === 0, 'provider connections closed');
  } finally {
    light.stop();
    light.cmd = saved;
    light.reset();
    delete process.env.FAKE_FFMPEG_LOG;
    fs.rmSync(ffmpegLog, { force: true });
    await api('DELETE', `/api/outputs/${o.id}`);
  }
});

test('a viewer joining a channel already open gets its last seconds first (a cushion), without counting as behind', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Late' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { stream_mode: 'proxy', source_ids: [xcId], rules: [{ action: 'include', op: 'equals', value: 'us| live' }] });
  const text = await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text();
  const url = text.split('\n')[text.split('\n').findIndex((l) => l.endsWith(',Live 2')) + 1];
  const { streams } = app.ctx;
  const saved = streams.maxBehindBytes;
  const open = async () => {
    const ac = new AbortController();
    const r = await fetch(url, { signal: ac.signal });
    const reader = r.body.getReader();
    return { reader, stop: () => { ac.abort(); reader.cancel().catch(() => {}); } };
  };
  // Everything a reader got within `ms`.
  const take = async (reader, ms) => {
    let n = 0;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res(null), end - Date.now()))]);
      if (!r || r.done) break;
      n += r.value.length;
    }
    return n;
  };
  try {
    const a = await open();
    (async () => { for (;;) { const { done } = await a.reader.read().catch(() => ({ done: true })); if (done) break; } })();
    await new Promise((res) => setTimeout(res, 1500)); // ~750 bytes of "chunk-951;" go by
    // A drop limit far below what is replayed: the cushion mustn't count as falling behind.
    streams.maxBehindBytes = 100;
    const b = await open();
    const got = await take(b.reader, 150);
    assert.ok(got >= 500, `the joiner got the recent stream at once (${got} bytes), not just the live point`);
    await new Promise((res) => setTimeout(res, 300));
    const more = await take(b.reader, 300);
    assert.ok(more > 0, 'and keeps receiving: not dropped for the cushion');
    a.stop();
    b.stop();
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(live.open.get('951'), 0);
  } finally {
    streams.maxBehindBytes = saved;
    await api('DELETE', `/api/outputs/${o.id}`);
  }
});

test('a lone viewer that stops reading makes the proxy wait (the provider holds the rest, as with Redirect), not cut it off', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Patient' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { stream_mode: 'proxy', source_ids: [xcId], rules: [{ action: 'include', op: 'equals', value: 'us| checks' }] });
  const text = await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text();
  const url = text.split('\n')[text.split('\n').findIndex((l) => l.endsWith(',Fast')) + 1];
  const { streams } = app.ctx;
  const saved = [streams.maxBehindBytes, streams.pauseAtBytes, app.ctx.log];
  const logs = [];
  app.ctx.log = (m) => logs.push(m);
  // Waits at 256 KB; would be cut off at 2 MB. The channel sends 3.2 MB a second.
  Object.assign(streams, { maxBehindBytes: 2 * 1024 * 1024, pauseAtBytes: 256 * 1024 });
  try {
    const req = http.get(url, (res) => res.pause()); // a TV whose buffer is full: reads nothing
    req.on('error', () => {});
    await new Promise((res) => setTimeout(res, 4000));
    const hub = [...streams.hubs.values()].find((x) => x.ch.name === 'Fast');
    assert.ok(hub && hub.clients.size === 1, 'still connected after 4 s (12 MB went by at the provider)');
    const queued = [...hub.clients][0].writableLength;
    assert.ok(queued < 2 * 1024 * 1024, `the proxy stopped reading instead of piling it up (${queued} bytes queued)`);
    assert.ok(!logs.some((l) => l.includes('dropped')), logs.join('\n'));
    assert.ok(!logs.some((l) => l.includes('provider sent nothing')), 'waiting on the viewer is not a provider pause');
    req.destroy();
    for (let i = 0; i < 100 && live.open.get('958') !== 0; i++) await new Promise((res) => setTimeout(res, 30));
    assert.equal(live.open.get('958'), 0);
  } finally {
    [streams.maxBehindBytes, streams.pauseAtBytes, app.ctx.log] = saved;
    await api('DELETE', `/api/outputs/${o.id}`);
  }
});

test('a proxied stream the provider turns down is logged with why, once a minute, and shown on the source', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Refusals' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { stream_mode: 'proxy', source_ids: [xcId, m3uId], rules: [{ action: 'include', op: 'equals', value: 'us| news' }] });
  const lines = (await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text()).split('\n');
  const urlOf = (name) => lines[lines.findIndex((l) => l.endsWith(`,${name}`)) + 1];
  const logs = [];
  const savedLog = app.ctx.log;
  app.ctx.log = (m) => logs.push(m);
  const src = (await api('GET', `/api/sources/${xcId}`)).data;
  try {
    // The fake provider only serves its own user agent; anything else gets 403.
    assert.equal(src.streams.refused, null);
    await api('PUT', `/api/sources/${xcId}`, { ...src, user_agent: 'SomethingElse/1' });
    for (let i = 0; i < 2; i++) assert.equal((await fetch(urlOf('US: NewsNet HD'))).status, 502);
    const refused = logs.filter((l) => l.startsWith('Stream "US: NewsNet HD"'));
    assert.deepEqual(refused, ['Stream "US: NewsNet HD": the provider refused it (HTTP 403, access refused: user agent, IP lock or account?)'],
      'logged with the status and a hint, once for a quick retry');
    const after = (await api('GET', `/api/sources/${xcId}`)).data.streams.refused;
    assert.deepEqual([after.what, after.reason.startsWith('the provider refused it (HTTP 403'), typeof after.at], ['US: NewsNet HD', true, 'number']);

    // A provider address that can't be reached: the connection error is named.
    assert.equal((await fetch(urlOf('NewsNet'))).status, 502);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(logs.some((l) => /^Stream "NewsNet": couldn't reach the provider \(\w+\)$/.test(l)), logs.join('\n'));
    assert.match((await api('GET', `/api/sources/${m3uId}`)).data.streams.refused.reason, /^couldn't reach the provider/);
  } finally {
    app.ctx.log = savedLog;
    await app.ctx.jobs.idle();
    await api('PUT', `/api/sources/${xcId}`, src);
    await app.ctx.jobs.idle();
    await api('DELETE', `/api/outputs/${o.id}`);
  }
});

test('movies and series: loaded when a source includes them, filtered per output, served over the Xtream Codes login', async () => {
  const setSource = async (id, fields) => {
    const src = (await api('GET', `/api/sources/${id}`)).data;
    assert.equal((await api('PUT', `/api/sources/${id}`, { ...src, ...fields })).status, 200);
    await app.ctx.jobs.idle();
    return (await api('GET', `/api/sources/${id}`)).data;
  };
  let src = await setSource(xcId, { live_only: false });
  assert.deepEqual([src.counts.movies, src.counts.series], [4, 2]);
  assert.deepEqual([src.vod_stats.movies, src.vod_stats.series], [4, 2]);
  // Live TV lists are unchanged: VOD categories live apart, even one named like a live category.
  const liveCats = (await api('GET', `/api/sources/${xcId}/categories`)).data.map((c) => c.name);
  assert.ok(!liveCats.includes('EN| ACTION'));
  assert.equal(liveCats.filter((n) => n === 'US| NEWS').length, 1);

  const o = (await api('POST', '/api/outputs', { name: 'Movie night' })).data;
  let r = await api('PUT', `/api/outputs/${o.id}`, {
    source_ids: [xcId, m3uId], stream_mode: 'redirect', xc_enabled: true, xc_username: 'vod', xc_password: 'pw', vod_enabled: true,
    rules: [
      { kind: 'movie', action: 'include', op: 'starts_with', value: 'en|' },
      { kind: 'series', action: 'include', op: 'contains', value: 'drama' },
    ],
  });
  assert.equal(r.data.vod_enabled, true);
  assert.deepEqual(r.data.rules.map((x) => x.kind), ['movie', 'series']);
  const cats = async (kind) => Object.fromEntries((await api('GET', `/api/outputs/${o.id}/categories?kind=${kind}`)).data.map((c) => [c.name, c.included]));
  assert.deepEqual(await cats('movie'), { 'EN| ACTION': true, 'EN| KIDS': true, 'FR| FILMS': false });
  assert.deepEqual(await cats('series'), { 'EN| DRAMA': true, 'US| NEWS': false });
  // "Include all when a source has no Include rules" is its own switch per kind.
  await api('PUT', `/api/outputs/${o.id}`, { include_all_series: true, rules: [{ kind: 'movie', action: 'include', op: 'starts_with', value: 'en|' }] });
  assert.deepEqual(await cats('series'), { 'EN| DRAMA': true, 'US| NEWS': true });
  assert.equal((await api('GET', `/api/outputs/${o.id}/categories`)).data.every((c) => !c.included), true, 'live TV keeps its own switch');
  assert.deepEqual(await cats('movie'), { 'EN| ACTION': true, 'EN| KIDS': true, 'FR| FILMS': false });
  await api('PUT', `/api/outputs/${o.id}`, {
    include_all_series: false,
    rules: [
      { kind: 'movie', action: 'include', op: 'starts_with', value: 'en|' },
      { kind: 'series', action: 'include', op: 'contains', value: 'drama' },
    ],
  });
  assert.deepEqual(await cats('series'), { 'EN| DRAMA': true, 'US| NEWS': false });
  assert.equal((await api('GET', `/api/outputs/${o.id}/categories`)).data.every((c) => !c.included), true, 'no live rules: no live TV');

  const xc = (action, extra = '') => fetch(`${base}/player_api.php?username=vod&password=pw&action=${action}${extra}`).then((x) => x.json());
  const vodCats = await xc('get_vod_categories');
  assert.deepEqual(vodCats.map((c) => c.category_name), ['EN| ACTION', 'EN| KIDS']);
  const movies = await xc('get_vod_streams');
  assert.deepEqual(movies.map((m) => m.name), ['Tower Siege', 'City Chase', 'Snow Day']);
  const dieHard = movies[0];
  assert.notEqual(dieHard.stream_id, 5001, 'ids are this server\'s own');
  assert.deepEqual([dieHard.stream_type, dieHard.rating, dieHard.container_extension, dieHard.stream_icon], ['movie', '8', 'mkv', 'http://p/dh.jpg']);
  assert.deepEqual((await xc('get_vod_streams', `&category_id=${vodCats[1].category_id}`)).map((m) => m.name), ['Snow Day']);
  const info = await xc('get_vod_info', `&vod_id=${dieHard.stream_id}`);
  assert.deepEqual([info.info.plot, info.movie_data.stream_id, info.movie_data.container_extension], ['A cop in a tower', dieHard.stream_id, 'mkv']);

  // Renaming a VOD category changes what players see; rules still match the provider's name.
  await api('PUT', `/api/categories/${vodCats[0].category_id}`, { custom_name: 'Action' });
  assert.deepEqual((await xc('get_vod_categories')).map((c) => c.category_name), ['Action', 'EN| KIDS']);
  const renamed = (await api('GET', '/api/export')).data.sources.find((x) => x.ref === xcId).categories.find((c) => c.custom_name === 'Action');
  assert.deepEqual([renamed.name, renamed.kind], ['EN| ACTION', 'movie'], 'backed up with its kind');
  await api('PUT', `/api/categories/${vodCats[0].category_id}`, { custom_name: '' });
  assert.deepEqual((await xc('get_vod_categories')).map((c) => c.category_name), ['EN| ACTION', 'EN| KIDS']);
  // A source's category prefix and suffix apply to its movie and series categories too.
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId, m3uId], source_affixes: { [xcId]: { cat_prefix: '', cat_suffix: '[P1]' } } });
  assert.deepEqual((await xc('get_vod_categories')).map((c) => c.category_name), ['EN| ACTION [P1]', 'EN| KIDS [P1]']);
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId, m3uId], source_affixes: { [xcId]: { cat_prefix: '', cat_suffix: '' } } });
  assert.deepEqual((await xc('get_vod_categories')).map((c) => c.category_name), ['EN| ACTION', 'EN| KIDS']);

  // Titles picked in or out by hand, inside an included category.
  const action = vodCats[0].category_id;
  const titles = async (catId) => (await api('GET', `/api/outputs/${o.id}/titles?category_id=${catId}`)).data;
  let t = await titles(action);
  assert.deepEqual([t.category_included, t.total, t.titles.map((x) => [x.name, x.included, x.override])],
    [true, 2, [['Tower Siege', true, null], ['City Chase', true, null]]]);
  const heat = t.titles[1];
  await api('PUT', `/api/outputs/${o.id}/titles`, { ids: [heat.id], state: 'exclude' });
  assert.deepEqual((await xc('get_vod_streams')).map((m) => m.name), ['Tower Siege', 'Snow Day']);
  assert.equal((await fetch(`${base}/movie/vod/pw/${heat.id}.mp4`, { redirect: 'manual' })).status, 404, 'a title picked out can\'t be played');
  let movieCats = (await api('GET', `/api/outputs/${o.id}/categories?kind=movie`)).data;
  assert.deepEqual(movieCats.map((c) => [c.name, c.channel_count, c.excluded_count]), [['EN| ACTION', 2, 1], ['EN| KIDS', 1, 0], ['FR| FILMS', 1, 0]]);
  // Deselect all empties the category (it drops out of the list); Select all brings everything back.
  await api('PUT', `/api/outputs/${o.id}/titles`, { category_id: Number(action), state: 'exclude' });
  assert.deepEqual((await xc('get_vod_categories')).map((c) => c.category_name), ['EN| KIDS']);
  await api('PUT', `/api/outputs/${o.id}/titles`, { category_id: Number(action), state: 'include' });
  t = await titles(action);
  assert.deepEqual(t.titles.map((x) => [x.included, x.override]), [[true, 'include'], [true, 'include']]);
  assert.deepEqual((await xc('get_vod_streams')).map((m) => m.name), ['Tower Siege', 'City Chase', 'Snow Day']);
  // A pick can't pull a title out of an excluded category.
  const french = (await api('GET', `/api/outputs/${o.id}/categories?kind=movie`)).data.find((c) => c.name === 'FR| FILMS');
  const amelieRow = (await titles(french.id)).titles[0];
  await api('PUT', `/api/outputs/${o.id}/titles`, { ids: [amelieRow.id], state: 'include' });
  assert.deepEqual([(await titles(french.id)).category_included, (await titles(french.id)).titles[0].included], [false, false]);
  assert.ok(!(await xc('get_vod_streams')).some((m) => m.name === 'Caméra Obscura'));
  await api('PUT', `/api/outputs/${o.id}/titles`, { ids: [amelieRow.id], state: null });
  // Renaming a title shows in every output, over name cleanup.
  await api('PUT', `/api/vod/${heat.id}`, { custom_name: 'City Chase (Director\'s Cut)' });
  assert.ok((await xc('get_vod_streams')).some((m) => m.name === 'City Chase (Director\'s Cut)'));
  // Searching titles, across the categories of a kind, with whether each is in and why not.
  const search = async (k, q) => (await api('GET', `/api/outputs/${o.id}/search?kind=${k}&q=${encodeURIComponent(q)}`)).data.matches
    .map((m) => [m.custom_name || m.name, m.included, m.reason]);
  assert.deepEqual(await search('movie', 'TOWER'), [['Tower Siege', true, 'manual']]);
  assert.deepEqual(await search('movie', 'amé'), [['Caméra Obscura', false, 'category']], 'titles of excluded categories are found too');
  assert.deepEqual(await search('movie', 'director'), [['City Chase (Director\'s Cut)', true, 'manual']], 'renamed titles match their name');
  assert.deepEqual(await search('series', 'bad'), [['Bad Chemistry', true, 'category']]);
  assert.deepEqual(await search('movie', 'bad'), [], 'each tab searches its own kind');
  // Backed up by provider id, and duplicated with the output.
  const exported = (await api('GET', '/api/export')).data;
  assert.deepEqual(exported.sources.find((x) => x.ref === xcId).vod_titles, [{ kind: 'movie', key: '5002', name: 'City Chase', custom_name: 'City Chase (Director\'s Cut)' }]);
  assert.deepEqual(exported.outputs.find((x) => x.token === o.token).title_overrides.map((x) => [x.kind, x.key, x.state]).sort(),
    [['movie', '5001', 'include'], ['movie', '5002', 'include']]);
  // Restored into a fresh database, picks and names wait on placeholders for the next refresh.
  const dbFile = path.join(os.tmpdir(), `iptvm-titles-${process.pid}.db`);
  const db2 = openDb(dbFile);
  try {
    importSettings(db2, exported);
    const restored = db2.all(`SELECT v.kind, v.key, v.custom_name, x.state FROM output_vod_overrides x
      JOIN vod_items v ON v.id = x.item_id JOIN outputs o ON o.id = x.output_id WHERE o.token = ? ORDER BY v.key`, [o.token]);
    assert.deepEqual(restored.map((r) => [r.kind, r.key, r.custom_name, r.state]),
      [['movie', '5001', null, 'include'], ['movie', '5002', 'City Chase (Director\'s Cut)', 'include']]);
  } finally {
    db2.close();
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  }
  const dupe = (await api('POST', `/api/outputs/${o.id}/clone`)).data;
  assert.equal((await titles(action)).titles.filter((x) => x.override).length, 2);
  assert.equal((await api('GET', `/api/outputs/${dupe.id}/titles?category_id=${action}`)).data.titles.filter((x) => x.override).length, 2);
  await api('DELETE', `/api/outputs/${dupe.id}`);
  await api('PUT', `/api/outputs/${o.id}/titles`, { category_id: Number(action), state: null });
  await api('PUT', `/api/vod/${heat.id}`, { custom_name: '' });
  movieCats = (await api('GET', `/api/outputs/${o.id}/categories?kind=movie`)).data;
  assert.equal(movieCats[0].excluded_count, 0);

  // Name cleanup for movies and series: only rules aimed at them (or everywhere) apply.
  const nameRules = [
    { scope: 'both', media: 'live', find: 'Tower', replace: 'LIVE-ONLY' },
    { scope: 'category', media: 'vod', find: '^[A-Z]{2}\\|\\s*', replace: '' },
    { scope: 'channel', media: 'all', find: '^Tower ', replace: 'The ' },
  ];
  const preview = (await api('POST', `/api/outputs/${o.id}/name-preview`, { rules: nameRules })).data;
  assert.deepEqual([preview.vod.categories.changed, preview.vod.titles.changed], [3, 1]);
  assert.deepEqual(preview.vod.titles.samples, [['Tower Siege', 'The Siege']]);
  await api('PUT', `/api/outputs/${o.id}`, { name_rules: nameRules });
  assert.deepEqual((await xc('get_vod_categories')).map((c) => c.category_name), ['ACTION', 'KIDS']);
  assert.equal((await xc('get_vod_streams'))[0].name, 'The Siege');
  assert.equal((await xc('get_vod_info', `&vod_id=${dieHard.stream_id}`)).movie_data.name, 'The Siege');
  assert.deepEqual((await xc('get_series_categories')).map((c) => c.category_name), ['DRAMA']);
  await api('PUT', `/api/outputs/${o.id}`, { name_rules: [] });

  assert.deepEqual((await xc('get_series_categories')).map((c) => c.category_name), ['EN| DRAMA']);
  const shows = await xc('get_series');
  assert.deepEqual(shows.map((x) => [x.name, x.plot]), [['Bad Chemistry', 'Chemistry']]);
  const bb = await xc('get_series_info', `&series_id=${shows[0].series_id}`);
  assert.equal(bb.info.plot, 'Chemistry teacher');
  assert.deepEqual(bb.episodes['1'].map((e) => [e.episode_num, e.title]), [[1, 'Pilot'], [2, 'Cat in the Bag']]);
  const pilot = bb.episodes['1'][0];
  assert.notEqual(pilot.id, '90001');
  // Opening the show again keeps the same episode ids (players remember what was watched).
  assert.equal((await xc('get_series_info', `&series_id=${shows[0].series_id}`)).episodes['1'][0].id, pilot.id);

  // Playing: Redirect sends the player to the provider's own URL.
  const get = (p, headers = {}) => fetch(`${base}${p}`, { redirect: 'manual', headers });
  r = await get(`/movie/vod/pw/${dieHard.stream_id}.mkv`);
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /\/movie\/xu\/xp\/5001\.mkv$/);
  r = await get(`/series/vod/pw/${pilot.id}.mkv`);
  assert.match(r.headers.get('location'), /\/series\/xu\/xp\/90001\.mkv$/);
  const amelie = app.ctx.db.get("SELECT id FROM vod_items WHERE name = 'Caméra Obscura'").id;
  assert.equal((await get(`/movie/vod/pw/${amelie}.mp4`)).status, 404, 'a movie outside the output is refused');
  assert.equal((await get(`/movie/vod/wrong/${dieHard.stream_id}.mkv`)).status, 401);

  // Proxy relays it, seeking included.
  await api('PUT', `/api/outputs/${o.id}`, { stream_mode: 'proxy' });
  r = await get(`/movie/vod/pw/${dieHard.stream_id}.mkv`, { range: 'bytes=0-9' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 0-9/100');
  assert.equal(await r.text(), 'MOVIE-5001');
  r = await get(`/series/vod/pw/${pilot.id}.mkv`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /^SERIES-90001-/);

  // A title the provider drops disappears on the next refresh.
  vodData.movies.splice(1, 1); // City Chase
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  assert.deepEqual((await xc('get_vod_streams')).map((m) => m.name), ['Tower Siege', 'Snow Day']);

  // M3U playlists: movies and episodes come from the playlist itself.
  src = await setSource(m3uId, { live_only: false });
  assert.deepEqual([src.counts.movies, src.counts.series], [1, 1]);
  await api('PUT', `/api/outputs/${o.id}`, {
    stream_mode: 'redirect',
    rules: [
      { kind: 'movie', action: 'include', op: 'starts_with', value: 'en|' },
      { kind: 'series', action: 'include', op: 'contains', value: 'drama' },
      { kind: 'series', action: 'include', op: 'equals', value: 'shows' },
    ],
  });
  const lost = (await xc('get_series')).find((x) => x.name === 'Lost');
  assert.equal(lost.cover, 'http://logo/lost.png');
  const lostEps = (await xc('get_series_info', `&series_id=${lost.series_id}`)).episodes['1'];
  assert.deepEqual(lostEps.map((e) => e.episode_num), [1, 2]);
  r = await get(`/series/vod/pw/${lostEps[1].id}.mkv`);
  assert.equal(r.headers.get('location'), 'http://h/series/u/p/78.mkv');

  // Backed up with the output.
  const file = (await api('GET', '/api/export')).data;
  const saved = file.outputs.find((x) => x.token === o.token);
  assert.equal(saved.vod_enabled, true);
  assert.deepEqual(saved.rules.map((x) => x.kind), ['movie', 'series', 'series']);

  // Switching the output's VOD off, or the source back to live only, takes it all away.
  await api('PUT', `/api/outputs/${o.id}`, { vod_enabled: false });
  assert.deepEqual(await xc('get_vod_categories'), []);
  assert.equal((await get(`/movie/vod/pw/${dieHard.stream_id}.mkv`)).status, 404);
  await api('PUT', `/api/outputs/${o.id}`, { vod_enabled: true });
  src = await setSource(xcId, { live_only: true });
  assert.deepEqual([src.counts.movies, src.counts.series], [0, 0]);
  assert.deepEqual((await xc('get_vod_streams')).map((m) => m.name), []);
  src = await setSource(m3uId, { live_only: true });
  assert.deepEqual([src.counts.movies, src.counts.series], [0, 0]);
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('duplicating an output copies everything but its URLs and Xtream Codes login', async () => {
  const orig = (await api('GET', `/api/outputs/${outputId}`)).data;
  const r = await api('POST', `/api/outputs/${outputId}/clone`);
  assert.equal(r.status, 201);
  const copy = r.data;
  assert.equal(copy.name, `${orig.name} (copy)`);
  assert.notEqual(copy.token, orig.token);
  assert.deepEqual([copy.xc_enabled, copy.xc_username], [false, null]);
  assert.deepEqual([copy.stream_mode, copy.number_start, copy.epg_days, copy.include_all, copy.vod_enabled],
    [orig.stream_mode, orig.number_start, orig.epg_days, orig.include_all, orig.vod_enabled]);
  const strip = (rules) => rules.map(({ id, ...x }) => x);
  assert.deepEqual(strip(copy.rules), strip(orig.rules));
  assert.deepEqual(copy.sources.filter((x) => x.attached).map((x) => x.id), orig.sources.filter((x) => x.attached).map((x) => x.id));
  // Hand picks, channel rules and per-category switches came along: the lineups are the same.
  const lineup = async (t) => (await (await fetch(`${base}/o/${t}/playlist.m3u`)).text()).split('\n').filter((l) => l.startsWith('#EXTINF'));
  const a = await lineup(orig.token);
  assert.ok(a.length > 3);
  assert.deepEqual(await lineup(copy.token), a);
  const catState = async (id) => (await api('GET', `/api/outputs/${id}/categories`)).data
    .map((c) => [c.id, c.included, c.override, c.channel_rules.length, c.hide_empty, c.hide_by_guide]);
  assert.deepEqual(await catState(copy.id), await catState(outputId));
  // The copy is independent.
  await api('PUT', `/api/outputs/${copy.id}`, { rules: [] });
  assert.deepEqual(await lineup(orig.token), a);
  assert.equal((await api('POST', '/api/outputs/99999/clone')).status, 404);
  await api('DELETE', `/api/outputs/${copy.id}`);
});

test('extra Xtream Codes logins share an output, and come and go without touching the others', async () => {
  const pa = (u, p, action = '') => fetch(`${base}/player_api.php?username=${u}&password=${p}${action ? `&action=${action}` : ''}`).then((r) => r.json());
  let r = await api('POST', `/api/outputs/${outputId}/logins`, { name: 'Mom', username: 'mom', password: 'm0m' });
  assert.equal(r.status, 201);
  const mom = r.data;
  // Works like the output's own login, and reports itself.
  const info = await pa('mom', 'm0m');
  assert.deepEqual([info.user_info.auth, info.user_info.username, info.user_info.password], [1, 'mom', 'm0m']);
  const mine = await pa('family', 'pw123', 'get_live_streams');
  assert.deepEqual((await pa('mom', 'm0m', 'get_live_streams')).map((x) => x.stream_id), mine.map((x) => x.stream_id));
  // Playlists carry the credentials of whoever asked, never the output's own.
  const playlist = await (await fetch(`${base}/get.php?username=mom&password=m0m&type=m3u_plus`)).text();
  assert.match(playlist, /\/live\/mom\/m0m\/\d+\.ts/);
  assert.ok(!playlist.includes('pw123'), 'the main password is not handed out');
  const stream = playlist.split('\n').find((l) => l.includes('/live/mom/m0m/'));
  assert.equal((await fetch(stream, { redirect: 'manual' })).status < 500, true);
  assert.equal((await pa('mom', 'wrong')).user_info.auth, 0);
  assert.ok(app.ctx.db.get('SELECT last_used_at FROM output_xc_logins WHERE id = ?', [mom.id]).last_used_at > 0, 'last used is recorded');
  // Usernames are unique across all logins.
  assert.equal((await api('POST', `/api/outputs/${outputId}/logins`, { username: 'family', password: 'x' })).status, 400);
  assert.equal((await api('POST', `/api/outputs/${outputId}/logins`, { username: 'mom', password: 'x' })).status, 400);
  assert.equal((await api('POST', `/api/outputs/${outputId}/logins`, { username: 'a b', password: 'x' })).status, 400);
  const other = (await api('POST', '/api/outputs', { name: 'Other' })).data;
  assert.equal((await api('PUT', `/api/outputs/${other.id}`, { xc_enabled: true, xc_username: 'mom', xc_password: 'x' })).status, 400);
  await api('DELETE', `/api/outputs/${other.id}`);
  // Listed with the output, in backups (password only with secrets), not copied by Duplicate.
  assert.deepEqual((await api('GET', `/api/outputs/${outputId}`)).data.xc_logins.map((l) => [l.name, l.username, l.enabled]), [['Mom', 'mom', true]]);
  // Listed by name (or username when unnamed), ignoring case.
  const zoe = (await api('POST', `/api/outputs/${outputId}/logins`, { name: 'zoe', username: 'z', password: 'z' })).data;
  const bob = (await api('POST', `/api/outputs/${outputId}/logins`, { name: '', username: 'Bob', password: 'b' })).data;
  assert.deepEqual((await api('GET', `/api/outputs/${outputId}`)).data.xc_logins.map((l) => l.name || l.username), ['Bob', 'Mom', 'zoe']);
  for (const l of [zoe, bob]) await api('DELETE', `/api/outputs/${outputId}/logins/${l.id}`);
  const file = (await api('GET', '/api/export')).data;
  assert.deepEqual(file.outputs.find((x) => x.token === token).xc_logins, [{ name: 'Mom', username: 'mom', password: 'm0m', enabled: true }]);
  assert.equal((await api('GET', '/api/export?secrets=0')).data.outputs.find((x) => x.token === token).xc_logins[0].password, null);
  const dupe = (await api('POST', `/api/outputs/${outputId}/clone`)).data;
  assert.deepEqual(dupe.xc_logins, []);
  await api('DELETE', `/api/outputs/${dupe.id}`);
  // Paused, then removed: that login stops, the output's own keeps working.
  await api('PUT', `/api/outputs/${outputId}/logins/${mom.id}`, { enabled: false });
  assert.equal((await pa('mom', 'm0m')).user_info.auth, 0);
  assert.equal((await pa('family', 'pw123')).user_info.auth, 1);
  await api('PUT', `/api/outputs/${outputId}/logins/${mom.id}`, { enabled: true });
  assert.equal((await pa('mom', 'm0m')).user_info.auth, 1);
  assert.equal((await api('DELETE', `/api/outputs/${outputId}/logins/${mom.id}`)).status, 200);
  assert.equal((await pa('mom', 'm0m')).user_info.auth, 0);
  assert.equal((await pa('family', 'pw123')).user_info.auth, 1);
  assert.equal((await api('DELETE', `/api/outputs/${outputId}/logins/${mom.id}`)).status, 404);
});

test('who is watching what: proxy streams start to stop, redirected ones by their start', async () => {
  const mk = async (name, fields) => {
    const o = (await api('POST', '/api/outputs', { name })).data;
    await api('PUT', `/api/outputs/${o.id}`, { xc_enabled: true, ...fields });
    return o;
  };
  const p = await mk('Proxy room', { stream_mode: 'proxy', xc_username: 'watcher', xc_password: 'w', source_ids: [xcId], rules: [{ action: 'include', op: 'equals', value: 'us| live' }] });
  const rd = await mk('Redirect room', { stream_mode: 'redirect', xc_username: 'redir', xc_password: 'r', source_ids: [xcId], rules: [{ action: 'include', op: 'equals', value: 'us| live' }] });
  await api('POST', `/api/outputs/${p.id}/logins`, { name: 'Mom', username: 'mom2', password: 'm' });
  const ids = async (u, pw) => (await (await fetch(`${base}/player_api.php?username=${u}&password=${pw}&action=get_live_streams`)).json()).map((s) => [s.name, s.stream_id]);
  const [[name1, id1], [name2, id2]] = await ids('watcher', 'w');
  const viewers = async () => (await api('GET', '/api/viewers')).data;
  const watch = async (url) => {
    const ac = new AbortController();
    const r = await fetch(url, { signal: ac.signal });
    const reader = r.body.getReader();
    await reader.read();
    return () => { ac.abort(); reader.cancel().catch(() => {}); };
  };

  // Proxy: listed while the stream is open, with who (login name, else username), what and where.
  const stop1 = await watch(`${base}/live/watcher/w/${id1}.ts`);
  const stop2 = await watch(`${base}/live/mom2/m/${id2}.ts`);
  let v = await viewers();
  // This test's outputs only: an earlier test's viewer of the same name may still be ending.
  const byWho = (who) => v.find((x) => x.who === who && ['Proxy room', 'Redirect room', 'HLS room'].includes(x.output));
  assert.deepEqual(
    [byWho('watcher')?.what, byWho('watcher')?.mode, byWho('watcher')?.output, byWho('watcher')?.source, byWho('watcher')?.kind],
    [name1, 'proxy', 'Proxy room', 'XC', 'live'],
  );
  assert.deepEqual([byWho('Mom')?.what, byWho('Mom')?.username, byWho('Mom')?.ending], [name2, 'mom2', false]);
  assert.match(byWho('Mom').ip, /127\.0\.0\.1|::1/);
  stop1();
  // The server sees the hang-up when the connection closes; give a busy machine up to 2 seconds.
  for (let i = 0; i < 40; i++) {
    v = await viewers();
    if (byWho('watcher')?.ending) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(byWho('watcher')?.ending, true, 'stopped: shown as ending for a few seconds, in case the player reconnects');
  stop2();

  // Redirect: only the start is seen; the device's next start replaces it.
  await fetch(`${base}/live/redir/r/${id1}.ts`, { redirect: 'manual' });
  v = await viewers();
  assert.deepEqual([byWho('redir')?.what, byWho('redir')?.mode], [name1, 'redirect']);
  await fetch(`${base}/live/redir/r/${id2}.ts`, { redirect: 'manual' });
  v = await viewers();
  assert.deepEqual(v.filter((x) => x.who === 'redir').map((x) => x.what), [name2]);

  // HLS through a proxy: the playlist says who; the segments (by token URL) keep it.
  const hls = await mk('HLS room', { stream_mode: 'proxy', xc_username: 'hlsu', xc_password: 'h', source_ids: [m3uId], rules: [{ action: 'include', op: 'equals', value: 'uk| general' }] });
  const bbc = (await ids('hlsu', 'h')).find(([n]) => /Kingdom/.test(n));
  const playlist = await (await fetch(`${base}/live/hlsu/h/${bbc[1]}.m3u8`)).text();
  await (await fetch(base + playlist.split('\n').find((l) => l.startsWith('/s/')))).text();
  v = await viewers();
  assert.deepEqual([byWho('hlsu')?.what, byWho('hlsu')?.mode], [bbc[0], 'proxy']);
  assert.equal(v.filter((x) => x.output === 'HLS room').length, 1);

  for (const o of [p, rd, hls]) await api('DELETE', `/api/outputs/${o.id}`);
  app.ctx.viewers.entries.clear();
});

test('Watch page: an output\'s lineup, played through this server whatever the output\'s mode', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Watch me' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { stream_mode: 'redirect', source_ids: [xcId, m3uId], rules: [
    { action: 'include', op: 'equals', value: 'us| live' }, { action: 'include', op: 'equals', value: 'uk| general' },
    { action: 'include', op: 'equals', value: 'us| news', source_id: xcId }] });
  // The dashboard's list says what the guide has on now for a live channel.
  const newsnet = (await api('GET', `/api/outputs/${o.id}/lineup`)).data.channels.find((c) => c.name === 'US: NewsNet HD');
  await (await fetch(`${base}/api/outputs/${o.id}/watch/${newsnet.id}`, { headers: { cookie } })).text();
  const newsnetViewer = (await api('GET', '/api/viewers')).data.find((x) => x.what === 'US: NewsNet HD');
  assert.deepEqual([newsnetViewer?.program, newsnetViewer?.source, newsnetViewer?.mode], ['NewsNet show 0', 'XC', 'proxy']);
  app.ctx.viewers.entries.clear();
  const lineup = (await api('GET', `/api/outputs/${o.id}/lineup`)).data;
  const live1 = lineup.channels.find((c) => c.name === 'Live 1');
  const bbc = lineup.channels.find((c) => /Kingdom/.test(c.name));
  assert.deepEqual([live1.format, live1.hls_available, live1.group], ['ts', true, 'US| LIVE']);
  assert.deepEqual([bbc.format, bbc.hls_available], ['m3u8', true]);
  assert.equal(lineup.paused, false);

  // A redirect output still streams through this server here, and the player shows as a viewer.
  const ac = new AbortController();
  const r = await fetch(`${base}/api/outputs/${o.id}/watch/${live1.id}`, { headers: { cookie }, signal: ac.signal });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp2t');
  const reader = r.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /chunk-950;/);
  const v = (await api('GET', '/api/viewers')).data.find((x) => x.who === 'Web player');
  assert.deepEqual([v?.what, v?.mode, v?.output], ['Live 1', 'proxy', 'Watch me']);
  ac.abort();
  reader.cancel().catch(() => {});

  // HLS channels come back as a playlist pointing at this server.
  const pl = await (await fetch(`${base}/api/outputs/${o.id}/watch/${bbc.id}?format=m3u8`, { headers: { cookie } })).text();
  assert.match(pl, /^#EXTM3U/);
  assert.ok(pl.split('\n').some((l) => l.startsWith('/s/')));
  // Only for the logged-in admin.
  assert.equal((await fetch(`${base}/api/outputs/${o.id}/watch/${live1.id}`)).status, 401);
  assert.equal((await fetch(`${base}/api/outputs/${o.id}/watch/999999`, { headers: { cookie } })).status, 404);
  await api('DELETE', `/api/outputs/${o.id}`);
  app.ctx.viewers.entries.clear();
});

test('pausing an output stops its URLs and every login until it is resumed; refreshing its sources', async () => {
  const pa = (u, p) => fetch(`${base}/player_api.php?username=${u}&password=${p}`).then((r) => r.json());
  const extra = (await api('POST', `/api/outputs/${outputId}/logins`, { username: 'guest', password: 'g' })).data;
  const playlist = () => fetch(`${base}/o/${token}/playlist.m3u`);
  const streamUrl = (await (await playlist()).text()).split('\n').find((l) => l.startsWith('http'));
  assert.ok(streamUrl);

  let r = await api('POST', `/api/outputs/${outputId}/pause`, { paused: true });
  assert.equal(r.data.paused, true);
  r = await playlist();
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /paused/);
  assert.equal((await fetch(`${base}/o/${token}/epg.xml`)).status, 503);
  assert.equal((await fetch(streamUrl, { redirect: 'manual' })).status, 503);
  assert.equal((await pa('family', 'pw123')).user_info.auth, 0);
  assert.equal((await pa('guest', 'g')).user_info.auth, 0);
  assert.equal((await fetch(`${base}/get.php?username=family&password=pw123`)).status, 401);
  assert.equal((await api('GET', '/api/outputs')).data.find((o) => o.id === outputId).paused, true);
  assert.equal((await api('GET', '/api/export')).data.outputs.find((o) => o.token === token).paused, true);

  await api('POST', `/api/outputs/${outputId}/pause`, { paused: false });
  assert.equal((await playlist()).status, 200);
  assert.equal((await pa('family', 'pw123')).user_info.auth, 1);
  assert.equal((await pa('guest', 'g')).user_info.auth, 1);
  await api('DELETE', `/api/outputs/${outputId}/logins/${extra.id}`);

  // Refresh sources: every enabled source the output uses.
  r = await api('POST', `/api/outputs/${outputId}/refresh`);
  assert.equal(r.status, 202);
  assert.equal(r.data.sources, 2);
  await app.ctx.jobs.idle();
});

test('two-factor sign-in: setup, codes once each, recovery codes, turning off, DISABLE_2FA', async () => {
  const { codeAt, stepNow } = await import('../src/totp.js');
  const login = (body) => fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(body) });
  assert.deepEqual((await api('GET', '/api/2fa')).data, { enabled: false, recovery_left: 0 });

  // Setup: a secret and a QR code; a wrong code doesn't turn it on.
  const setup = (await api('POST', '/api/2fa/setup')).data;
  assert.match(setup.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.uri, /^otpauth:\/\/totp\/Simple%20IPTV%20Manager%3Aadmin\?secret=/);
  assert.match(setup.qr_svg, /^<svg/);
  assert.equal((await api('POST', '/api/2fa/enable', { code: '000000' })).status, 400);
  const oldCookie = cookie;
  const step = stepNow();
  const on = await api('POST', '/api/2fa/enable', { code: codeAt(setup.secret, step) });
  assert.equal(on.status, 200);
  assert.equal(on.data.recovery_codes.length, 8);
  assert.match(on.data.recovery_codes[0], /^[a-z2-7]{4}-[a-z2-7]{4}$/);
  assert.notEqual(cookie, oldCookie, 'this session gets a new cookie');
  assert.equal((await fetch(`${base}/api/sources`, { headers: { cookie: oldCookie } })).status, 401, 'other sessions are signed out');
  assert.deepEqual((await api('GET', '/api/2fa')).data, { enabled: true, recovery_left: 8 });

  // Signing in: the password alone asks for the code; a code works once; recovery codes work once.
  let r = await login({ password: PASSWORD });
  assert.deepEqual([r.status, await r.json(), r.headers.get('set-cookie')], [200, { two_factor_required: true }, null]);
  assert.equal((await login({ password: 'wrong', code: codeAt(setup.secret, step + 1) })).status, 401, 'the password still matters');
  assert.equal((await login({ password: PASSWORD, code: codeAt(setup.secret, step) })).status, 401, 'the setup code was already used');
  r = await login({ password: PASSWORD, code: codeAt(setup.secret, step + 1) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /iptvm_session=/);
  r = await login({ password: PASSWORD, code: on.data.recovery_codes[0].toUpperCase() });
  assert.equal(r.status, 200, 'recovery codes ignore case');
  assert.equal((await login({ password: PASSWORD, code: on.data.recovery_codes[0] })).status, 401, 'a recovery code works once');
  assert.equal((await api('GET', '/api/2fa')).data.recovery_left, 7);

  // Turning it off needs a code too.
  assert.equal((await api('POST', '/api/2fa/disable', { code: '123456' })).status, 400);
  assert.equal((await api('POST', '/api/2fa/disable', { code: on.data.recovery_codes[1] })).status, 200);
  assert.deepEqual((await api('GET', '/api/2fa')).data, { enabled: false, recovery_left: 0 });
  r = await login({ password: PASSWORD });
  assert.match(r.headers.get('set-cookie') || '', /iptvm_session=/, 'back to the password alone');

  // DISABLE_2FA=1 on start turns it off (the way back in without the phone or the codes).
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-2fa-'));
  let app2 = createApp({ dataDir: dir2, adminPassword: PASSWORD, log: () => {} });
  app2.ctx.db.setSetting('totp_secret', setup.secret);
  await app2.close();
  app2 = createApp({ dataDir: dir2, log: () => {}, disableTwoFactor: true });
  assert.equal(app2.ctx.db.getSetting('totp_secret'), null);
  await app2.close();
  fs.rmSync(dir2, { recursive: true, force: true });
});

test('behind a reverse proxy: sign-in and Xtream Codes guesses are limited per visitor; setup only from the local network; sign out other devices', async () => {
  // The test talks to the app from 127.0.0.1, which counts as a trusted proxy, so X-Forwarded-For
  // stands in for visitors on the internet.
  const as = (ip, p, init = {}) => fetch(base + p, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(ip ? { 'x-forwarded-for': ip } : {}), ...(init.headers || {}) },
  });
  const login = (ip, password) => as(ip, '/api/login', { method: 'POST', body: JSON.stringify({ password }) });
  const logs = [];
  const savedLog = app.ctx.log;
  app.ctx.log = (m) => logs.push(m);
  try {
    // Admin sign-in: 5 wrong from one visitor locks that visitor only, even with the right password.
    for (let i = 0; i < 5; i++) assert.equal((await login('203.0.113.10', 'wrong')).status, 401);
    assert.equal((await login('203.0.113.10', PASSWORD)).status, 429);
    assert.ok(logs.includes('Sign-in: 5 wrong attempts from 203.0.113.10; blocked for 60 s'), logs.join('\n'));
    assert.equal((await login('203.0.113.11', 'wrong')).status, 401, 'another visitor is not affected');
    assert.equal((await login('203.0.113.12', PASSWORD)).status, 200, 'and can sign in');
    // A visitor can't fake its way out: the proxy appends the real address, which is read first.
    assert.equal((await login('198.18.0.1, 203.0.113.10', PASSWORD)).status, 429);

    // Many wrong sign-ins from many addresses: only known addresses and the local network get in.
    for (let i = 0; i < 50; i++) await login(`198.51.100.${i + 1}`, 'wrong');
    assert.ok(logs.some((l) => l.startsWith('Sign-in: many wrong attempts from different addresses')));
    assert.equal((await login('198.51.100.200', PASSWORD)).status, 429, 'a new address waits');
    assert.equal((await login('203.0.113.12', PASSWORD)).status, 200, 'one that signed in before still can');
    assert.equal((await login(null, PASSWORD)).status, 200, 'the local network still can');

    // Xtream Codes: 10 wrong logins block that visitor for a while, even with right credentials.
    const xc = (ip, u, p) => as(ip, `/player_api.php?username=${u}&password=${p}`);
    for (let i = 0; i < 10; i++) assert.deepEqual(await (await xc('192.0.2.5', 'family', 'nope')).json(), { user_info: { auth: 0 } });
    assert.equal((await xc('192.0.2.5', 'family', 'pw123')).status, 429);
    assert.equal((await as('192.0.2.5', '/get.php?username=family&password=pw123')).status, 429, 'every login route');
    assert.ok(logs.includes('Xtream Codes login: 10 wrong attempts from 192.0.2.5; blocked for 10 minutes'));
    assert.equal((await (await xc('192.0.2.6', 'family', 'pw123')).json()).user_info.auth, 1, 'others are not affected');
    // Devices on the local network are never blocked (a TV with an old password keeps retrying).
    for (let i = 0; i < 12; i++) await xc(null, 'family', 'nope');
    assert.equal((await (await xc(null, 'family', 'pw123')).json()).user_info.auth, 1);

    // Sign out other devices: an older session stops working, this one carries on.
    const other = (await login(null, PASSWORD)).headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/settings`, { headers: { cookie: other } })).status, 200);
    assert.equal((await api('POST', '/api/sessions/revoke')).status, 200);
    assert.equal((await fetch(`${base}/api/settings`, { headers: { cookie: other } })).status, 401, 'the other session is signed out');
    assert.equal((await api('GET', '/api/settings')).status, 200, 'this one carries on');
  } finally {
    app.ctx.log = savedLog;
  }

  // The first admin password can only be set from the local network.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-setup-'));
  const app2 = createApp({ dataDir: dir2, log: () => {} });
  const base2 = `http://127.0.0.1:${(await app2.start(0, '127.0.0.1')).port}`;
  try {
    const setup = (ip) => fetch(`${base2}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(ip ? { 'x-forwarded-for': ip } : {}) },
      body: JSON.stringify({ password: 'a long password' }),
    });
    const r = await setup('203.0.113.50');
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /from your local network/);
    assert.equal((await setup('192.168.1.40')).status, 200, 'through the proxy from the local network');
  } finally {
    await app2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('dashboard widget API: off until a key is made, read-only numbers with that key only', async () => {
  const widget = (headers = {}, qs = '') => fetch(`${base}/api/widget${qs}`, { headers });
  assert.equal((await widget()).status, 404, 'off by default');
  const key = (await api('POST', '/api/widget-key')).data.key;
  assert.match(key, /^[\w-]{32}$/);
  assert.equal((await api('GET', '/api/widget-key')).data.key, key);
  assert.equal((await widget()).status, 401);
  assert.equal((await widget({ 'x-api-key': 'nope' })).status, 401);
  const r = await widget({ 'x-api-key': key });
  assert.equal(r.status, 200);
  const d = await r.json();
  const srcCount = (await api('GET', '/api/sources')).data.length;
  assert.equal(d.sources, srcCount);
  assert.equal(d.sources_ok + d.sources_warning + d.sources_error <= srcCount, true);
  for (const k of ['watching', 'recently_started', 'channels', 'movies', 'series', 'outputs', 'outputs_paused', 'alerts']) assert.equal(typeof d[k], 'number', k);
  assert.ok(d.channels > 0);
  assert.ok(Array.isArray(d.watching_list));
  assert.equal(typeof d.update_available, 'boolean');
  assert.equal((await widget({}, `?key=${key}`)).status, 200, 'the key also works as ?key=');
  // The key reads these numbers and nothing else.
  assert.equal((await fetch(`${base}/api/sources`, { headers: { 'x-api-key': key } })).status, 401);
  // A new key retires the old; turning it off closes the endpoint.
  const key2 = (await api('POST', '/api/widget-key')).data.key;
  assert.equal((await widget({ 'x-api-key': key })).status, 401);
  assert.equal((await widget({ 'x-api-key': key2 })).status, 200);
  await api('DELETE', '/api/widget-key');
  assert.equal((await widget({ 'x-api-key': key2 })).status, 404);
});

test('rule order is saved and returned as given, for category and channel rules', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Order' })).data;
  const rules = [
    { action: 'include', op: 'contains', value: 'news' },
    { action: 'include', op: 'starts_with', value: 'us|' },
    { action: 'exclude', op: 'ends_with', value: 'adult' },
    { action: 'exclude', op: 'contains', value: '24/7' },
  ];
  const saved = (await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId], rules: [rules[1], rules[0], rules[3], rules[2]] })).data;
  assert.deepEqual(saved.rules.map((r) => r.value), ['us|', 'news', '24/7', 'adult']);
  const again = (await api('GET', `/api/outputs/${o.id}`)).data;
  assert.deepEqual(again.rules.map((r) => r.value), ['us|', 'news', '24/7', 'adult']);

  const cat = (await api('GET', `/api/outputs/${o.id}/categories`)).data.find((c) => c.name === 'US| NEWS');
  const chRules = [{ action: 'exclude', op: 'contains', value: 'b' }, { action: 'include', op: 'contains', value: 'a' }, { action: 'exclude', op: 'contains', value: 'c' }];
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/channel-rules`, { rules: chRules });
  const view = (await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data;
  assert.deepEqual(view.rules.map((r) => r.value), ['b', 'a', 'c']);
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('Update now: only where the updater path unit exists; one request at a time; progress reported', async () => {
  // This test instance has no path unit (not a Proxmox install).
  const none = await api('POST', '/api/updates/apply');
  assert.equal(none.status, 409);
  assert.match(none.data.error, /not set up/);
  assert.equal((await api('GET', '/api/updates')).data.web_update.available, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-web-'));
  const unit = path.join(dir, 'iptv-manager-update.path');
  fs.writeFileSync(unit, '[Path]\n');
  const data = path.join(dir, 'data');
  const a = createApp({ dataDir: data, adminPassword: PASSWORD, log: () => {}, webUpdatePathUnit: unit, updateCheckDelayMs: 1e9 });
  const b = `http://127.0.0.1:${(await a.start(0, '127.0.0.1')).port}`;
  try {
    const login = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ password: PASSWORD }) });
    const c = login.headers.get('set-cookie').split(';')[0];
    const call = async (method, p) => {
      const r = await fetch(b + p, { method, headers: { cookie: c, 'x-requested-with': 'fetch' } });
      return { status: r.status, data: await r.json() };
    };
    // Needs the admin session (and the CSRF header), like every other admin action.
    assert.equal((await fetch(`${b}/api/updates/apply`, { method: 'POST', headers: { 'x-requested-with': 'fetch' } })).status, 401);

    let r = await call('POST', '/api/updates/apply');
    assert.equal(r.status, 202);
    assert.ok(fs.existsSync(path.join(data, 'update', 'request')), 'request file written for the path unit');
    assert.deepEqual([r.data.web_update.available, r.data.web_update.pending, r.data.web_update.busy], [true, true, true]);
    assert.equal((await call('POST', '/api/updates/apply')).status, 409, 'no second request while one is pending');

    // The root updater picks it up: consumes the request and reports progress.
    fs.rmSync(path.join(data, 'update', 'request'));
    const t = Math.floor(Date.now() / 1000);
    const status = (s) => fs.writeFileSync(path.join(data, 'update', 'status.json'), JSON.stringify(s));
    status({ state: 'running', message: 'Restarting the app', trigger: 'web', started_at: t, finished_at: null, from: 'a', to: 'b' });
    fs.writeFileSync(path.join(data, 'update', 'last.log'), '10:00:00 Updating\n10:00:05 Restarting\n');
    r = await call('GET', '/api/updates');
    assert.equal(r.data.web_update.status.state, 'running');
    assert.deepEqual(r.data.web_update.log, ['10:00:00 Updating', '10:00:05 Restarting']);
    assert.equal((await call('POST', '/api/updates/apply')).status, 409, 'no request while one is running');

    // A run that died long ago does not block the button forever.
    status({ state: 'running', message: 'x', trigger: 'web', started_at: t - 3600, finished_at: null });
    assert.equal((await call('POST', '/api/updates/apply')).status, 202);
    fs.rmSync(path.join(data, 'update', 'request'));
    status({ state: 'updated', message: 'Updated to b', trigger: 'web', started_at: t, finished_at: t + 20 });
    r = await call('GET', '/api/updates');
    assert.deepEqual([r.data.web_update.busy, r.data.web_update.status.state], [false, 'updated']);
    const req = () => JSON.parse(fs.readFileSync(path.join(data, 'update', 'request'), 'utf8'));

    // Nightly updates: requests carry an action for the root updater.
    const post = async (p, body) => {
      const x = await fetch(b + p, { method: 'POST', headers: { cookie: c, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(body) });
      return { status: x.status, data: await x.json() };
    };
    assert.equal(r.data.web_update.auto, null, 'unknown until the updater writes auto.json');
    assert.equal((await post('/api/updates/auto', { enabled: true, at: '25:00' })).status, 400);
    assert.equal((await post('/api/updates/auto', { enabled: true, at: '03:30' })).status, 202);
    assert.deepEqual([req().action, req().at], ['enable-auto', '03:30']);
    assert.equal((await post('/api/updates/auto', { enabled: false })).status, 409, 'one request at a time');
    fs.rmSync(path.join(data, 'update', 'request'));
    fs.writeFileSync(path.join(data, 'update', 'auto.json'), '{"enabled":true,"at":"03:30"}');
    r = await call('GET', '/api/updates');
    assert.deepEqual(r.data.web_update.auto, { enabled: true, at: '03:30' });
    assert.equal((await post('/api/updates/auto', { enabled: false })).status, 202);
    assert.equal(req().action, 'disable-auto');
    fs.rmSync(path.join(data, 'update', 'request'));
    assert.equal((await call('POST', '/api/updates/apply')).status, 202);
    assert.equal(req().action, 'update');
  } finally {
    await a.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('update check: version, up to date, behind, GitHub down, switched off', async () => {
  let u = (await api('GET', '/api/updates')).data;
  assert.deepEqual([u.commit, u.enabled, u.checked_at], [RUNNING, true, undefined], 'nothing checked yet');

  u = (await api('POST', '/api/updates/check')).data;
  assert.deepEqual([u.behind, u.error, u.latest.sha], [0, null, RUNNING]);
  assert.equal(u.latest.message, 'Latest change', 'first line only');

  gh.latest = 'c'.repeat(40);
  gh.newer = ['Older fix', 'Newest feature\n\ndetails'];
  u = (await api('POST', '/api/updates/check')).data;
  assert.equal(u.behind, 2);
  assert.deepEqual(u.commits.map((c) => c.message), ['Newest feature', 'Older fix'], 'newest first');

  // GitHub failing keeps the last good answer and reports the problem.
  gh.fail = true;
  u = (await api('POST', '/api/updates/check')).data;
  assert.match(u.error, /HTTP 500/);
  assert.equal(u.behind, 2);
  gh.fail = false;

  // The daily check can be switched off; a manual check still works.
  await api('PUT', '/api/settings', { update_check: false });
  u = (await api('GET', '/api/updates')).data;
  assert.equal(u.enabled, false);
  assert.equal((await api('POST', '/api/updates/check')).data.error, null);
  await api('PUT', '/api/settings', { update_check: true });

  // After an update the saved result describes the old version. It must not keep saying
  // "Update available" (the bug seen after Update now): the new process re-reads it.
  const { UpdateChecker: UC } = await import('../src/updates.js');
  const opts = { db: app.ctx.db, apiBase: up, repo: 'test/repo' };
  const updatedToLatest = new UC({ ...opts, commit: gh.latest });
  assert.equal(updatedToLatest.isStale(), true);
  assert.deepEqual([updatedToLatest.state().behind, updatedToLatest.state().commits], [0, []], 'now running the latest: up to date, no network');
  const updatedToOther = new UC({ ...opts, commit: 'd'.repeat(40) });
  assert.deepEqual([updatedToOther.state().behind, updatedToOther.state().checking], [null, true]);
  assert.match(updatedToOther.state().note, /Checking/);
  // A result saved before for_commit existed counts as stale too.
  const saved = JSON.parse(app.ctx.db.getSetting('update_state'));
  delete saved.for_commit;
  app.ctx.db.setSetting('update_state', JSON.stringify(saved));
  assert.equal(new UC({ ...opts, commit: RUNNING }).isStale(), true);
  await new UC({ ...opts, commit: RUNNING }).check();
  assert.equal(new UC({ ...opts, commit: RUNNING }).isStale(), false, 'a fresh check records the version it measured');

  // A version that GitHub doesn't know (fork, local changes) is reported, not an error.
  const { UpdateChecker } = await import('../src/updates.js');
  const st = await new UpdateChecker({ db: app.ctx.db, commit: 'f'.repeat(40), apiBase: up, repo: 'test/repo' }).check();
  assert.deepEqual([st.behind, st.error], [null, null]);
  assert.match(st.note, /not on GitHub/);
});

test('alerts: expiring account, failing source, empty guide; sent once, resolved once; ntfy and webhook', async () => {
  const sent = () => notified.splice(0);
  notified.length = 0;
  assert.equal((await api('POST', '/api/alerts/test')).status, 400, 'nothing configured yet');
  assert.equal((await api('PUT', '/api/settings', { notify_type: 'ntfy', notify_url: 'not a url' })).status, 400);
  await api('PUT', '/api/settings', { notify_type: 'ntfy', notify_url: `${up}/notify` });
  assert.equal((await api('POST', '/api/alerts/test')).status, 200);
  assert.deepEqual(sent().map((n) => n.title), ['Simple IPTV Manager test alert']);

  // Account expiring in 5 days: one reminder, not repeated on the next refresh.
  xcAccount.exp = Math.floor(Date.now() / 1000) + 5 * 86400 - 60;
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  let alerts = (await api('GET', '/api/alerts')).data;
  assert.ok(alerts.some((a) => a.kind === 'expiring' && /expires in 5 days/.test(a.title)));
  assert.deepEqual(sent().map((n) => n.title), ['XC account expires in 5 days']);
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  assert.deepEqual(sent(), [], 'no repeat');

  // A source failing three refreshes in a row: alert at the third, "resolved" once it is gone.
  const bad = (await api('POST', '/api/sources', { name: 'Flaky', type: 'xc', xc_host: up, xc_username: 'no', xc_password: 'no' })).data;
  await app.ctx.jobs.idle();
  for (let i = 0; i < 2; i++) {
    await api('POST', `/api/sources/${bad.id}/refresh`);
    await app.ctx.jobs.idle();
  }
  const failing = sent().filter((n) => /Flaky/.test(n.title));
  assert.deepEqual(failing.map((n) => [n.title, n.priority]), [['Flaky keeps failing', 'high']]);
  assert.match(failing[0].body, /last 3 refreshes failed: Xtream Codes login was rejected/);
  await api('DELETE', `/api/sources/${bad.id}`);
  await app.ctx.alerts.evaluate();
  assert.deepEqual(sent().map((n) => n.title), ['Resolved: Flaky keeps failing']);

  // Webhook: JSON body. A guide with nothing airing now raises its own alert.
  await api('PUT', '/api/settings', { notify_type: 'webhook' });
  const gen = app.ctx.db.get('SELECT epg_gen FROM sources WHERE id = ?', [xcId]).epg_gen;
  const t = Math.floor(Date.now() / 1000);
  app.ctx.db.run('UPDATE programmes SET stop_ts = ? WHERE source_id = ? AND gen = ? AND start_ts <= ?', [t - 1, xcId, gen, t]);
  await app.ctx.alerts.evaluate();
  const hook = sent().map((n) => JSON.parse(n.body));
  assert.deepEqual(hook.map((h) => [h.event, h.kind, h.level, h.source_id]), [['alert', 'guide', 'warn', xcId]]);
  assert.match(hook[0].title, /guide has nothing on now/);

  // Refresh brings the guide back and the account far from expiry: guide resolved, expiring just ends.
  xcAccount.exp = 1900000000;
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  assert.deepEqual(sent().map((n) => JSON.parse(n.body)).map((h) => [h.event, h.kind]), [['resolved', 'guide']]);
  assert.equal((await api('GET', '/api/alerts')).data.length, 0);

  // Exports carry the target; the URL only with secrets.
  assert.equal((await api('GET', '/api/export')).data.settings.notify_url, `${up}/notify`);
  assert.equal((await api('GET', '/api/export?secrets=0')).data.settings.notify_url, '');
  await api('PUT', '/api/settings', { notify_type: '', notify_url: '' });
});

test('automatic backups: saved daily, 14 kept, downloadable, restorable, no path tricks', async () => {
  const dir = path.join(dataDir, 'backups');
  // Older backups than we keep: the oldest are dropped when a new one is saved.
  fs.mkdirSync(dir, { recursive: true });
  for (let d = 1; d <= 16; d++) fs.writeFileSync(path.join(dir, `settings-2020-01-${String(d).padStart(2, '0')}.json`), '{}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a backup');

  let r = await api('GET', '/api/backups');
  assert.equal(r.data.enabled, true, 'on by default');
  app.ctx.autoBackup.tick(); // what the hourly timer does
  r = await api('GET', '/api/backups');
  const d = new Date();
  const today = `settings-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  assert.equal(r.data.files.length, 14);
  assert.equal(r.data.files[0].name, today, 'newest first');
  assert.ok(!r.data.files.some((f) => f.name === 'settings-2020-01-01.json'), 'oldest dropped');
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'other files left alone');

  // The saved file is a full export, secrets included.
  const saved = JSON.parse(fs.readFileSync(path.join(dir, today), 'utf8'));
  assert.equal(saved.format, 'iptv-manager-settings');
  assert.equal(saved.sources.find((s) => s.type === 'xc').xc_password, 'xp');

  const dl = await fetch(`${base}/api/backups/${today}`, { headers: { cookie } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  for (const bad of ['..%2Fiptv-manager.db', 'notes.txt', 'settings-2020-01-01.json']) {
    assert.equal((await fetch(`${base}/api/backups/${bad}`, { headers: { cookie } })).status, 404, bad);
  }
  assert.equal((await fetch(`${base}/api/backups/${today}`)).status, 401, 'admin only');

  // Switched off: the daily tick does nothing; "Back up now" still works.
  await api('PUT', '/api/settings', { auto_backup: false });
  fs.rmSync(path.join(dir, today));
  app.ctx.autoBackup.tick();
  assert.ok(!fs.existsSync(path.join(dir, today)));
  r = await api('POST', '/api/backups');
  assert.equal(r.data.name, today);
  await api('PUT', '/api/settings', { auto_backup: true });

  // Restore: change something, restore today's backup, and the change is undone.
  const before = (await api('GET', '/api/outputs')).data.map((o) => o.name).sort();
  const extra = (await api('POST', '/api/outputs', { name: 'Made after the backup' })).data;
  assert.ok((await api('GET', '/api/outputs')).data.some((o) => o.id === extra.id));
  r = await api('POST', `/api/backups/${today}/restore`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await app.ctx.jobs.idle();
  assert.deepEqual((await api('GET', '/api/outputs')).data.map((o) => o.name).sort(), before);
});
