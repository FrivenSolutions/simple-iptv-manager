import { DatabaseSync } from 'node:sqlite';

// Each entry upgrades the schema by one version; PRAGMA user_version tracks progress.
const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('m3u', 'xc')),
    url TEXT,
    epg_urls TEXT NOT NULL DEFAULT '',
    xc_host TEXT,
    xc_username TEXT,
    xc_password TEXT,
    xc_stream_ext TEXT NOT NULL DEFAULT 'ts',
    user_agent TEXT NOT NULL DEFAULT '',
    live_only INTEGER NOT NULL DEFAULT 1,
    refresh_minutes INTEGER NOT NULL DEFAULT 720,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    epg_gen INTEGER NOT NULL DEFAULT 0,
    refresh_count INTEGER NOT NULL DEFAULT 0,
    first_refresh_at INTEGER,
    last_refresh_at INTEGER,
    last_status TEXT,
    last_error TEXT,
    stats TEXT,
    account_info TEXT,
    created_at INTEGER
  );

  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    custom_name TEXT,
    xc_id TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    added_in INTEGER, -- sources.refresh_count of the refresh that first saw it
    first_seen INTEGER,
    last_seen INTEGER,
    UNIQUE (source_id, name)
  );

  CREATE TABLE channels (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    tvg_id TEXT,
    tvg_name TEXT,
    logo TEXT,
    url TEXT,
    chno TEXT,
    xc_stream_id TEXT,
    extra TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    epg_id TEXT,
    epg_match TEXT,
    custom_name TEXT,
    custom_logo TEXT,
    custom_epg_id TEXT,
    custom_chno TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    first_seen INTEGER,
    last_seen INTEGER,
    UNIQUE (source_id, key)
  );
  CREATE INDEX channels_category ON channels(category_id);

  -- EPG rows carry a generation number so a refresh can load a new copy while
  -- outputs keep reading the previous one, then swap by bumping sources.epg_gen.
  CREATE TABLE epg_channels (
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    gen INTEGER NOT NULL,
    xml_id TEXT NOT NULL,
    names TEXT,
    icon TEXT,
    PRIMARY KEY (source_id, gen, xml_id)
  );

  CREATE TABLE programmes (
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    gen INTEGER NOT NULL,
    channel TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    stop_ts INTEGER NOT NULL,
    start TEXT NOT NULL,
    stop TEXT NOT NULL,
    xml TEXT
  );
  CREATE INDEX programmes_lookup ON programmes(source_id, gen, channel, start_ts);

  CREATE TABLE outputs (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    stream_mode TEXT NOT NULL DEFAULT 'direct' CHECK (stream_mode IN ('direct', 'redirect', 'proxy')),
    include_all INTEGER NOT NULL DEFAULT 0,
    number_start INTEGER,
    epg_days INTEGER NOT NULL DEFAULT 7,
    xc_enabled INTEGER NOT NULL DEFAULT 0,
    xc_username TEXT UNIQUE,
    xc_password TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE output_sources (
    output_id INTEGER NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    sort INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (output_id, source_id)
  );

  CREATE TABLE output_rules (
    id INTEGER PRIMARY KEY,
    output_id INTEGER NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
    source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('include', 'exclude')),
    op TEXT NOT NULL,
    value TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE output_category_overrides (
    output_id INTEGER NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('include', 'exclude')),
    PRIMARY KEY (output_id, category_id)
  );

  CREATE TABLE output_channel_overrides (
    output_id INTEGER NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('include', 'exclude')),
    PRIMARY KEY (output_id, channel_id)
  );
  `,
  `
  -- Comma-separated Jellyfin guide categories (Movie, Sports, News, Kids) stamped on
  -- every program of every channel in the group.
  ALTER TABLE categories ADD COLUMN jellyfin TEXT;
  `,
  `
  -- Rules that pick channels inside one included category of an output.
  CREATE TABLE output_channel_rules (
    id INTEGER PRIMARY KEY,
    output_id INTEGER NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('include', 'exclude')),
    op TEXT NOT NULL,
    value TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX output_channel_rules_lookup ON output_channel_rules(output_id, category_id);
  `,
  {
    // Allow HDHomeRun sources. SQLite cannot alter a CHECK constraint, so the table is
    // rebuilt (the documented create/copy/drop/rename procedure, with foreign keys off).
    foreignKeysOff: true,
    sql: `
  CREATE TABLE sources_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('m3u', 'xc', 'hdhr')),
    url TEXT,
    epg_urls TEXT NOT NULL DEFAULT '',
    xc_host TEXT,
    xc_username TEXT,
    xc_password TEXT,
    xc_stream_ext TEXT NOT NULL DEFAULT 'ts',
    hdhr_host TEXT,
    user_agent TEXT NOT NULL DEFAULT '',
    live_only INTEGER NOT NULL DEFAULT 1,
    refresh_minutes INTEGER NOT NULL DEFAULT 720,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0,
    epg_gen INTEGER NOT NULL DEFAULT 0,
    refresh_count INTEGER NOT NULL DEFAULT 0,
    first_refresh_at INTEGER,
    last_refresh_at INTEGER,
    last_status TEXT,
    last_error TEXT,
    stats TEXT,
    account_info TEXT,
    created_at INTEGER
  );
  INSERT INTO sources_new (id, name, type, url, epg_urls, xc_host, xc_username, xc_password, xc_stream_ext, user_agent,
      live_only, refresh_minutes, enabled, sort, epg_gen, refresh_count, first_refresh_at, last_refresh_at, last_status,
      last_error, stats, account_info, created_at)
    SELECT id, name, type, url, epg_urls, xc_host, xc_username, xc_password, xc_stream_ext, user_agent,
      live_only, refresh_minutes, enabled, sort, epg_gen, refresh_count, first_refresh_at, last_refresh_at, last_status,
      last_error, stats, account_info, created_at
    FROM sources;
  DROP TABLE sources;
  ALTER TABLE sources_new RENAME TO sources;
  `,
  },
  `
  -- Per-output, per-category switches (currently: hide empty event/placeholder channels).
  CREATE TABLE output_category_settings (
    output_id INTEGER NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    hide_empty INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (output_id, category_id)
  );
  `,
  `
  -- Hide channels whose program on now has a placeholder title ("No Game Today").
  ALTER TABLE output_category_settings ADD COLUMN hide_by_guide INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- With hide_by_guide: also hide channels that have a guide id but nothing airing now.
  ALTER TABLE output_category_settings ADD COLUMN hide_unlisted INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Consecutive failed refreshes, for the "source keeps failing" alert.
  ALTER TABLE sources ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Per-output name cleanup (find/replace on channel and category names), as a JSON list.
  ALTER TABLE outputs ADD COLUMN name_rules TEXT NOT NULL DEFAULT '[]';
  `,
  `
  -- Channels a source may have open at once through proxy outputs. NULL = automatic (the XC
  -- account's connection limit or the HDHomeRun's tuner count), 0 = no limit.
  ALTER TABLE sources ADD COLUMN max_streams INTEGER;
  `,
  {
    // Movies and series. Categories gain a kind ('live', 'movie' or 'series'), and a provider may
    // use the same name for a live and a VOD category, so the unique key includes the kind.
    foreignKeysOff: true,
    sql: `
  CREATE TABLE categories_new (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'live' CHECK (kind IN ('live', 'movie', 'series')),
    name TEXT NOT NULL,
    custom_name TEXT,
    xc_id TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    added_in INTEGER,
    first_seen INTEGER,
    last_seen INTEGER,
    jellyfin TEXT,
    UNIQUE (source_id, kind, name)
  );
  INSERT INTO categories_new (id, source_id, kind, name, custom_name, xc_id, sort, active, added_in, first_seen, last_seen, jellyfin)
    SELECT id, source_id, 'live', name, custom_name, xc_id, sort, active, added_in, first_seen, last_seen, jellyfin FROM categories;
  DROP TABLE categories;
  ALTER TABLE categories_new RENAME TO categories;

  -- One row per movie or series. extra holds the provider's own fields (JSON), passed on to
  -- Xtream Codes clients; episodes of a series are filled in when a player opens it.
  CREATE TABLE vod_items (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    poster TEXT,
    ext TEXT,
    url TEXT,
    added INTEGER,
    extra TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    first_seen INTEGER,
    last_seen INTEGER,
    UNIQUE (source_id, kind, key)
  );
  CREATE INDEX vod_items_category ON vod_items(category_id);

  CREATE TABLE vod_episodes (
    id INTEGER PRIMARY KEY,
    series_id INTEGER NOT NULL REFERENCES vod_items(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    season INTEGER,
    episode INTEGER,
    title TEXT,
    ext TEXT,
    url TEXT,
    info TEXT,
    UNIQUE (series_id, key)
  );

  ALTER TABLE sources ADD COLUMN vod_refresh_minutes INTEGER NOT NULL DEFAULT 1440;
  ALTER TABLE sources ADD COLUMN vod_refreshed_at INTEGER;
  ALTER TABLE sources ADD COLUMN vod_stats TEXT;
  ALTER TABLE outputs ADD COLUMN vod_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE output_rules ADD COLUMN kind TEXT NOT NULL DEFAULT 'live';
  `,
  },
  `
  -- "Include all categories of a source with no Include rules", per kind. Movies and series used
  -- the live TV switch until now, so they start from it.
  ALTER TABLE outputs ADD COLUMN include_all_movie INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE outputs ADD COLUMN include_all_series INTEGER NOT NULL DEFAULT 0;
  UPDATE outputs SET include_all_movie = include_all, include_all_series = include_all;
  `,
  `
  -- Movies and series picked in or out by hand per output, and a title's own display name.
  CREATE TABLE output_vod_overrides (
    output_id INTEGER NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES vod_items(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('include', 'exclude')),
    PRIMARY KEY (output_id, item_id)
  );
  ALTER TABLE vod_items ADD COLUMN custom_name TEXT;
  `,
  `
  -- More Xtream Codes logins for one output (to share it), each removable on its own. A username
  -- is unique across these and the outputs' own logins.
  CREATE TABLE output_xc_logins (
    id INTEGER PRIMARY KEY,
    output_id INTEGER NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER,
    last_used_at INTEGER
  );
  `,
  `
  -- A paused output answers nothing (URLs and every login) until it is resumed.
  ALTER TABLE outputs ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- "Nothing listed" looks ahead this many hours: a channel with anything airing now or starting
  -- within them is kept (players reload playlists only now and then).
  ALTER TABLE output_category_settings ADD COLUMN unlisted_hours INTEGER NOT NULL DEFAULT 24;
  `,
  `
  -- Text put before and after the names of a source's categories in one output ("UK | News").
  ALTER TABLE output_sources ADD COLUMN cat_prefix TEXT NOT NULL DEFAULT '';
  ALTER TABLE output_sources ADD COLUMN cat_suffix TEXT NOT NULL DEFAULT '';
  `,
  `
  -- Light streams: the M3U playlist offers a 720p copy of each channel (tileiptv-light).
  ALTER TABLE outputs ADD COLUMN light_enabled INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Convert for playback: 'off', 'needed' (channels in codecs that don't play everywhere, such as
  -- MPEG-2 video or Dolby sound) or 'always'. Converted streams are H.264 with AAC sound.
  ALTER TABLE outputs ADD COLUMN convert_mode TEXT NOT NULL DEFAULT 'off';
  `,
  `
  -- Order in an output. Categories: 'provider', 'name' or 'custom', within each source. Channels:
  -- 'provider' or 'name' for the output, and per category also 'custom' (NULL follows the output).
  ALTER TABLE outputs ADD COLUMN cat_sort TEXT NOT NULL DEFAULT 'provider';
  ALTER TABLE outputs ADD COLUMN ch_sort TEXT NOT NULL DEFAULT 'provider';
  ALTER TABLE output_category_settings ADD COLUMN ch_sort TEXT;
  CREATE TABLE output_category_order (
    output_id INTEGER NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (output_id, category_id)
  );
  CREATE TABLE output_channel_order (
    output_id INTEGER NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (output_id, channel_id)
  );
  `,
];

// node:sqlite refuses undefined and booleans; map them to what SQLite stores.
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function bind(params) {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(norm);
  const o = {};
  for (const [k, v] of Object.entries(params)) o[k] = norm(v);
  return [o];
}

export function openDb(file) {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      s.setAllowUnknownNamedParameters(true);
      cache.set(sql, s);
    }
    return s;
  };

  let depth = 0;
  const db = {
    raw,
    all: (sql, p) => prep(sql).all(...bind(p)),
    get: (sql, p) => prep(sql).get(...bind(p)),
    run: (sql, p) => prep(sql).run(...bind(p)),
    exec: (sql) => raw.exec(sql),
    // Synchronous transaction; nested calls join the outer one.
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN');
      try {
        const r = fn();
        raw.exec('COMMIT');
        return r;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    getSetting(key, fallback = null) {
      const row = prep('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : fallback;
    },
    setSetting(key, value) {
      prep('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value == null ? null : String(value));
    },
    close: () => raw.close(),
  };

  const version = raw.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    const m = typeof MIGRATIONS[v] === 'string' ? { sql: MIGRATIONS[v] } : MIGRATIONS[v];
    // foreign_keys can only change outside a transaction.
    if (m.foreignKeysOff) raw.exec('PRAGMA foreign_keys = OFF');
    try {
      db.tx(() => {
        raw.exec(m.sql);
        if (m.foreignKeysOff) {
          const broken = raw.prepare('PRAGMA foreign_key_check').all();
          if (broken.length) throw new Error(`Migration ${v + 1} left ${broken.length} broken foreign keys`);
        }
        raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    } finally {
      if (m.foreignKeysOff) raw.exec('PRAGMA foreign_keys = ON');
    }
  }
  return db;
}

export const now = () => Math.floor(Date.now() / 1000);
