// Category filtering and channel selection for an output profile.
import { parseJellyfin } from './outputs/epg.js';
import { firstText } from './xmltv.js';

export const OPS = ['contains', 'not_contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with',
  'equals', 'not_equals', 'regex'];

export function testRule(rule, name) {
  const n = String(name || '').toLowerCase();
  const v = String(rule.value || '').toLowerCase();
  switch (rule.op) {
    case 'contains': return n.includes(v);
    case 'not_contains': return !n.includes(v);
    case 'starts_with': return n.startsWith(v);
    case 'not_starts_with': return !n.startsWith(v);
    case 'ends_with': return n.endsWith(v);
    case 'not_ends_with': return !n.endsWith(v);
    case 'equals': return n === v;
    case 'not_equals': return n !== v;
    case 'regex':
      try {
        return new RegExp(rule.value, 'i').test(name);
      } catch {
        return false;
      }
    default: return false;
  }
}

/**
 * Decide whether a category belongs in an output.
 *   1. A manual include/exclude always wins.
 *   2. Any matching exclude rule removes it.
 *   3. With include rules for its source, it must match at least one.
 *   4. With no include rules, the output's "include everything" default applies.
 * Rules are evaluated against the provider's category name, so new categories
 * that appear upstream are picked up automatically on the next refresh.
 */
export function categoryState(cat, rules, override, includeAll) {
  if (override) return { included: override === 'include', reason: 'manual' };
  const applicable = rules.filter((r) => r.source_id == null || r.source_id === cat.source_id);
  const exclude = applicable.find((r) => r.action === 'exclude' && testRule(r, cat.name));
  if (exclude) return { included: false, reason: 'rule', rule_id: exclude.id };
  const includes = applicable.filter((r) => r.action === 'include');
  if (!includes.length) return { included: !!includeAll, reason: 'default' };
  const hit = includes.find((r) => testRule(r, cat.name));
  return hit ? { included: true, reason: 'rule', rule_id: hit.id } : { included: false, reason: 'rule' };
}

/**
 * Decide whether a channel belongs in an output.
 *   1. The channel's category must be included; an excluded category excludes all of
 *      its channels. Hand picks inside it are kept, and apply again once it is included.
 *   2. A manual include/exclude on the channel then wins.
 *   3. Otherwise the category's channel rules refine it the same way category rules do:
 *      an exclude match removes it, and with include rules it must match one.
 * Channel rules match the provider's channel name, so channels the provider adds
 * later are sorted automatically too.
 */
export function channelState(name, catIncluded, rules, override, hidden = null) {
  if (!catIncluded) return { included: false, reason: 'category' };
  if (override) return { included: override === 'include', reason: 'manual' };
  // Placeholders for events that aren't on: by name ("Event 03:") -> 'empty', by what the
  // guide says is on now ("No Game Today") -> 'guide', or nothing in the guide now -> 'unlisted'.
  if (hidden) return { included: false, reason: hidden };
  const exclude = rules.find((r) => r.action === 'exclude' && testRule(r, name));
  if (exclude) return { included: false, reason: 'rule', rule_id: exclude.id };
  const includes = rules.filter((r) => r.action === 'include');
  if (!includes.length) return { included: true, reason: 'category' };
  const hit = includes.find((r) => testRule(r, name));
  return hit ? { included: true, reason: 'rule', rule_id: hit.id } : { included: false, reason: 'nomatch' };
}

// Event providers list idle placeholders whose names end in ":", "-", a number or "NO EVENT";
// once an event is scheduled the name gains a title ("Event 03: Team A vs Team B").
export const DEFAULT_EMPTY_EVENT_PATTERNS = [':\\s*$', '-\\s*$', '\\d\\s*$', 'no event\\s*$'];

// Guide titles that mean nothing is on. Matched against the title of the program airing now.
export const DEFAULT_GUIDE_PATTERNS = ['no game today', '^no event', '^no live event', '^off air'];

function patternSetting(db, key, defaults) {
  const raw = db.getSetting(key);
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    } catch {}
  }
  return defaults;
}

