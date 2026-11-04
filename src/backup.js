// Settings export/import. Categories and channels are referenced by source-relative
// names/keys rather than database ids, so an export restores onto a fresh install.
import { HttpError } from './http.js';
import { OPS, compilePatterns, checkNameRules, parseNameRules, affixText } from './filters.js';
import { ENCODERS, DEFAULT_LIGHT_MAX } from './light.js';
import { parseJellyfin } from './outputs/epg.js';
import { now } from './db.js';

export const FORMAT = 'iptv-manager-settings';
export const FORMAT_VERSION = 1;

const SOURCE_FIELDS = ['name', 'type', 'url', 'epg_urls', 'xc_host', 'xc_username', 'xc_password', 'xc_stream_ext',
  'hdhr_host', 'user_agent', 'live_only', 'refresh_minutes', 'enabled', 'max_streams', 'vod_refresh_minutes', 'sort'];
const OUTPUT_FIELDS = ['name', 'token', 'stream_mode', 'include_all', 'number_start', 'epg_days', 'xc_enabled',
  'xc_username', 'xc_password'];

// Categories are named by source and name; movie and series ones also carry their kind (live is
// the default, so files from before VOD read the same).
const kindOf = (c) => (c.kind && c.kind !== 'live' ? { kind: c.kind } : {});
const KINDS = ['live', 'movie', 'series'];

const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));

