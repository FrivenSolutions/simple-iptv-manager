// Movies and series over the Xtream Codes API of an output. Lists come from the database; a
// movie's details and a series' episodes are asked of the provider when a player opens them.
import { fetchJson } from '../fetch.js';
import { xcBase } from '../ingest.js';
import { now } from '../db.js';

function parse(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function providerApi(src) {
  const base = xcBase(src.xc_host);
  const u = encodeURIComponent(src.xc_username || '');
  const p = encodeURIComponent(src.xc_password || '');
  return {
    base, u, p,
    call: (action, extra) => fetchJson(`${base}/player_api.php?username=${u}&password=${p}&action=${action}${extra}`, { userAgent: src.user_agent }),
  };
}

// Names as players see them: a name set by hand, else the provider's after the output's name
// cleanup, then wrapped in the source's category prefix and suffix.
const catName = (vc, c) => vc.affix(c.source_id, c.custom_name || vc.clean.category(c.name, c.source_id));
const title = (vc, name, source) => vc.clean.channel(name, source);
// A title's own display name (set by hand) wins over name cleanup.
const itemName = (vc, r) => r.custom_name || title(vc, r.name, r.source_id);

/** Included categories of a kind that hold at least one title that is in. */
export function vodCategoryList(vc) {
  return vc.cats.filter((c) => c.included && c.channel_count - (c.excluded_count || 0) > 0)
    .map((c) => ({ category_id: String(c.id), category_name: catName(vc, c), parent_id: 0 }));
}

function itemsOf(db, vc, categoryId) {
  const ids = categoryId ? [Number(categoryId)].filter((id) => vc.included.has(id)) : [...vc.included];
  if (!ids.length) return [];
  return db.all(
    `SELECT id, source_id, category_id, name, custom_name, poster, ext, added, extra FROM vod_items
      WHERE active = 1 AND category_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  ).filter((r) => !vc.excluded.has(r.id)).sort((a, b) => vc.order.get(a.category_id) - vc.order.get(b.category_id) || 0);
}

export function vodStreams(db, vc, categoryId) {
  return itemsOf(db, vc, categoryId).map((r, i) => ({
    ...parse(r.extra),
    num: i + 1,
    name: itemName(vc, r),
    stream_type: 'movie',
    stream_id: r.id,
    stream_icon: r.poster || '',
    added: String(r.added || ''),
    category_id: String(r.category_id),
    category_ids: [r.category_id],
    container_extension: r.ext || 'mp4',
    custom_sid: '',
    direct_source: '',
  }));
}

export function seriesList(db, vc, categoryId) {
  return itemsOf(db, vc, categoryId).map((r, i) => ({
    ...parse(r.extra),
    num: i + 1,
    name: itemName(vc, r),
    series_id: r.id,
    cover: r.poster || '',
    last_modified: String(r.added || ''),
    category_id: String(r.category_id),
    category_ids: [r.category_id],
  }));
}

/** A movie or series of this output (active, in an included category), with its source. */
export function vodItem(db, vc, id, kind) {
  const it = db.get('SELECT * FROM vod_items WHERE id = ? AND kind = ? AND active = 1', [Number(id), kind]);
  if (!it || !vc.included.has(it.category_id) || vc.excluded.has(it.id)) return null;
  it.src = db.get('SELECT * FROM sources WHERE id = ?', [it.source_id]);
  return it;
}

export async function vodInfo(db, vc, id) {
  const it = vodItem(db, vc, id, 'movie');
  if (!it) return {};
  const movieData = { stream_id: it.id, name: itemName(vc, it), added: String(it.added || ''), category_id: String(it.category_id), container_extension: it.ext || 'mp4', custom_sid: '', direct_source: '' };
  let info = { name: itemName(vc, it), movie_image: it.poster || '', cover_big: it.poster || '' };
  if (it.src.type === 'xc') {
    try {
      const r = await providerApi(it.src).call('get_vod_info', `&vod_id=${encodeURIComponent(it.key)}`);
      if (r && typeof r.info === 'object' && !Array.isArray(r.info)) info = { ...info, ...r.info, name: info.name };
    } catch {
      // The list's own details are enough to play it.
    }
  }
  return { info, movie_data: movieData };
}

/**
 * Seasons and episodes of a series. Episode ids are this server's own (stable per provider
 * episode), so the stream URL can be checked against the output and mapped back.
 */
export async function seriesInfo(db, vc, id) {
  const it = vodItem(db, vc, id, 'series');
  if (!it) return {};
  const extra = parse(it.extra);
  const name = itemName(vc, it);
  let info = { ...extra, name, cover: it.poster || '', category_id: String(it.category_id) };
  let seasons = [];
  if (it.src.type === 'xc') {
    let r;
    try {
      r = await providerApi(it.src).call('get_series_info', `&series_id=${encodeURIComponent(it.key)}`);
    } catch {
      r = null;
    }
    if (r && typeof r === 'object') {
      if (r.info && typeof r.info === 'object' && !Array.isArray(r.info)) info = { ...info, ...r.info, name, category_id: String(it.category_id) };
      if (Array.isArray(r.seasons)) seasons = r.seasons;
      // Panels return episodes as { "1": [...] } or as a flat list.
      const lists = Array.isArray(r.episodes) ? [r.episodes.flat()] : Object.values(r.episodes || {});
      db.tx(() => {
        for (const eps of lists) {
          for (const e of Array.isArray(eps) ? eps : []) {
            if (e?.id == null) continue;
            db.run(
              `INSERT INTO vod_episodes (series_id, key, season, episode, title, ext, info) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (series_id, key) DO UPDATE SET season = excluded.season, episode = excluded.episode,
                 title = excluded.title, ext = excluded.ext, info = excluded.info`,
              [it.id, String(e.id), Number(e.season) || null, Number(e.episode_num) || null, String(e.title ?? ''),
                String(e.container_extension || 'mp4'), JSON.stringify(e)],
            );
          }
        }
      });
    }
  }
  const eps = db.all('SELECT * FROM vod_episodes WHERE series_id = ? ORDER BY season, episode, id', [it.id]);
  const episodes = {};
  for (const e of eps) {
    const season = String(e.season ?? 1);
    const raw = parse(e.info);
    (episodes[season] ||= []).push({
      ...raw,
      id: String(e.id),
      episode_num: e.episode ?? raw.episode_num ?? 0,
      title: title(vc, e.title || raw.title || '', it.source_id),
      container_extension: e.ext || 'mp4',
      season: e.season ?? 1,
      info: raw.info && typeof raw.info === 'object' ? raw.info : {},
      custom_sid: '',
      added: String(raw.added || now()),
      direct_source: '',
    });
  }
  if (!seasons.length) {
    seasons = Object.keys(episodes).map((n) => ({ season_number: Number(n), name: `Season ${n}`, episode_count: episodes[n].length }));
  }
  return { seasons, info, episodes };
}

/** Where a movie or episode actually plays from, if it belongs to this output. */
export function vodTarget(db, vc, kind, id) {
  if (kind === 'movie') {
    const it = vodItem(db, vc.movie, id, 'movie');
    if (!it) return null;
    const api = it.src.type === 'xc' ? providerApi(it.src) : null;
    const url = api ? `${api.base}/movie/${api.u}/${api.p}/${it.key}.${it.ext || 'mp4'}` : it.url;
    return url ? { key: `movie:${it.id}`, url, src: it.src, title: it.custom_name || it.name } : null;
  }
  const ep = db.get('SELECT * FROM vod_episodes WHERE id = ?', [Number(id)]);
  const it = ep && vodItem(db, vc.series, ep.series_id, 'series');
  if (!it) return null;
  const api = it.src.type === 'xc' ? providerApi(it.src) : null;
  const url = api ? `${api.base}/series/${api.u}/${api.p}/${ep.key}.${ep.ext || 'mp4'}` : ep.url;
  const title = `${it.custom_name || it.name} · S${ep.season ?? 1} E${ep.episode ?? '?'}${ep.title && !ep.title.includes(it.name) ? ` ${ep.title}` : ''}`;
  return url ? { key: `episode:${ep.id}`, url, src: it.src, title } : null;
}