/** The configured empty-event name patterns (the defaults unless changed in Settings). */
export const emptyEventPatterns = (db) => patternSetting(db, 'empty_event_patterns', DEFAULT_EMPTY_EVENT_PATTERNS);
/** The configured guide-title patterns (the defaults unless changed in Settings). */
export const guidePatterns = (db) => patternSetting(db, 'guide_patterns', DEFAULT_GUIDE_PATTERNS);

/**
 * Title of the program airing at time t, per "sourceId|guide channel id", for the given
 * sources. One indexed query per source; only called when a category hides by guide.
 */
// How far ahead "nothing listed" looks by default, in hours.
export const DEFAULT_UNLISTED_HOURS = 24;

// Narrows a guide query to some channels, which the index can go straight to. Without it the query
// reads the source's whole guide, far too much for one category on a big provider.
const onlyChannels = (channels) => (channels ? ` AND channel IN (${channels.map(() => '?').join(',')})` : '');

/** The first listing (with a title) starting after t and before until, per "sourceId|channel". */
export function nextListings(db, sources, t, until, channels) {
  const map = new Map();
  for (const s of sources) {
    const rows = db.all(
      `SELECT channel, start_ts, xml FROM programmes WHERE source_id = ? AND gen = ?${onlyChannels(channels)} AND start_ts > ? AND start_ts < ? ORDER BY start_ts`,
      [s.id, s.epg_gen, ...(channels || []), t, until],
    );
    for (const r of rows) {
      const key = `${s.id}|${r.channel}`;
      if (map.has(key)) continue;
      const title = firstText(r.xml, 'title');
      if (title) map.set(key, { start: r.start_ts, title });
    }
  }
  return map;
}

export function nowTitles(db, sources, t = Math.floor(Date.now() / 1000), channels) {
  const map = new Map();
  for (const s of sources) {
    const rows = db.all(
      `SELECT channel, xml FROM programmes WHERE source_id = ? AND gen = ?${onlyChannels(channels)} AND start_ts <= ? AND stop_ts > ?`,
      [s.id, s.epg_gen, ...(channels || []), t, t],
    );
    for (const r of rows) map.set(`${s.id}|${r.channel}`, firstText(r.xml, 'title'));
  }
  return map;
}

export function compilePatterns(list) {
  return list.flatMap((p) => {
    try {
      return [new RegExp(p, 'i')];
    } catch {
      return [];
    }
  });
}

export const isEmptyEvent = (name, regexes) => regexes.some((r) => r.test(String(name || '')));

/**
 * For categories that hide by guide: what is on each channel now, and whether that title is
 * a placeholder. Looks programs up only for the sources those categories belong to, and only for
 * `channels` (guide ids) when given.
 */
export function guideHider(db, output, cats, t = Math.floor(Date.now() / 1000), channels) {
  const wanted = new Set(cats.filter((c) => c.hide_by_guide).map((c) => c.source_id));
  const sources = output.sources.filter((s) => wanted.has(s.id));
  const titles = wanted.size ? nowTitles(db, sources, t, channels) : new Map();
  const regexes = wanted.size ? compilePatterns(guidePatterns(db)) : [];
  // Listings coming up, as far ahead as the longest "nothing listed" look-ahead in use.
  const aheadH = Math.max(0, ...cats.filter((c) => c.hide_by_guide).map((c) => c.unlisted_hours || DEFAULT_UNLISTED_HOURS));
  const upcoming = wanted.size && aheadH
    ? nextListings(db, sources, t, t + aheadH * 3600, channels)
    : new Map();
  // Sources whose guide has anything airing now. If a source has nothing at all, its guide has
  // run out or failed to refresh, and "nothing listed" says nothing about its channels.
  const current = new Set(channels
    ? sources.filter((s) => db.get('SELECT 1 FROM programmes WHERE source_id = ? AND gen = ? AND start_ts <= ? AND stop_ts > ? LIMIT 1', [s.id, s.epg_gen, t, t])).map((s) => s.id)
    : [...titles.keys()].map((k) => Number(k.slice(0, k.indexOf('|')))));
  const titleOf = (ch) => {
    const epgId = ch.custom_epg_id || ch.epg_id;
    return epgId ? titles.get(`${ch.source_id}|${epgId}`) ?? null : null;
  };
  const nextOf = (ch) => {
    const epgId = ch.custom_epg_id || ch.epg_id;
    return epgId ? upcoming.get(`${ch.source_id}|${epgId}`) ?? null : null;
  };
  return {
    titleOf,
    guideCurrent: (ch) => current.has(ch.source_id),
    // A placeholder title airing now ("No Game Today").
    isPlaceholder: (ch) => { const tt = titleOf(ch); return !!tt && isEmptyEvent(tt, regexes); },
    // The next listing within the look-ahead, if nothing is on now: { start, title }.
    nextOf,
    // Has a guide id, but nothing (or a blank title) airing now and nothing starting within the next
    // `hours`, while its source's guide is current. Channels without any guide id are never
    // counted: there is nothing to go on.
    isUnlisted: (ch, hours = DEFAULT_UNLISTED_HOURS) => {
      if (!(ch.custom_epg_id || ch.epg_id || ch.tvg_id) || !current.has(ch.source_id) || titleOf(ch)) return false;
      const next = nextOf(ch);
      return !(next && next.start < t + hours * 3600);
    },
  };
}

