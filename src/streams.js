// Proxy-mode stream bookkeeping. Everyone watching the same channel shares one upstream
// connection, and each source can be capped at a number of channels open at once (providers
// allow only so many connections per account; an HDHomeRun has only so many tuners).
// Direct and Redirect outputs hand the provider's URL to the player, so they can't be counted.
import { Readable } from 'node:stream';
import { DEFAULT_UA } from './fetch.js';
import { TsProbe } from './tsprobe.js';

// The codecs are read from the first this-many bytes of a stream at most (the tables repeat
// several times a second, so they're usually in the first few KB).
const PROBE_BYTES = 2 * 1024 * 1024;
// Each shared stream keeps what it received in the last REPLAY_MS (at most REPLAY_BYTES), and
// whoever joins gets that first. A provider's opening burst (often half a minute of video sent in
// a few seconds) is the cushion that lets a player ride out a bursty channel's gaps; a viewer who
// joins a stream already open (a reconnect, a second window, a light copy or a recorder) would
// otherwise start at the live point with nothing in its buffer. It also gives a recording or
// player that joins after a codec check the stream's start, which begins on a whole picture.
const REPLAY_MS = 12_000;
const REPLAY_BYTES = 12 * 1024 * 1024;
// When every viewer on a stream has this much waiting, stop reading from the provider until one
// catches up, so the provider holds the rest, as it does when a player connects to it directly
// (Redirect). Without this the proxy read a provider's opening burst (half a minute of video in a
// few seconds) as fast as it came, and a TV that couldn't take it as fast fell 16 MB behind and
// was cut off, losing that cushion.
const PAUSE_AT_BYTES = 8 * 1024 * 1024;

/** Resolves when any of these clients has sent what was waiting (or closed), or after ms. */
function anyDrained(clients, ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      for (const c of clients) {
        c.off('drain', done);
        c.off('close', done);
      }
      resolve();
    };
    const timer = setTimeout(done, ms);
    for (const c of clients) {
      c.once('drain', done);
      c.once('close', done);
    }
  });
}

// An HLS channel counts as open this long after its last playlist or segment request.
const HLS_IDLE_MS = 30_000;
// A client this far behind the shared stream is dropped rather than slowing everyone down.
const MAX_BEHIND_BYTES = 16 * 1024 * 1024;
// Stall diagnostics (the defaults; Streams carries them, so tests can shorten them):
// - the provider sending nothing this long is a pause;
// - a viewer this far behind is shown as lagging on the dashboard, and logged at the second mark,
//   but only once it has stayed behind for LAG_SUSTAIN_MS: a provider that sends video in bursts
//   (several MB at once) puts every viewer briefly "behind" while the burst drains.
// Pauses are judged against each stream's own rhythm (see Hub.rhythm); until it is known, only a
// gap of BOOTSTRAP_FACTOR x STALL_MS counts, so a bursty stream's first gaps aren't flagged.
const STALL_MS = 5000;
const BOOTSTRAP_FACTOR = 3;
const LAG_SHOW_BYTES = 2 * 1024 * 1024;
const LAG_LOG_BYTES = 4 * 1024 * 1024;
const LAG_SUSTAIN_MS = 5000;
/**
 * How far a client is behind the live point: what is queued for it, less what it was handed on
 * joining (the replayed cushion, queued first) and hasn't received yet. That part is meant to be
 * there and isn't lag.
 */
export function behindOf(res) {
  if (!res) return 0;
  if (res.iptvmReplay) res.iptvmReplay = Math.min(res.iptvmReplay, res.writableLength);
  return res.writableLength - (res.iptvmReplay || 0);
}

const mb = (n) => Math.round((n / 1048576) * 10) / 10;
const ordinal = (n) => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
};

const isHls = (ct, url) => /mpegurl/i.test(ct) || /\.m3u8$/i.test(new URL(url).pathname);

/**
 * Why the provider turned a stream down, for the log: the connection error, or the HTTP status
 * with what it usually means.
 */