export function exportSettings(db, { secrets = true, appVersion = null } = {}) {
  const sources = db.all('SELECT * FROM sources ORDER BY sort, id');
  const outputs = db.all('SELECT * FROM outputs ORDER BY id');
  const catRef = new Map(db.all('SELECT id, source_id, kind, name FROM categories').map((c) => [c.id, c]));
  const chRef = new Map(db.all('SELECT id, source_id, key FROM channels').map((c) => [c.id, c]));

  // Only rows that carry edits, or that output overrides/rules point at, need exporting.
  const catOverrides = db.all('SELECT * FROM output_category_overrides');
  const chOverrides = db.all('SELECT * FROM output_channel_overrides');
  const chRules = db.all('SELECT * FROM output_channel_rules ORDER BY sort, id');
  const catSettings = db.all('SELECT * FROM output_category_settings WHERE hide_empty = 1 OR hide_by_guide = 1 OR hide_unlisted = 1 OR ch_sort IS NOT NULL');
  const catOrder = db.all('SELECT * FROM output_category_order ORDER BY position');
  const chOrder = db.all('SELECT * FROM output_channel_order ORDER BY position');
  const neededCats = new Set([...catOverrides, ...chRules, ...catSettings, ...catOrder].map((r) => r.category_id));
  const customPatterns = db.getSetting('empty_event_patterns');
  const customGuide = db.getSetting('guide_patterns');
  const neededChans = new Set([...chOverrides, ...chOrder].map((r) => r.channel_id));
  // Movies and series: renamed titles, and hand picks, named by source, kind and provider id.
  const vodOverrides = db.all('SELECT * FROM output_vod_overrides');
  const vodRef = new Map(db.all('SELECT id, source_id, kind, key FROM vod_items WHERE custom_name IS NOT NULL OR id IN (SELECT item_id FROM output_vod_overrides)')
    .map((v) => [v.id, v]));

  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    app_version: appVersion,
    includes_secrets: !!secrets,
    settings: {
      base_url: db.getSetting('base_url') || '',
      // null means "the built-in defaults", so a restore follows future default changes.
      empty_event_patterns: customPatterns ? JSON.parse(customPatterns) : null,
      guide_patterns: customGuide ? JSON.parse(customGuide) : null,
      advanced: db.getSetting('ui_advanced') === '1',
      guide_logo_fallback: db.getSetting('guide_logo_fallback') === '1',
      light_encoder: db.getSetting('light_encoder') || 'auto',
      light_max: Number(db.getSetting('light_max')) || DEFAULT_LIGHT_MAX,
      // An ntfy topic URL works like a password, so it only travels with secrets.
      notify_type: db.getSetting('notify_type') || '',
      notify_url: secrets ? db.getSetting('notify_url') || '' : '',
    },
    sources: sources.map((s) => {
      const src = { ref: s.id, ...pick(s, SOURCE_FIELDS), live_only: !!s.live_only, enabled: !!s.enabled };
      if (!secrets) {
        src.xc_password = null;
        src.url = s.url && /[?&](username|password)=/i.test(s.url) ? null : s.url;
        src.epg_urls = s.epg_urls.split(/\r?\n/).filter((u) => !/[?&](username|password)=/i.test(u)).join('\n');
      }
      src.categories = db.all('SELECT id, kind, name, custom_name, jellyfin FROM categories WHERE source_id = ?', [s.id])
        .filter((c) => c.custom_name || c.jellyfin || neededCats.has(c.id))
        .map((c) => ({ name: c.name, ...kindOf(c), custom_name: c.custom_name, jellyfin: parseJellyfin(c.jellyfin) }));
      src.channels = db.all(
        `SELECT id, key, name, custom_name, custom_logo, custom_epg_id, custom_chno FROM channels WHERE source_id = ?`,
        [s.id],
      )
        .filter((c) => c.custom_name || c.custom_logo || c.custom_epg_id || c.custom_chno || neededChans.has(c.id))
        .map((c) => pick(c, ['key', 'name', 'custom_name', 'custom_logo', 'custom_epg_id', 'custom_chno']));
      const titles = db.all('SELECT kind, key, name, custom_name FROM vod_items WHERE source_id = ? AND custom_name IS NOT NULL', [s.id]);
      if (titles.length) src.vod_titles = titles;
      return src;
    }),
    outputs: outputs.map((o) => ({
      ...pick(o, OUTPUT_FIELDS),
      include_all: !!o.include_all,
      include_all_movie: !!o.include_all_movie,
      include_all_series: !!o.include_all_series,
      xc_enabled: !!o.xc_enabled,
      vod_enabled: !!o.vod_enabled,
      light_enabled: !!o.light_enabled,
      convert_mode: o.convert_mode || 'off',
      cat_sort: o.cat_sort || 'provider',
      ch_sort: o.ch_sort || 'provider',
      category_order: catOrder.filter((r) => r.output_id === o.id && catRef.has(r.category_id)).map((r) => {
        const c = catRef.get(r.category_id);
        return { source: c.source_id, category: c.name, ...kindOf(c) };
      }),
      channel_order: chOrder.filter((r) => r.output_id === o.id && chRef.has(r.channel_id)).map((r) => {
        const c = chRef.get(r.channel_id);
        return { source: c.source_id, key: c.key };
      }),
      paused: !!o.paused,
      xc_password: secrets ? o.xc_password : null,
      sources: db.all('SELECT source_id FROM output_sources WHERE output_id = ? ORDER BY sort', [o.id]).map((r) => r.source_id),
      category_affixes: db.all("SELECT source_id, cat_prefix, cat_suffix FROM output_sources WHERE output_id = ? AND (cat_prefix <> '' OR cat_suffix <> '')", [o.id])
        .map((r) => ({ source: r.source_id, prefix: r.cat_prefix, suffix: r.cat_suffix })),
      rules: db.all('SELECT source_id, kind, action, op, value FROM output_rules WHERE output_id = ? ORDER BY sort, id', [o.id])
        .map((r) => ({ source: r.source_id, ...kindOf(r), action: r.action, op: r.op, value: r.value })),
      name_rules: parseNameRules(o.name_rules),
      category_overrides: catOverrides.filter((r) => r.output_id === o.id && catRef.has(r.category_id)).map((r) => {
        const c = catRef.get(r.category_id);
        return { source: c.source_id, category: c.name, ...kindOf(c), state: r.state };
      }),
      channel_rules: chRules.filter((r) => r.output_id === o.id && catRef.has(r.category_id)).map((r) => {
        const c = catRef.get(r.category_id);
        return { source: c.source_id, category: c.name, action: r.action, op: r.op, value: r.value };
      }),
      category_options: catSettings.filter((r) => r.output_id === o.id && catRef.has(r.category_id)).map((r) => {
        const c = catRef.get(r.category_id);
        return {
          source: c.source_id, category: c.name,
          hide_empty: !!r.hide_empty, hide_by_guide: !!r.hide_by_guide, hide_unlisted: !!r.hide_unlisted,
          unlisted_hours: r.unlisted_hours,
          ...(r.ch_sort ? { ch_sort: r.ch_sort } : {}),
        };
      }),
      channel_overrides: chOverrides.filter((r) => r.output_id === o.id && chRef.has(r.channel_id)).map((r) => {
        const c = chRef.get(r.channel_id);
        return { source: c.source_id, key: c.key, state: r.state };
      }),
      // Extra Xtream Codes logins; like the output's own, passwords only travel with secrets.
      xc_logins: db.all('SELECT name, username, password, enabled FROM output_xc_logins WHERE output_id = ? ORDER BY id', [o.id])
        .map((l) => ({ name: l.name, username: l.username, password: secrets ? l.password : null, enabled: !!l.enabled })),
      title_overrides: vodOverrides.filter((r) => r.output_id === o.id && vodRef.has(r.item_id)).map((r) => {
        const v = vodRef.get(r.item_id);
        return { source: v.source_id, kind: v.kind, key: v.key, state: r.state };
      }),
    })),
  };
}

