import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { download, fetchJson, openMaybeGzip, redact } from './fetch.js';
import { parseM3UFile, isVod } from './m3u.js';
import { parseXmltv, parseXmltvTime } from './xmltv.js';
import { matchChannels } from './epgmatch.js';
import { loadHdhrLineup, buildHdhrGuide } from './hdhomerun.js';
import { now } from './db.js';
import { loadXcVod, m3uVod, applyVod, clearVod, yieldToLoop } from './vod.js';

const PROGRAMME_PAST_S = 6 * 3600;
const BATCH = 2000;

export function splitUrls(s) {
  return String(s || '')
    .split(/[\r\n]+|,(?=\s*(?:https?:|upload:))/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function xcBase(host) {
  let h = String(host || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  return h.replace(/\/(player_api|get|xmltv)\.php.*$/i, '');
}

function tmpFile(ctx, label) {
  const dir = path.join(ctx.dataDir, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${label}-${crypto.randomBytes(6).toString('hex')}`);
}

async function loadXc(ctx, src) {
  const base = xcBase(src.xc_host);
  const u = encodeURIComponent(src.xc_username || '');
  const p = encodeURIComponent(src.xc_password || '');
  const api = (action) => `${base}/player_api.php?username=${u}&password=${p}${action ? `&action=${action}` : ''}`;
  const opts = { userAgent: src.user_agent };

  const info = await fetchJson(api(), opts);
  if (!info || !info.user_info || Number(info.user_info.auth) === 0) {
    throw new Error('Xtream Codes login was rejected (check host, username and password)');
  }
  const cats = await fetchJson(api('get_live_categories'), opts);
  const streams = await fetchJson(api('get_live_streams'), opts);
  if (!Array.isArray(streams)) throw new Error('Xtream Codes get_live_streams did not return a list');

  const catNames = new Map();
  const categories = [];
  for (const c of Array.isArray(cats) ? cats : []) {
    const id = String(c.category_id);
    const name = String(c.category_name ?? '').trim() || `Category ${id}`;
    catNames.set(id, name);
    categories.push({ name, xcId: id });
  }

  const ext = src.xc_stream_ext === 'm3u8' ? 'm3u8' : 'ts';
  const items = streams.map((s) => {
    const catId = String(s.category_id ?? (Array.isArray(s.category_ids) ? s.category_ids[0] : '') ?? '');
    return {
      key: `xc:${s.stream_id}`,
      name: String(s.name ?? '').trim() || `Stream ${s.stream_id}`,
      tvgId: s.epg_channel_id || '',
      tvgName: '',
      logo: s.stream_icon || '',
      group: catNames.get(catId) || 'Uncategorized',
      url: `${base}/live/${u}/${p}/${s.stream_id}.${ext}`,
      chno: s.num != null ? String(s.num) : null,
      xcStreamId: String(s.stream_id),
      extra: null,
    };
  });

  const ui = info.user_info;
  const account = {
    status: ui.status ?? null,
    exp_date: ui.exp_date ?? null,
    max_connections: ui.max_connections ?? null,
    active_cons: ui.active_cons ?? null,
    is_trial: ui.is_trial ?? null,
  };
  const epgUrls = [`${base}/xmltv.php?username=${u}&password=${p}`, ...splitUrls(src.epg_urls)];
  return { items, categories, epgUrls, account, api };
}

async function loadHdhr(src) {
  const { disc, items, account } = await loadHdhrLineup(src);
  return { items, categories: [], epgUrls: splitUrls(src.epg_urls), account, hdhrDisc: disc };
}

async function loadM3u(ctx, src, tmps) {
  if (!src.url) throw new Error('No playlist URL configured');
  const tmp = tmpFile(ctx, `src${src.id}-m3u`);
  tmps.push(tmp);
  const file = await download(src.url, tmp, { userAgent: src.user_agent, dataDir: ctx.dataDir });
  const { header, entries } = await parseM3UFile(file);

  // Channel identity survives refreshes via tvg-id + name; duplicates get a counter.
  const seen = new Map();
  const items = [];
  const vodEntries = [];
  for (const e of entries) {
    if (isVod(e.url)) {
      if (!src.live_only) vodEntries.push(e);
      continue;
    }
    const tvgId = e.attrs['tvg-id'] || '';
    const base = `${tvgId}|${e.name}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    items.push({
      key: n > 1 ? `${base}#${n}` : base,
      name: e.name || 'Unnamed',
      tvgId,
      tvgName: e.attrs['tvg-name'] || '',
      logo: e.attrs['tvg-logo'] || '',
      group: e.group.trim() || 'Uncategorized',
      url: e.url,
      chno: e.attrs['tvg-chno'] || e.attrs['channel-number'] || null,
      xcStreamId: null,
      extra: e.opts.length ? JSON.stringify({ opts: e.opts }) : null,
    });
  }

  // "Auto associate": a playlist that names its own guide uses it unless EPG URLs are set.
  let epgUrls = splitUrls(src.epg_urls);
  if (!epgUrls.length) {
    const fromHeader = header['url-tvg'] || header['x-tvg-url'] || '';
    epgUrls = fromHeader.split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  }
  return { items, categories: [], epgUrls, account: null, vod: src.live_only ? null : m3uVod(vodEntries) };
}

function applyPlaylist(db, src, items, categories) {
  const t = now();
  // Every group used by a channel needs a category row, in first-seen order.
  const cats = [...categories];
  const known = new Set(cats.map((c) => c.name));
  for (const it of items) {
    if (!known.has(it.group)) {
      known.add(it.group);
      cats.push({ name: it.group, xcId: null });
    }
  }

  let added = 0;
  const refresh = src.refresh_count + 1;
  db.tx(() => {
    db.run('UPDATE sources SET refresh_count = ? WHERE id = ?', [refresh, src.id]);
    db.run("UPDATE categories SET active = 0 WHERE source_id = ? AND kind = 'live'", [src.id]);
    const catIds = new Map();
    cats.forEach((c, i) => {
      if (catIds.has(c.name)) return;
      const r = db.get(
        `INSERT INTO categories (source_id, name, xc_id, sort, active, added_in, first_seen, last_seen)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (source_id, kind, name) DO UPDATE SET
           xc_id = excluded.xc_id, sort = excluded.sort, active = 1, last_seen = excluded.last_seen
         RETURNING id, added_in`,
        [src.id, c.name, c.xcId, i, refresh, t, t],
      );
      if (r.added_in === refresh && refresh > 1) added++;
      catIds.set(c.name, r.id);
    });

    db.run('UPDATE channels SET active = 0 WHERE source_id = ?', [src.id]);
    items.forEach((it, i) => {
      db.run(
        `INSERT INTO channels (source_id, category_id, key, name, tvg_id, tvg_name, logo, url, chno,
                               xc_stream_id, extra, sort, active, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (source_id, key) DO UPDATE SET
           category_id = excluded.category_id, name = excluded.name, tvg_id = excluded.tvg_id,
           tvg_name = excluded.tvg_name, logo = excluded.logo, url = excluded.url, chno = excluded.chno,
           xc_stream_id = excluded.xc_stream_id, extra = excluded.extra, sort = excluded.sort,
           active = 1, last_seen = excluded.last_seen`,
        [src.id, catIds.get(it.group), it.key, it.name, it.tvgId, it.tvgName, it.logo, it.url, it.chno,
          it.xcStreamId, it.extra, i, t, t],
      );
    });
  });
  return { categories: cats.length, newCategories: added };
}

/**
 * Days of guide to keep for a source: the most any output using it publishes (Guide days), plus a
 * day so the output's window, which moves on with the clock, stays covered until the next refresh.
 * A source no output uses yet keeps the default of 7.
 */
export function guideDaysKept(db, sourceId) {
  const r = db.get(
    'SELECT MAX(o.epg_days) AS d FROM outputs o JOIN output_sources os ON os.output_id = o.id WHERE os.source_id = ?',
    [sourceId],
  );
  return (r?.d || 7) + 1;
}

/** Re-run EPG association for a source against the EPG channels already stored. */
export function rematchSource(db, sourceId) {
  const src = db.get('SELECT id, epg_gen FROM sources WHERE id = ?', [sourceId]);
  if (!src) return null;
  const epg = db
    .all('SELECT xml_id, names FROM epg_channels WHERE source_id = ? AND gen = ?', [src.id, src.epg_gen])
    .map((r) => ({ id: r.xml_id, names: JSON.parse(r.names || '[]') }));
  const chans = db.all(
    'SELECT id, name, tvg_id, tvg_name, custom_name, custom_epg_id FROM channels WHERE source_id = ? AND active = 1',
    [src.id],
  );
  const matches = matchChannels(chans, epg);
  db.tx(() => {
    for (const [id, m] of matches) db.run('UPDATE channels SET epg_id = ?, epg_match = ? WHERE id = ?', [m.epgId, m.how, id]);
  });
  return matches;
}

// localFiles: guides already on disk (the HDHomeRun guide); warnings: earlier guide failures.
async function loadEpg(ctx, src, epgUrls, tmps, localFiles = [], warnings = []) {
  const { db } = ctx;
  if (!epgUrls.length && !localFiles.length) return warnings.length ? { urls: 0, error: warnings.join('; ') } : { urls: 0 };

  const files = [...localFiles];
  const errors = [...warnings];
  for (const url of epgUrls) {
    const tmp = tmpFile(ctx, `src${src.id}-epg`);
    tmps.push(tmp);
    try {
      files.push(await download(url, tmp, { userAgent: src.user_agent, dataDir: ctx.dataDir }));
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (!files.length) return { urls: epgUrls.length, error: `EPG download failed: ${errors.join('; ')}` };

  // Pass 1: channel list. XMLTV puts <channel> before <programme>, so stop at the first programme.
  const epgChans = new Map();
  for (const f of files) {
    await parseXmltv(await openMaybeGzip(f), {
      onChannel: (c) => {
        if (c.id && !epgChans.has(c.id)) epgChans.set(c.id, c);
      },
      onProgramme: () => false,
    });
  }
  if (!epgChans.size) return { urls: epgUrls.length, error: 'EPG contained no channels' };

  const gen = src.epg_gen + 1;
  db.tx(() => {
    db.run('DELETE FROM programmes WHERE source_id = ? AND gen = ?', [src.id, gen]);
    db.run('DELETE FROM epg_channels WHERE source_id = ? AND gen = ?', [src.id, gen]);
    for (const c of epgChans.values()) {
      db.run('INSERT INTO epg_channels (source_id, gen, xml_id, names, icon) VALUES (?, ?, ?, ?, ?)', [
        src.id, gen, c.id, JSON.stringify(c.names), c.icon || null,
      ]);
    }
  });

  const chans = db.all(
    'SELECT id, name, tvg_id, tvg_name, custom_name, custom_epg_id FROM channels WHERE source_id = ? AND active = 1',
    [src.id],
  );
  const matches = matchChannels(chans, [...epgChans.values()]);
  const needed = new Set();
  for (const m of matches.values()) if (m.epgId) needed.add(m.epgId);

  // Pass 2: programs for matched channels only, inside a rolling time window.
  const t = now();
  const minTs = t - PROGRAMME_PAST_S;
  const maxTs = t + guideDaysKept(db, src.id) * 86400;
  const ownerFile = new Map(); // first file to supply a channel's programs wins
  let count = 0;
  let batch = [];
  const flush = () => {
    if (!batch.length) return;
    const rows = batch;
    batch = [];
    db.tx(() => {
      for (const r of rows) {
        db.run(
          `INSERT INTO programmes (source_id, gen, channel, start_ts, stop_ts, start, stop, xml)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          r,
        );
      }
    });
  };
  // Pass 1 stops at the first program, as XMLTV lists channels first. Guides merged from
  // several sources often don't: a channel met here for the first time is recorded and matched
  // to still-unmatched playlist channels on the spot, before its programs stream past.
  const lateChannel = (c) => {
    if (!c.id || epgChans.has(c.id)) return;
    epgChans.set(c.id, c);
    db.run('INSERT OR IGNORE INTO epg_channels (source_id, gen, xml_id, names, icon) VALUES (?, ?, ?, ?, ?)', [
      src.id, gen, c.id, JSON.stringify(c.names), c.icon || null,
    ]);
    const unmatched = chans.filter((ch) => !matches.get(ch.id)?.epgId);
    for (const [id, m] of matchChannels(unmatched, [c])) {
      if (!m.epgId) continue;
      matches.set(id, m);
      needed.add(m.epgId);
    }
  };
  for (let fi = 0; fi < files.length; fi++) {
    await parseXmltv(await openMaybeGzip(files[fi]), {
      onChannel: lateChannel,
      onProgramme: (p) => {
        if (!needed.has(p.channel)) return;
        const owner = ownerFile.get(p.channel);
        if (owner === undefined) ownerFile.set(p.channel, fi);
        else if (owner !== fi) return;
        const s = parseXmltvTime(p.start);
        if (s == null) return;
        const e = parseXmltvTime(p.stop) ?? s + 3600;
        if (e < minTs || s > maxTs) return;
        batch.push([src.id, gen, p.channel, s, e, p.start, p.stop, p.xml]);
        count++;
        if (batch.length >= BATCH) flush();
      },
    });
  }
  flush();

  db.tx(() => {
    for (const [id, m] of matches) db.run('UPDATE channels SET epg_id = ?, epg_match = ? WHERE id = ?', [m.epgId, m.how, id]);
    db.run('UPDATE sources SET epg_gen = ? WHERE id = ?', [gen, src.id]);
    db.run('DELETE FROM epg_channels WHERE source_id = ? AND gen <> ?', [src.id, gen]);
  });
  // The old guide goes in slices: one delete of a million listings would hold them all in the
  // write-ahead log at once, needing about as much free disk again as the guide itself.
  while (db.run(
    'DELETE FROM programmes WHERE rowid IN (SELECT rowid FROM programmes WHERE source_id = ? AND gen <> ? LIMIT ?)',
    [src.id, gen, BATCH * 10],
  ).changes) await yieldToLoop();

  let matched = 0;
  for (const m of matches.values()) if (m.epgId && epgChans.has(m.epgId)) matched++;
  return {
    urls: epgUrls.length,
    channels: epgChans.size,
    programmes: count,
    matched,
    error: errors.length ? `Some EPG URLs failed: ${errors.join('; ')}` : undefined,
  };
}

/**
 * Movies and series for a source, when its setting includes them. M3U playlists list them with the
 * live channels, so they come along every time; Xtream Codes accounts have separate (large) lists,
 * loaded when the VOD interval is due or on a manual refresh. Returns stats, or null if not loaded.
 */
async function refreshVod(ctx, src, data, tmps, force) {
  const { db } = ctx;
  if (src.type === 'hdhr') return null;
  if (src.live_only) {
    if (db.get('SELECT 1 FROM vod_items WHERE source_id = ? AND active = 1 LIMIT 1', [src.id])) clearVod(db, src.id);
    return null;
  }
  const t = now();
  let vod = data.vod;
  if (src.type === 'xc') {
    const due = force || !src.vod_refreshed_at
      || (src.vod_refresh_minutes > 0 && src.vod_refreshed_at + src.vod_refresh_minutes * 60 <= t);
    if (!due) return null;
    vod = await loadXcVod(src, data.api, { tmpFile: (label) => tmpFile(ctx, label), tmps, userAgent: src.user_agent });
  }
  if (!vod) return null;
  const started = Date.now();
  if (!vod.items.length && db.get('SELECT 1 FROM vod_items WHERE source_id = ? AND active = 1 LIMIT 1', [src.id])) {
    throw new Error('The source listed no movies or series; keeping the previous ones');
  }
  const stats = await applyVod(db, src, vod);
  stats.seconds = Math.round((Date.now() - started) / 100) / 10;
  db.run('UPDATE sources SET vod_refreshed_at = ?, vod_stats = ? WHERE id = ?', [t, JSON.stringify(stats), src.id]);
  ctx.bump();
  return stats;
}

export async function refreshSource(ctx, id, { forceVod = false } = {}) {
  const { db, log } = ctx;
  const src = db.get('SELECT * FROM sources WHERE id = ?', [id]);
  if (!src) return;
  const started = Date.now();
  const tmps = [];
  log(`Refreshing source "${src.name}"`);
  try {
    const data = src.type === 'xc' ? await loadXc(ctx, src)
      : src.type === 'hdhr' ? await loadHdhr(src)
      : await loadM3u(ctx, src, tmps);
    const vodOnly = !data.items.length && data.vod?.items.length;
    if (!data.items.length && !vodOnly) throw new Error('Source returned no live channels; keeping the previous data');
    const cat = vodOnly ? { categories: 0, newCategories: 0 } : applyPlaylist(db, src, data.items, data.categories);
    ctx.bump();

    let epg;
    const guideTmps = tmps.length;
    try {
      const localFiles = [];
      const warnings = [];
      let guideInfo = null;
      if (data.hdhrDisc) {
        const file = tmpFile(ctx, `src${src.id}-hdhr`);
        tmps.push(file);
        try {
          guideInfo = await buildHdhrGuide({ disc: data.hdhrDisc, file, apiBase: ctx.hdhrApi, userAgent: src.user_agent });
          localFiles.push(file);
        } catch (e) {
          warnings.push(`HDHomeRun guide failed: ${e.message}`);
        }
      }
      epg = await loadEpg(ctx, src, data.epgUrls, tmps, localFiles, warnings);
      if (guideInfo) {
        epg.hdhr = guideInfo.method === 'xmltv'
          ? 'SiliconDust XMLTV feed'
          : `SiliconDust guide service (${guideInfo.fallbackReason ? `XMLTV feed unavailable: ${redact(guideInfo.fallbackReason)}` : 'JSON'})`;
      }
    } catch (e) {
      epg = { error: `EPG failed: ${e.message}` };
    }
    // Downloaded guides can be hundreds of MB: gone before movies and series are stored.
    for (const f of tmps.splice(guideTmps)) fs.rmSync(f, { force: true });
    let vod = null;
    let vodError = null;
    try {
      vod = await refreshVod(ctx, { ...src, refresh_count: src.refresh_count + (vodOnly ? 0 : 1) }, data, tmps, forceVod);
    } catch (e) {
      vodError = `Movies & series: ${redact(e.message)}`;
      const prev = JSON.parse(src.vod_stats || 'null') || {};
      db.run('UPDATE sources SET vod_stats = ? WHERE id = ?', [JSON.stringify({ ...prev, error: vodError }), src.id]);
    }
    const warning = [epg.error ? redact(epg.error) : null, vodError].filter(Boolean).join('; ') || null;
    const stats = {
      channels: data.items.length,
      categories: cat.categories,
      newCategories: cat.newCategories,
      epg,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
    db.run(
      `UPDATE sources SET last_refresh_at = ?, first_refresh_at = COALESCE(first_refresh_at, ?),
         last_status = ?, last_error = ?, stats = ?, account_info = COALESCE(?, account_info), fail_count = 0 WHERE id = ?`,
      [now(), now(), warning ? 'warning' : 'ok', warning, JSON.stringify(stats),
        data.account ? JSON.stringify(data.account) : null, src.id],
    );
    log(`Source "${src.name}": ${stats.channels} channels, ${stats.categories} categories` +
      (stats.newCategories ? `, ${stats.newCategories} new` : '') +
      (epg.channels ? `, EPG ${epg.matched}/${stats.channels} matched, ${epg.programmes} programs` : '') +
      (vod ? `, ${vod.movies} movies, ${vod.series} series` : '') +
      ` in ${stats.seconds}s` + (warning ? ` (warning: ${warning})` : ''));
  } catch (e) {
    db.run('UPDATE sources SET last_refresh_at = ?, last_status = ?, last_error = ?, fail_count = fail_count + 1 WHERE id = ?', [
      now(), 'error', redact(e.message), src.id,
    ]);
    log(`Source "${src.name}" failed: ${redact(e.message)}`);
  } finally {
    ctx.bump();
    for (const f of tmps) fs.rm(f, { force: true }, () => {});
  }
}