// --- name cleanup (advanced): per-output find/replace on the names players see

export const NAME_SCOPES = ['channel', 'category', 'both'];
// Where a rule applies: live TV, movies & series, or both. Rules from before VOD are live TV.
export const NAME_MEDIA = ['live', 'vod', 'all'];
const MAX_NAME_RULES = 50;

export function parseNameRules(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Check and normalize a list of {scope, find, replace}; returns { rules } or { error }. */
export function checkNameRules(list) {
  if (!Array.isArray(list)) return { error: 'name_rules must be a list' };
  if (list.length > MAX_NAME_RULES) return { error: `At most ${MAX_NAME_RULES} name cleanup rules` };
  const rules = [];
  for (const r of list) {
    const scope = r?.scope ?? 'channel';
    const media = r?.media ?? 'live';
    const find = typeof r?.find === 'string' ? r.find : '';
    const replace = typeof r?.replace === 'string' ? r.replace : '';
    const source = r?.source ?? null;
    if (source !== null && !Number.isInteger(source)) return { error: 'A name rule\'s source must be a source id' };
    if (!NAME_SCOPES.includes(scope)) return { error: `Unknown name rule scope: ${scope}` };
    if (!NAME_MEDIA.includes(media)) return { error: `Unknown name rule target: ${media}` };
    if (!find) return { error: 'Every name cleanup rule needs something to find' };
    if (find.length > 300 || replace.length > 300) return { error: 'Name cleanup rules are limited to 300 characters' };
    try {
      new RegExp(find, 'g');
    } catch (e) {
      return { error: `Not a valid pattern: ${find} (${e.message.split(': ').pop()})` };
    }
    rules.push({ scope, media, ...(source === null ? {} : { source }), find, replace });
  }
  return { rules };
}

/**
 * Name cleaners for item names (channels, or movie and series titles) and category names, for
 * live TV (media 'live') or movies & series ('vod'). Each rule's pattern is a case-sensitive regular
 * expression and every match is replaced ($1 works). Once any rule applies to a kind of name,
 * leftover runs of spaces are collapsed and the ends trimmed; a name that would end up empty
 * stays as it was.
 */
export function nameCleaner(rules, media = 'live') {
  const compiled = rules.filter((r) => (r.media || 'live') === media || r.media === 'all')
    .map((r) => ({ ...r, re: new RegExp(r.find, 'g') }));
  const make = (scope) => {
    const list = compiled.filter((r) => r.scope === scope || r.scope === 'both');
    if (!list.length) return (name) => name;
    // source: the source the name comes from, for rules aimed at just one.
    return (name, source) => {
      let out = name;
      for (const r of list) if (!r.source || r.source === source) out = out.replace(r.re, r.replace);
      return out.replace(/\s{2,}/g, ' ').trim() || name;
    };
  };
  return { channel: make('channel'), category: make('category') };
}

const NO_ICONS = new Map();

/**
 * Guide-listed channel logos per source, used when a channel has no logo of its own. Off unless
 * the (advanced) "Use guide logos" setting is on; each source is looked up once, only if needed.
 */
export function guideIconLookup(db, srcById) {
  if (db.getSetting('guide_logo_fallback') !== '1') return () => NO_ICONS;
  const cache = new Map();
  return (sourceId) => {
    if (!cache.has(sourceId)) {
      const src = srcById.get(sourceId);
      cache.set(sourceId, new Map(src ? db.all(
        "SELECT xml_id, icon FROM epg_channels WHERE source_id = ? AND gen = ? AND icon IS NOT NULL AND icon <> ''",
        [src.id, src.epg_gen],
      ).map((r) => [r.xml_id, r.icon]) : []));
    }
    return cache.get(sourceId);
  };
}

/** Why a category's switches hide this channel: 'empty', 'guide', 'unlisted', or null. */
export function hiddenReason(cat, ch, emptyRegexes, guide) {
  if (cat.hide_empty && isEmptyEvent(ch.name, emptyRegexes)) return 'empty';
  if (!cat.hide_by_guide) return null;
  if (guide.isPlaceholder(ch)) return 'guide';
  if (cat.hide_unlisted && guide.isUnlisted(ch, cat.unlisted_hours)) return 'unlisted';
  return null;
}

/** Channel rules of an output, grouped by category id. */
export function loadChannelRules(db, outputId) {
  const map = new Map();
  for (const r of db.all('SELECT * FROM output_channel_rules WHERE output_id = ? ORDER BY sort, id', [outputId])) {
    if (!map.has(r.category_id)) map.set(r.category_id, []);
    map.get(r.category_id).push(r);
  }
  return map;
}

const NEW_FOR_S = 7 * 86400;

/** A category is "new" for a week after appearing in any refresh but the source's first. */
export function isNewCategory(c, t = Math.floor(Date.now() / 1000)) {
  return c.added_in > 1 && c.first_seen > t - NEW_FOR_S;
}

export function loadOutput(db, outputId) {
  const output = db.get('SELECT * FROM outputs WHERE id = ?', [outputId]);
  if (!output) return null;
  output.sources = db.all(
    `SELECT s.id, s.name, s.epg_gen, s.user_agent, s.type, s.xc_stream_ext, os.sort, os.cat_prefix, os.cat_suffix
       FROM output_sources os JOIN sources s ON s.id = os.source_id
      WHERE os.output_id = ? ORDER BY os.sort, s.id`,
    [outputId],
  );
  output.rules = db.all('SELECT * FROM output_rules WHERE output_id = ? ORDER BY sort, id', [outputId]);
  return output;
}

/** A prefix or suffix as stored: one line, trimmed, at most 40 characters. */
export const affixText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

/** (sourceId, name) => the name with that source's category prefix and suffix in this output, space-separated. */
export function categoryAffixer(output) {
  const bySource = new Map(output.sources.map((s) => [s.id, s]));
  return (sourceId, name) => {
    const s = bySource.get(sourceId);
    return [s?.cat_prefix, name, s?.cat_suffix].filter(Boolean).join(' ');
  };
}

// Names in the order people expect: "Channel 2" before "Channel 10", capitals or not.
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
// Custom order: positions as arranged; anything added since goes last, in the provider's order.
const byPosition = (positions, a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity) || 0;

export const positionsOf = (db, table, column, outputId) =>
  new Map(db.all(`SELECT ${column} AS id, position FROM ${table} WHERE output_id = ?`, [outputId]).map((r) => [r.id, r.position]));

/**
 * How two channels of one category compare in an output: by the category's own sort, else the
 * output's. Names are the ones players see. Rules never look at this; they use provider names.
 */
export function channelCompare(output, cat, clean, positions) {
  const mode = cat.ch_sort || output.ch_sort || 'provider';
  const names = new Map();
  const shown = (ch) => {
    if (!names.has(ch.id)) names.set(ch.id, ch.custom_name || clean.channel(ch.name, cat.source_id));
    return names.get(ch.id);
  };
  if (mode === 'name') return (a, b) => byName(shown(a), shown(b)) || a.sort - b.sort;
  if (mode === 'custom') return (a, b) => byPosition(positions, a, b) || a.sort - b.sort;
  return (a, b) => a.sort - b.sort;
}

/** Categories from every source attached to the output, each with its decision. */
/** Categories of one kind ('live', 'movie' or 'series'), each judged by that kind's rules. */
export function evaluateCategories(db, output, kind = 'live') {
  if (!output.sources.length) return [];
  const overrides = new Map(
    db.all('SELECT category_id, state FROM output_category_overrides WHERE output_id = ?', [output.id])
      .map((r) => [r.category_id, r.state]),
  );
  const order = new Map(output.sources.map((s, i) => [s.id, i]));
  const ids = output.sources.map((s) => s.id);
  const cats = db.all(
    `SELECT c.id, c.source_id, c.name, c.custom_name, c.jellyfin, c.sort, c.first_seen, c.added_in,
            ${kind === 'live'
    ? '(SELECT COUNT(*) FROM channels ch WHERE ch.category_id = c.id AND ch.active = 1)'
    : '(SELECT COUNT(*) FROM vod_items v WHERE v.category_id = c.id AND v.active = 1)'} AS channel_count
            ${kind === 'live' ? '' : `, (SELECT COUNT(*) FROM output_vod_overrides x JOIN vod_items v ON v.id = x.item_id
                 WHERE x.output_id = ? AND x.state = 'exclude' AND v.category_id = c.id AND v.active = 1) AS excluded_count`}
       FROM categories c
      WHERE c.active = 1 AND c.kind = ? AND c.source_id IN (${ids.map(() => '?').join(',')})`,
    kind === 'live' ? [kind, ...ids] : [output.id, kind, ...ids],
  );
  const rules = output.rules.filter((r) => (r.kind || 'live') === kind);
  // Sources stay in the output's order; categories sort within each one, by the name players see
  // (prefix and suffix included) or as arranged by hand.
  const catClean = nameCleaner(checkNameRules(parseNameRules(output.name_rules)).rules || [], kind === 'live' ? 'live' : 'vod');
  const affix = categoryAffixer(output);
  const shownCat = (c) => affix(c.source_id, c.custom_name || catClean.category(c.name, c.source_id));
  const catPositions = output.cat_sort === 'custom' ? positionsOf(db, 'output_category_order', 'category_id', output.id) : null;
  const within = output.cat_sort === 'name' ? (a, b) => byName(shownCat(a), shownCat(b))
    : catPositions ? (a, b) => byPosition(catPositions, a, b) : () => 0;
  cats.sort((a, b) => order.get(a.source_id) - order.get(b.source_id) || within(a, b) || a.sort - b.sort);
  const chRules = loadChannelRules(db, output.id);
  const catSettings = new Map(
    db.all('SELECT category_id, hide_empty, hide_by_guide, hide_unlisted, unlisted_hours, ch_sort FROM output_category_settings WHERE output_id = ?', [output.id])
      .map((r) => [r.category_id, r]),
  );
  for (const c of cats) {
    const override = overrides.get(c.id) || null;
    Object.assign(c, categoryState(c, rules, override, kind === 'live' ? output.include_all : output[`include_all_${kind}`]), { override });
    c.channel_rules = chRules.get(c.id) || [];
    c.hide_empty = !!catSettings.get(c.id)?.hide_empty;
    c.hide_by_guide = !!catSettings.get(c.id)?.hide_by_guide;
    c.hide_unlisted = !!catSettings.get(c.id)?.hide_unlisted;
    c.unlisted_hours = catSettings.get(c.id)?.unlisted_hours ?? DEFAULT_UNLISTED_HOURS;
    c.ch_sort = catSettings.get(c.id)?.ch_sort || null;
    c.is_new = isNewCategory(c);
    c.jellyfin = parseJellyfin(c.jellyfin);
  }
  return cats;
}

/**
 * Resolve the final channel list for an output with every per-channel edit applied.
 * tvg ids are made unique per source so two providers' "news.us" never collide in one guide.
 */
export function selectChannels(db, output) {
  const cats = evaluateCategories(db, output);
  if (!cats.length) return { categories: cats, channels: [] };
  const catById = new Map(cats.map((c) => [c.id, c]));
  const chOverrides = new Map(
    db.all('SELECT channel_id, state FROM output_channel_overrides WHERE output_id = ?', [output.id])
      .map((r) => [r.channel_id, r.state]),
  );
  const srcById = new Map(output.sources.map((s) => [s.id, s]));
  const emptyRegexes = compilePatterns(emptyEventPatterns(db));
  const guide = guideHider(db, output, cats);
  const guideIcons = guideIconLookup(db, srcById);
  const clean = nameCleaner(checkNameRules(parseNameRules(output.name_rules)).rules || []);
  const affix = categoryAffixer(output);
  const groupName = new Map(cats.map((c) => [c.id, affix(c.source_id, c.custom_name || clean.category(c.name, c.source_id))]));
  const ids = output.sources.map((s) => s.id);
  const rows = db.all(
    `SELECT * FROM channels WHERE active = 1 AND source_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );

  const channels = [];
  for (const ch of rows) {
    const cat = catById.get(ch.category_id);
    if (!cat) continue;
    const hidden = hiddenReason(cat, ch, emptyRegexes, guide);
    if (!channelState(ch.name, cat.included, cat.channel_rules, chOverrides.get(ch.id), hidden).included) continue;
    channels.push({ ch, cat });
  }
  // Categories in their order (sources first), then each category's channels in theirs.
  const catIndex = new Map(cats.map((c, i) => [c.id, i]));
  const chPositions = positionsOf(db, 'output_channel_order', 'channel_id', output.id);
  const compare = new Map(cats.map((c) => [c.id, channelCompare(output, c, clean, chPositions)]));
  channels.sort((a, b) => catIndex.get(a.cat.id) - catIndex.get(b.cat.id) || compare.get(a.cat.id)(a.ch, b.ch));

  const idOwner = new Map(); // output tvg-id -> "sourceId|epgId"
  let num = output.number_start != null ? Number(output.number_start) : null;
  const result = channels.map(({ ch, cat }) => {
    const src = srcById.get(ch.source_id);
    const epgId = ch.custom_epg_id || ch.epg_id || null;
    // HDHomeRun channels publish their tuner number ("5.1") as the guide id, so it stays the
    // same whether the listings came from the XMLTV feed (opaque ids) or the JSON guide.
    let tvgId = (src.type === 'hdhr' ? ch.tvg_id : epgId || ch.tvg_id) || '';
    if (tvgId) {
      const owner = `${ch.source_id}|${tvgId}`;
      const prev = idOwner.get(tvgId);
      if (prev && prev !== owner) tvgId = `${tvgId}.s${ch.source_id}`;
      else idOwner.set(tvgId, owner);
    }
    let extra = null;
    try {
      extra = ch.extra ? JSON.parse(ch.extra) : null;
    } catch {}
    return {
      id: ch.id,
      source_id: ch.source_id,
      category_id: cat.id,
      name: ch.custom_name || clean.channel(ch.name, ch.source_id),
      // No provider logo: borrow the one the guide lists for this channel.
      logo: ch.custom_logo || ch.logo || (epgId && guideIcons(ch.source_id).get(epgId)) || '',
      group: groupName.get(cat.id),
      jellyfin: cat.jellyfin,
      tvg_id: tvgId,
      epg_id: epgId,
      epg_gen: src.epg_gen,
      chno: num != null ? String(num++) : ch.custom_chno || ch.chno || '',
      url: ch.url,
      opts: extra?.opts || [],
      user_agent: src.user_agent,
      xc_stream_id: ch.xc_stream_id,
      source_type: src.type,
      added: ch.first_seen,
    };
  });
  return { categories: cats, channels: result };
}