function check(cond, msg) {
  if (!cond) throw new HttpError(400, `Invalid settings file: ${msg}`);
}

function validate(data) {
  check(data && data.format === FORMAT, 'not a Simple IPTV Manager settings export');
  for (const [key, label] of [['empty_event_patterns', 'empty-event'], ['guide_patterns', 'guide']]) {
    const patterns = data.settings?.[key];
    if (patterns != null) {
      check(Array.isArray(patterns) && patterns.every((p) => typeof p === 'string' && p.trim())
        && compilePatterns(patterns).length === patterns.length, `invalid ${label} patterns`);
    }
  }
  check(Number(data.version) <= FORMAT_VERSION, `made by a newer version (format ${data.version})`);
  check(Array.isArray(data.sources) && Array.isArray(data.outputs), 'missing sources or outputs');
  const refs = new Set();
  for (const s of data.sources) {
    check(s.ref != null && !refs.has(s.ref), 'duplicate or missing source ref');
    refs.add(s.ref);
    check(['m3u', 'xc', 'hdhr'].includes(s.type), `source "${s.name}" has an unknown type`);
  }
  const rule = (r) => ['include', 'exclude'].includes(r.action) && OPS.includes(r.op) && typeof r.value === 'string'
    && (r.kind == null || KINDS.includes(r.kind));
  const tokens = new Set();
  const users = new Set();
  for (const o of data.outputs) {
    check(typeof o.token === 'string' && o.token && !tokens.has(o.token), `output "${o.name}" has a missing or duplicate token`);
    tokens.add(o.token);
    for (const u of [o.xc_username, ...(o.xc_logins || []).map((l) => l?.username)].filter(Boolean)) {
      check(typeof u === 'string' && !users.has(u), `Xtream Codes username "${u}" is used twice`);
      users.add(u);
    }
    check(['direct', 'redirect', 'proxy'].includes(o.stream_mode), `output "${o.name}" has an unknown stream mode`);
    check((o.rules || []).every(rule) && (o.channel_rules || []).every(rule), `output "${o.name}" has an invalid rule`);
    const names = checkNameRules(o.name_rules ?? []);
    check(!names.error, `output "${o.name}": ${names.error}`);
    const used = [...(o.sources || []), ...[...(o.category_overrides || []), ...(o.channel_rules || []), ...(o.category_options || []),
      ...(o.channel_overrides || []), ...(o.title_overrides || [])].map((x) => x.source)];
    check((o.title_overrides || []).every((x) => ['movie', 'series'].includes(x.kind) && x.key != null), `output "${o.name}" has an invalid title pick`);
    for (const r of used) {
      check(refs.has(r), `output "${o.name}" refers to a source that is not in the file`);
    }
  }
}

