// Movies and series: loading them from a source and storing them. Live TV stays in ingest.js;
// VOD is refreshed on its own, slower schedule because catalogs are large.
import { download, fetchJson } from './fetch.js';
import { jsonObjects } from './jsonstream.js';
import { now } from './db.js';

const CHUNK = 2000;
export const yieldToLoop = () => new Promise((r) => setImmediate(r));

/** "Show Name S01 E02", "Show.Name.S01E02", "Show - S1E2 - Title" -> { show, season, episode }. */
export function parseEpisodeName(name) {
  const m = /^(.*?)[\s._-]*\bS(\d{1,3})[\s._-]*E(\d{1,4})\b/i.exec(String(name || ''));
  if (!m || !m[1].trim()) return null;
  let show = m[1].replace(/[\s._-]+$/, '').trim();
  // Release-style names ("The.Office.US") use dots for spaces.
  if (!/\s/.test(show)) show = show.replace(/[._]+/g, ' ');
  return { show, season: Number(m[2]), episode: Number(m[3]) };
}

const num = (v) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : null);
const firstCat = (o) => String(o.category_id ?? (Array.isArray(o.category_ids) ? o.category_ids[0] : '') ?? '');

/**
 * Movies and series from an Xtream Codes account. Each list is downloaded to a file and read one
 * entry at a time, and each entry's own JSON is kept to pass on to players.
 */
export async function loadXcVod(src, api, { tmpFile, tmps, userAgent }) {
  const opts = { userAgent };
  const categories = [];
  const items = [];
  for (const [kind, catAction, listAction, idField] of [
    ['movie', 'get_vod_categories', 'get_vod_streams', 'stream_id'],
    ['series', 'get_series_categories', 'get_series', 'series_id'],
  ]) {
    const cats = await fetchJson(api(catAction), opts);
    const names = new Map();
    for (const c of Array.isArray(cats) ? cats : []) {
      const id = String(c.category_id);
      const name = String(c.category_name ?? '').trim() || `Category ${id}`;
      names.set(id, name);
      categories.push({ kind, name, xcId: id });
    }
    const file = tmpFile(`src${src.id}-${kind}`);
    tmps.push(file);
    await download(api(listAction), file, { userAgent });
    for await (const [text, o] of jsonObjects(file)) {
      const key = o[idField];
      if (key == null || key === '') continue;
      items.push({
        kind,
        key: String(key),
        name: String(o.name ?? '').trim() || `${kind === 'movie' ? 'Movie' : 'Series'} ${key}`,
        poster: (kind === 'movie' ? o.stream_icon : o.cover) || null,
        ext: kind === 'movie' ? String(o.container_extension || 'mp4') : null,
        url: null,
        added: num(kind === 'movie' ? o.added : o.last_modified),
        extra: text,
        group: names.get(firstCat(o)) || 'Uncategorized',
      });
    }
  }
  return { categories, items, episodes: [] };
}

/** Movies and series episodes found in an M3U playlist (by their URL: /movie/ or /series/). */
export function m3uVod(entries) {
  const items = [];
  const episodes = [];
  const seenMovie = new Map();
  const series = new Map(); // show key -> item
  for (const e of entries) {
    const group = e.group.trim() || 'Uncategorized';
    const logo = e.attrs['tvg-logo'] || null;
    const ext = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(e.url)?.[1]?.toLowerCase() || 'mp4';
    const ep = /\/series\//i.test(e.url) ? parseEpisodeName(e.name) : null;
    if (ep) {
      const key = `${group}|${ep.show}`;
      if (!series.has(key)) {
        const item = { kind: 'series', key, name: ep.show, poster: logo, ext: null, url: null, added: null, extra: null, group };
        series.set(key, item);
        items.push(item);
      }
      episodes.push({ seriesKey: key, key: `${ep.season}x${ep.episode}`, season: ep.season, episode: ep.episode, title: e.name, ext, url: e.url });
      continue;
    }
    const base = `${group}|${e.name}`;
    const n = (seenMovie.get(base) || 0) + 1;
    seenMovie.set(base, n);
    items.push({ kind: 'movie', key: n > 1 ? `${base}#${n}` : base, name: e.name || 'Untitled', poster: logo, ext, url: e.url, added: null, extra: null, group });
  }
  return { categories: [], items, episodes };
}