export function refusalReason(err, status) {
  if (err) return `couldn't reach the provider (${err.cause?.code || err.code || err.message})`;
  const hint = status === 401 || status === 403 ? 'access refused: user agent, IP lock or account?'
    : status === 404 ? 'no such stream at the provider'
    : [429, 458, 509].includes(status) ? 'too many connections on the account?'
    : status >= 500 ? "an error on the provider's side"
    : null;
  return `the provider refused it (HTTP ${status}${hint ? `, ${hint}` : ''})`;
}

function parseJson(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/**
 * One upstream request, shared. Requests for the same channel that arrive while it is opening
 * wait for it; if it turns out to be a continuous TS stream, every client is fed from it.
 * `result` resolves to { ts: contentType }, { hls: text, url } or { status } (an error).
 */
class Hub {
  constructor(streams, key, ch, url) {
    this.streams = streams;
    this.key = key;
    this.ch = ch;
    this.clients = new Set();
    this.ac = new AbortController();
    this.closed = false;
    this.started = Date.now();
    this.lastData = null; // when the provider last sent anything (null until the first chunk)
    this.pauses = 0;
    this.longestPause = 0;
    this.gaps = []; // recent gaps between bursts (not pauses), to learn the provider's rhythm
    // Kept open without viewers while something is about to join (codec check, ffmpeg starting).
    this.holds = 0;
    this.recent = []; // [{ at, chunk }]: the last REPLAY_MS of the stream, for whoever joins
    this.recentBytes = 0;
    // The stream's codecs (tsprobe.js), read from its first bytes; codecs resolves to them, or
    // null if they weren't found (not MPEG-TS, or the stream ended first).
    this.probe = new TsProbe();
    this.probed = 0;
    this.codecs = new Promise((resolve) => { this.codecsFound = resolve; });
    this.result = this.open(url);
  }

  /**
   * The provider's usual gap between bursts, in ms (0 until 3 gaps are seen). Providers that build
   * a channel from HLS segments send each segment at once: a 6 s rhythm is how they deliver, not
   * a stall.
   */
  rhythm() {
    if (this.gaps.length < 3) return 0;
    const sorted = [...this.gaps].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /** A gap this long is a pause: well past the usual rhythm, and never under stallMs. */
  pauseAfter() {
    const r = this.rhythm();
    return r ? Math.max(this.streams.stallMs, 1.5 * r) : BOOTSTRAP_FACTOR * this.streams.stallMs;
  }

  /**
   * How the provider side of this stream is doing: real pauses so far and the longest, how long it
   * has been silent right now (0 unless that is already a pause), and its burst rhythm in seconds
   * (0 when it streams steadily).
   */
  health() {
    const silent = this.lastData && !this.closed ? Date.now() - this.lastData : 0;
    const r = this.rhythm();
    return {
      provider_pauses: this.pauses,
      longest_pause_s: this.pauses ? Math.max(1, Math.round(this.longestPause / 1000)) : 0,
      silent_s: silent >= this.pauseAfter() ? Math.max(1, Math.floor(silent / 1000)) : 0,
      burst_s: r >= 2 * this.streams.burstMinMs() ? Math.max(1, Math.round(r / 1000)) : 0,
    };
  }

  async open(url) {
    let up;
    try {
      up = await fetch(url, { headers: { 'user-agent': this.ch.user_agent || DEFAULT_UA }, signal: this.ac.signal, redirect: 'follow' });
    } catch (e) {
      // Aborted means everyone who asked gave up while it was opening: not the provider's doing.
      if (!this.ac.signal.aborted) this.streams.refused(this.ch.source_id, this.ch.name, refusalReason(e));
      this.close();
      return { status: 502 };
    }
    if (!up.ok || !up.body) {
      up.body?.cancel().catch(() => {});
      this.streams.refused(this.ch.source_id, this.ch.name, refusalReason(null, up.status));
      this.close();
      return { status: up.status === 404 ? 404 : 502 };
    }
    const ct = up.headers.get('content-type') || '';
    if (isHls(ct, up.url)) {
      const text = await up.text().catch(() => null);
      this.close();
      return text == null ? { status: 502 } : { hls: text, url: up.url };
    }
    this.pump(up.body);
    return { ts: ct || 'video/mp2t' };
  }

  /** Keeps the last REPLAY_MS of the stream (at most REPLAY_BYTES) for whoever joins next. */
  remember(chunk) {
    const now = Date.now();
    this.recent.push({ at: now, chunk });
    this.recentBytes += chunk.length;
    const { replayMs, replayBytes } = this.streams;
    while (this.recent.length > 1 && (this.recentBytes > replayBytes || now - this.recent[0].at > replayMs)) {
      this.recentBytes -= this.recent.shift().chunk.length;
    }
  }

  /** Reads the codecs from the stream's first bytes, then stops looking. */
  sniff(chunk) {
    this.probed += chunk.length;
    const info = this.probe.push(chunk);
    if (info) this.streams.codecs.set(this.ch.id, info);
    if (info || this.probed > PROBE_BYTES) {
      this.probe = null;
      this.codecsFound(info);
    }
  }

  add(res) {
    for (const { chunk } of this.recent) res.write(chunk);
    res.iptvmReplay = this.recentBytes;
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
      if (!this.clients.size) this.close();
    });
  }

  async pump(body) {
    const started = Date.now();
    const mins = () => Math.round((Date.now() - started) / 6000) / 10;
    const log = (msg) => this.streams.ctx.log?.(msg);
    let failure = null;
    try {
      for await (const chunk of Readable.fromWeb(body)) {
        // Clients attach as soon as the response starts; by the first chunk, none left means
        // everyone who asked has gone.
        if (!this.clients.size && !this.holds) break;
        if (this.probe) this.sniff(chunk);
        this.remember(chunk);
        // Held open with nobody on it yet (codecs being read, ffmpeg starting): what arrives is
        // kept (above) for whoever joins first.
        if (!this.clients.size) continue;
        const now = Date.now();
        if (this.lastData) {
          const gap = now - this.lastData;
          if (gap >= this.pauseAfter()) {
            this.pauses++;
            this.longestPause = Math.max(this.longestPause, gap);
            const r = this.rhythm();
            const usual = r >= 2 * this.streams.burstMinMs() ? `it usually sends every ~${Math.max(1, Math.round(r / 1000))} s; ` : '';
            log(`Stream "${this.ch.name}": the provider sent nothing for ${Math.max(1, Math.round(gap / 1000))} s (${usual}${ordinal(this.pauses)} pause in ${mins()} min)`);
          } else if (gap >= this.streams.burstMinMs()) {
            // A gap between bursts: part of the rhythm (the last 9 are kept).
            this.gaps.push(gap);
            if (this.gaps.length > 9) this.gaps.shift();
          }
        }
        this.lastData = now;
        const maxBehind = this.streams.maxBehindBytes;
        for (const res of this.clients) {
          const who = res.iptvmWho || 'a viewer';
          const behind = behindOf(res);
          // The light-stream encoder runs faster than real time, but not as fast as a provider's
          // opening burst (it can send half a minute of video at once). Rather than stop the light
          // copy, skip ahead to live: feed it nothing until it is down to a quarter, then go on.
          if (res.iptvmEncoder && (behind > maxBehind || (res.iptvmSkipping && behind > maxBehind / 4))) {
            if (!res.iptvmSkipping) {
              res.iptvmSkipping = true;
              if (!res.iptvmSkipLogged) {
                res.iptvmSkipLogged = true;
                log(`Stream "${this.ch.name}": the light-stream encoder fell ${mb(behind)} MB behind (a burst from the provider); skipping ahead to live, after ${mins()} min`);
              }
            }
            continue;
          }
          res.iptvmSkipping = false;
          if (behind > maxBehind) {
            log(`Stream "${this.ch.name}": dropped ${who} that fell ${Math.round(maxBehind / 1048576)} MB behind, after ${mins()} min`);
            // Out of the set now, not on its close event, so the next chunks don't log it again.
            this.clients.delete(res);
            res.destroy();
            continue;
          }
          // Since when this client has been behind; cleared as soon as it catches up.
          if (behind >= this.streams.lagShowBytes) res.iptvmBehindSince ??= now;
          else res.iptvmBehindSince = null;
          const behindFor = res.iptvmBehindSince == null ? 0 : now - res.iptvmBehindSince;
          if (behindFor >= this.streams.lagSustainMs && behind > this.streams.lagLogBytes && !res.iptvmLagLogged) {
            res.iptvmLagLogged = true;
            log(`Stream "${this.ch.name}": ${who} has been behind for ${Math.round(behindFor / 1000)} s, now ${mb(behind)} MB (${res.iptvmEncoder ? 'the encoder' : 'their device or network'} is not keeping up), after ${mins()} min`);
          }
          res.write(chunk);
        }
        // All viewers (light-stream encoders aside: they skip ahead) have plenty waiting: let the
        // provider hold the rest until one of them catches up. Not counted as a provider pause.
        const viewers = [...this.clients].filter((c) => !c.iptvmEncoder);
        if (viewers.length && viewers.every((c) => behindOf(c) >= this.streams.pauseAtBytes)) {
          await anyDrained(viewers, 10_000);
          this.lastData = Date.now();
        }
      }
    } catch (e) {
      failure = e; // upstream dropped, or aborted because everyone left
    }
    // Ended while people were still watching: the provider closed it (or the connection broke).
    if (this.clients.size && !this.ac.signal.aborted) {
      log(`Stream "${this.ch.name}": the provider ${failure ? `connection failed (${failure.message})` : 'ended it'} after ${mins()} min`);
    }
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.codecsFound(null);
    this.ac.abort();
    if (this.streams.hubs.get(this.key) === this) this.streams.hubs.delete(this.key);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

export class Streams {
  constructor(ctx) {
    this.ctx = ctx;
    this.hubs = new Map(); // "channelId|url" -> Hub (opening, or streaming TS)
    this.hls = new Map(); // channelId -> { source_id, at }
    this.vod = new Map(); // "movie:id" / "episode:id" -> { source_id, n } (open proxied requests)
    this.codecs = new Map(); // channel id -> { video, audio, convert } (tsprobe.js), as last seen
    this.refusedLogged = new Map(); // sourceId -> time of the last "all in use" log line
    this.refusalLogged = new Map(); // "source|title|reason" -> time last logged
    this.lastRefusal = new Map(); // sourceId -> { what, reason, at } (for the Sources page)
    this.stallMs = STALL_MS;
    this.lagShowBytes = LAG_SHOW_BYTES;
    this.lagLogBytes = LAG_LOG_BYTES;
    this.lagSustainMs = LAG_SUSTAIN_MS;
    this.maxBehindBytes = MAX_BEHIND_BYTES;
    this.replayMs = REPLAY_MS;
    this.replayBytes = REPLAY_BYTES;
    this.pauseAtBytes = PAUSE_AT_BYTES;
  }

  /**
   * The provider turned a stream down. Logged (the same reason for the same title at most once a
   * minute: HLS players retry segments quickly) and kept as the source's latest refusal.
   */
  refused(sourceId, what, reason) {
    const key = `${sourceId}|${what}|${reason}`;
    const now = Date.now();
    if (now - (this.refusalLogged.get(key) || 0) > 60_000) {
      if (this.refusalLogged.size > 500) this.refusalLogged.clear();
      this.refusalLogged.set(key, now);
      this.ctx.log?.(`Stream "${what}": ${reason}`);
    }
    this.lastRefusal.set(sourceId, { what, reason, at: Math.floor(now / 1000) });
  }

  /** Shorter gaps than this are a steady stream; longer ones are bursts (1 s by default). */
  burstMinMs() {
    return this.stallMs / 5;
  }

  /** How far behind a client is, in MB: 0 unless it has been over the threshold for a while. */
  behindMb(res) {
    const n = behindOf(res);
    const since = res?.iptvmBehindSince;
    return n >= this.lagShowBytes && since != null && Date.now() - since >= this.lagSustainMs ? mb(n) : 0;
  }

  /** How many channels a source may have open at once; 0 means no limit. */
  limitFor(sourceId) {
    const s = this.ctx.db.get('SELECT type, max_streams, account_info FROM sources WHERE id = ?', [sourceId]);
    if (!s) return 0;
    if (s.max_streams != null) return s.max_streams;
    return autoLimit(s);
  }

  /** Channel ids open right now for a source. */
  open(sourceId) {
    const ids = new Set();
    for (const hub of this.hubs.values()) if (hub.ch.source_id === sourceId) ids.add(hub.ch.id);
    for (const [key, x] of this.vod) if (x.source_id === sourceId) ids.add(key);
    const cutoff = Date.now() - HLS_IDLE_MS;
    for (const [id, x] of this.hls) {
      if (x.at < cutoff) this.hls.delete(id);
      else if (x.source_id === sourceId) ids.add(id);
    }
    return ids;
  }

  /** A channel already open can always take more viewers; a new one needs a free slot. */
  admit(ch) {
    const open = this.open(ch.source_id);
    if (open.has(ch.id)) return { ok: true };
    const limit = this.limitFor(ch.source_id);
    if (!limit || open.size < limit) return { ok: true };
    const last = this.refusedLogged.get(ch.source_id) || 0;
    if (Date.now() - last > 60_000) {
      this.refusedLogged.set(ch.source_id, Date.now());
      const name = this.ctx.db.get('SELECT name FROM sources WHERE id = ?', [ch.source_id])?.name;
      this.ctx.log(`Source "${name}": all ${limit} stream${limit === 1 ? '' : 's'} are in use; refused another channel`);
    }
    return { ok: false, limit };
  }

  /**
   * Count a proxied movie or episode while its request is open; returns the release function.
   * Several requests for one title (players seek with new ones) take a single slot.
   */
  hold(item) {
    const x = this.vod.get(item.id) || { source_id: item.source_id, n: 0 };
    x.n++;
    this.vod.set(item.id, x);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--x.n <= 0) this.vod.delete(item.id);
    };
  }

  touchHls(ch) {
    this.hls.set(ch.id, { source_id: ch.source_id, at: Date.now() });
  }

  /**
   * A channel's codecs, read from its stream: remembered from the last time it played, else from
   * a new shared connection (taking one of the source's slots, like watching). Returns
   * { info, release }: info is null when unknown (over the limit, HLS, not found in time).
   * release() lets the connection go; call it once a viewer or ffmpeg has joined, or given up.
   */
  async probe(ch, url, timeoutMs = 5000) {
    const none = { info: null, release: () => {} };
    const known = this.codecs.get(ch.id);
    if (known) return { ...none, info: known };
    if (!this.admit(ch).ok) return none;
    const hub = this.hub(ch, url);
    hub.holds++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      hub.holds--;
    };
    const r = await hub.result;
    if (!r.ts) return { info: null, release };
    let timer;
    const info = await Promise.race([hub.codecs, new Promise((res) => { timer = setTimeout(() => res(null), timeoutMs); })]);
    clearTimeout(timer);
    return { info, release };
  }

  /** Join the shared request for this channel and URL, or start one. */
  hub(ch, url) {
    const key = `${ch.id}|${url}`;
    let hub = this.hubs.get(key);
    if (!hub || hub.closed) {
      hub = new Hub(this, key, ch, url);
      if (!hub.closed) this.hubs.set(key, hub);
    }
    return hub;
  }

  stop() {
    for (const hub of [...this.hubs.values()]) hub.close();
  }
}

/** The limit a source has when none is set: the account's connection limit, or the box's tuners. */
export function autoLimit(s) {
  const info = parseJson(s.account_info);
  if (s.type === 'xc') return Number(info?.max_connections) || 0;
  if (s.type === 'hdhr') return Number(info?.tuners) || 0;
  return 0;
}