/**
 * Replace every source and output with the contents of an export. Categories and channels
 * that the file references are created as inactive placeholders; the first refresh fills
 * them in and keeps their edits, since ingest upserts on (source, name) and (source, key).
 */
export function importSettings(db, data) {
  validate(data);
  const t = now();
  const summary = { sources: 0, outputs: 0 };
  const sourceIds = db.tx(() => {
    db.run('DELETE FROM outputs');
    db.run('DELETE FROM sources');
    if (data.settings && typeof data.settings.base_url === 'string') db.setSetting('base_url', data.settings.base_url);
    // An import replaces everything; files from before custom patterns existed mean "defaults".
    for (const key of ['empty_event_patterns', 'guide_patterns']) {
      const p = data.settings?.[key];
      db.setSetting(key, p == null ? null : JSON.stringify(p.map((s) => s.trim())));
    }
    // Missing in older files: off, as it was then.
    db.setSetting('ui_advanced', data.settings?.advanced ? 1 : 0);
    db.setSetting('guide_logo_fallback', data.settings?.guide_logo_fallback ? 1 : 0);
    db.setSetting('light_encoder', ENCODERS.includes(data.settings?.light_encoder) ? data.settings.light_encoder : null);
    db.setSetting('light_max', Number.isInteger(data.settings?.light_max) && data.settings.light_max >= 1 && data.settings.light_max <= 16 ? data.settings.light_max : null);
    const nt = ['ntfy', 'webhook'].includes(data.settings?.notify_type) ? data.settings.notify_type : '';
    const nu = typeof data.settings?.notify_url === 'string' && /^https?:\/\//i.test(data.settings.notify_url) ? data.settings.notify_url : '';
    db.setSetting('notify_type', nt && nu ? nt : '');
    db.setSetting('notify_url', nt && nu ? nu : '');
    db.setSetting('alerts_sent', '{}');

    const ids = new Map();
    const catIds = new Map(); // "ref|kind|name" -> id
    const chIds = new Map(); // "ref|key" -> id
    const vodIds = new Map(); // "ref|kind|key" -> id
    // A movie or series named by the file, as an inactive placeholder until the next refresh
    // fills it in (ingest upserts on source, kind and key, keeping its name and picks).
    const ensureTitle = (ref, kind, key, name, customName) => {
      const k = `${ref}|${kind}|${key}`;
      if (!vodIds.has(k)) {
        vodIds.set(k, db.get(
          `INSERT INTO vod_items (source_id, kind, key, name, custom_name, active, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT (source_id, kind, key) DO UPDATE SET custom_name = COALESCE(excluded.custom_name, custom_name) RETURNING id`,
          [ids.get(ref), kind, String(key), String(name || key), customName ?? null, t, t],
        ).id);
      }
      return vodIds.get(k);
    };
    const ensureCat = (ref, name, kind) => {
      kind = KINDS.includes(kind) ? kind : 'live';
      const k = `${ref}|${kind}|${name}`;
      if (!catIds.has(k)) {
        const r = db.get(
          `INSERT INTO categories (source_id, kind, name, active, first_seen, last_seen) VALUES (?, ?, ?, 0, ?, ?)
           ON CONFLICT (source_id, kind, name) DO UPDATE SET name = excluded.name RETURNING id`,
          [ids.get(ref), kind, String(name), t, t],
        );
        catIds.set(k, r.id);
      }
      return catIds.get(k);
    };

    data.sources.forEach((s, i) => {
      const r = db.get(
        `INSERT INTO sources (name, type, url, epg_urls, xc_host, xc_username, xc_password, xc_stream_ext, hdhr_host, user_agent,
                              live_only, refresh_minutes, enabled, max_streams, vod_refresh_minutes, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [String(s.name || 'Source'), s.type, s.url ?? null, String(s.epg_urls || ''), s.xc_host ?? null, s.xc_username ?? null,
          s.xc_password ?? null, s.xc_stream_ext === 'm3u8' ? 'm3u8' : 'ts', s.hdhr_host ?? null, String(s.user_agent || ''), s.live_only !== false,
          Number.isFinite(Number(s.refresh_minutes)) ? Number(s.refresh_minutes) : 720, s.enabled !== false,
          Number.isInteger(s.max_streams) && s.max_streams >= 0 ? s.max_streams : null,
          Number.isInteger(s.vod_refresh_minutes) && s.vod_refresh_minutes >= 0 ? s.vod_refresh_minutes : 1440, s.sort ?? i, t],
      );
      ids.set(s.ref, r.id);
      summary.sources++;
      for (const c of s.categories || []) {
        const id = ensureCat(s.ref, c.name, c.kind);
        db.run('UPDATE categories SET custom_name = ?, jellyfin = ? WHERE id = ?', [
          c.custom_name || null, parseJellyfin((c.jellyfin || []).join(',')).join(',') || null, id,
        ]);
      }
      for (const c of s.channels || []) {
        const row = db.get(
          `INSERT INTO channels (source_id, key, name, custom_name, custom_logo, custom_epg_id, custom_chno, active, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING id`,
          [r.id, String(c.key), String(c.name || c.key), c.custom_name ?? null, c.custom_logo ?? null, c.custom_epg_id ?? null,
            c.custom_chno ?? null, t, t],
        );
        chIds.set(`${s.ref}|${c.key}`, row.id);
      }
      for (const v of s.vod_titles || []) {
        if (['movie', 'series'].includes(v.kind) && v.key != null) ensureTitle(s.ref, v.kind, v.key, v.name, v.custom_name || null);
      }
    });

    for (const o of data.outputs) {
      const r = db.get(
        `INSERT INTO outputs (name, token, stream_mode, include_all, include_all_movie, include_all_series, number_start, epg_days,
                              xc_enabled, xc_username, xc_password, name_rules, vod_enabled, light_enabled, convert_mode, cat_sort, ch_sort, paused, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        // Files from before these switches existed: movies and series followed the live TV one.
        [String(o.name || 'Output'), o.token, o.stream_mode, !!o.include_all, o.include_all_movie ?? !!o.include_all,
          o.include_all_series ?? !!o.include_all, o.number_start ?? null, Number(o.epg_days) || 7,
          !!o.xc_enabled && !!o.xc_username && !!o.xc_password, o.xc_username || null, o.xc_password || null,
          JSON.stringify(checkNameRules(o.name_rules ?? []).rules), !!o.vod_enabled, !!o.light_enabled,
          ['needed', 'always'].includes(o.convert_mode) ? o.convert_mode : 'off',
          ['name', 'custom'].includes(o.cat_sort) ? o.cat_sort : 'provider', ['name', 'custom'].includes(o.ch_sort) ? o.ch_sort : 'provider', !!o.paused, t, t],
      );
      summary.outputs++;
      (o.sources || []).forEach((ref, i) => {
        db.run('INSERT OR IGNORE INTO output_sources (output_id, source_id, sort) VALUES (?, ?, ?)', [r.id, ids.get(ref), i]);
      });
      for (const a of o.category_affixes || []) {
        if (!ids.has(a.source)) continue;
        db.run('UPDATE output_sources SET cat_prefix = ?, cat_suffix = ? WHERE output_id = ? AND source_id = ?',
          [affixText(a.prefix), affixText(a.suffix), r.id, ids.get(a.source)]);
      }
      (o.rules || []).forEach((x, i) => {
        db.run('INSERT INTO output_rules (output_id, source_id, kind, action, op, value, sort) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          r.id, x.source != null && ids.has(x.source) ? ids.get(x.source) : null, x.kind || 'live', x.action, x.op, x.value, i,
        ]);
      });
      for (const x of o.category_overrides || []) {
        db.run('INSERT OR REPLACE INTO output_category_overrides (output_id, category_id, state) VALUES (?, ?, ?)', [
          r.id, ensureCat(x.source, x.category, x.kind), x.state === 'include' ? 'include' : 'exclude',
        ]);
      }
      for (const x of o.category_options || []) {
        db.run(`INSERT OR REPLACE INTO output_category_settings (output_id, category_id, hide_empty, hide_by_guide, hide_unlisted, unlisted_hours, ch_sort)
                VALUES (?, ?, ?, ?, ?, ?, ?)`, [
          r.id, ensureCat(x.source, x.category), !!x.hide_empty, !!x.hide_by_guide, !!x.hide_unlisted,
          Number.isInteger(x.unlisted_hours) && x.unlisted_hours >= 1 && x.unlisted_hours <= 168 ? x.unlisted_hours : 24,
          ['provider', 'name', 'custom'].includes(x.ch_sort) ? x.ch_sort : null,
        ]);
      }
      (o.category_order || []).forEach((x, i) => {
        db.run('INSERT OR REPLACE INTO output_category_order (output_id, category_id, position) VALUES (?, ?, ?)', [r.id, ensureCat(x.source, x.category, x.kind), i]);
      });
      (o.channel_rules || []).forEach((x, i) => {
        db.run('INSERT INTO output_channel_rules (output_id, category_id, action, op, value, sort) VALUES (?, ?, ?, ?, ?, ?)', [
          r.id, ensureCat(x.source, x.category), x.action, x.op, x.value, i,
        ]);
      });
      // Channels aren't loaded yet: a placeholder by provider key, filled in by the next refresh.
      const ensureChannel = (x) => {
        let id = chIds.get(`${x.source}|${x.key}`);
        if (!id) {
          id = db.get(
            `INSERT INTO channels (source_id, key, name, active, first_seen, last_seen) VALUES (?, ?, ?, 0, ?, ?) RETURNING id`,
            [ids.get(x.source), String(x.key), String(x.key), t, t],
          ).id;
          chIds.set(`${x.source}|${x.key}`, id);
        }
        return id;
      };
      (o.channel_order || []).forEach((x, i) => {
        db.run('INSERT OR REPLACE INTO output_channel_order (output_id, channel_id, position) VALUES (?, ?, ?)', [r.id, ensureChannel(x), i]);
      });
      for (const x of o.channel_overrides || []) {
        const id = ensureChannel(x);
        db.run('INSERT OR REPLACE INTO output_channel_overrides (output_id, channel_id, state) VALUES (?, ?, ?)', [
          r.id, id, x.state === 'include' ? 'include' : 'exclude',
        ]);
      }
      // Logins without a password (an export without secrets) can't be restored.
      for (const l of o.xc_logins || []) {
        if (!l.username || !l.password) continue;
        db.run('INSERT INTO output_xc_logins (output_id, name, username, password, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
          r.id, String(l.name || ''), String(l.username), String(l.password), l.enabled !== false, t,
        ]);
      }
      for (const x of o.title_overrides || []) {
        db.run('INSERT OR REPLACE INTO output_vod_overrides (output_id, item_id, state) VALUES (?, ?, ?)', [
          r.id, ensureTitle(x.source, x.kind, x.key), x.state === 'include' ? 'include' : 'exclude',
        ]);
      }
    }
    return [...ids.values()];
  });
  return { ...summary, sourceIds };
}