/**
 * Store a VOD load. Rows are written in chunks so live streams keep flowing meanwhile; what the
 * load no longer lists is switched off only at the end, so outputs never see a half catalog.
 */
export async function applyVod(db, src, vod) {
  const t = now();
  // Items are marked with this (milliseconds, so back-to-back refreshes differ) to find the gone ones.
  const mark = Date.now();
  // The first VOD load of a source counts as part of its first refresh, so its categories aren't
  // all flagged "new"; after that, categories are new as of the refresh that found them.
  const refresh = src.vod_refreshed_at ? src.refresh_count : 1;
  const cats = [...vod.categories];
  const known = new Set(cats.map((c) => `${c.kind}|${c.name}`));
  for (const it of vod.items) {
    const k = `${it.kind}|${it.group}`;
    if (!known.has(k)) {
      known.add(k);
      cats.push({ kind: it.kind, name: it.group, xcId: null });
    }
  }
  let added = 0;
  const catIds = new Map();
  db.tx(() => {
    cats.forEach((c, i) => {
      const k = `${c.kind}|${c.name}`;
      if (catIds.has(k)) return;
      const r = db.get(
        `INSERT INTO categories (source_id, kind, name, xc_id, sort, active, added_in, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (source_id, kind, name) DO UPDATE SET
           xc_id = excluded.xc_id, sort = excluded.sort, active = 1, last_seen = excluded.last_seen
         RETURNING id, added_in`,
        [src.id, c.kind, c.name, c.xcId, i, refresh, t, t],
      );
      if (r.added_in === refresh && refresh > 1) added++;
      catIds.set(k, r.id);
    });
  });

  const itemIds = new Map(); // "series|key" -> id, for M3U episodes
  for (let i = 0; i < vod.items.length; i += CHUNK) {
    db.tx(() => {
      for (let j = i; j < Math.min(i + CHUNK, vod.items.length); j++) {
        const it = vod.items[j];
        const r = db.get(
          `INSERT INTO vod_items (source_id, category_id, kind, key, name, poster, ext, url, added, extra, sort, active, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT (source_id, kind, key) DO UPDATE SET
             category_id = excluded.category_id, name = excluded.name, poster = excluded.poster, ext = excluded.ext,
             url = excluded.url, added = excluded.added, extra = excluded.extra, sort = excluded.sort,
             active = 1, last_seen = excluded.last_seen
           RETURNING id`,
          [src.id, catIds.get(`${it.kind}|${it.group}`), it.kind, it.key, it.name, it.poster, it.ext, it.url, it.added, it.extra, j, t, mark],
        );
        if (it.kind === 'series') itemIds.set(it.key, r.id);
      }
    });
    await yieldToLoop();
  }
  for (let i = 0; i < vod.episodes.length; i += CHUNK) {
    db.tx(() => {
      for (const e of vod.episodes.slice(i, i + CHUNK)) {
        db.run(
          `INSERT INTO vod_episodes (series_id, key, season, episode, title, ext, url) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (series_id, key) DO UPDATE SET season = excluded.season, episode = excluded.episode,
             title = excluded.title, ext = excluded.ext, url = excluded.url`,
          [itemIds.get(e.seriesKey), e.key, e.season, e.episode, e.title, e.ext, e.url],
        );
      }
    });
    await yieldToLoop();
  }
  db.tx(() => {
    const keep = new Set(catIds.values());
    for (const c of db.all(`SELECT id FROM categories WHERE source_id = ? AND kind IN ('movie', 'series') AND active = 1`, [src.id])) {
      if (!keep.has(c.id)) db.run('UPDATE categories SET active = 0 WHERE id = ?', [c.id]);
    }
    db.run('UPDATE vod_items SET active = 0 WHERE source_id = ? AND last_seen <> ?', [src.id, mark]);
  });
  const count = (kind) => vod.items.filter((it) => it.kind === kind).length;
  return { movies: count('movie'), series: count('series'), categories: catIds.size, newCategories: added };
}

/** Switch a source's movies and series off (its setting went back to live TV only). */
export function clearVod(db, sourceId) {
  db.tx(() => {
    db.run(`UPDATE categories SET active = 0 WHERE source_id = ? AND kind IN ('movie', 'series')`, [sourceId]);
    db.run('UPDATE vod_items SET active = 0 WHERE source_id = ?', [sourceId]);
  });
}
