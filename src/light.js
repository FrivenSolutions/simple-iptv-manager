// Light streams: a 720p copy of a channel at no more than 30 fps, made by ffmpeg while someone
// watches it. Multi-view players (TileIPTV) switch side windows to it when a TV can't decode
// several full channels at once. An output turns it on; the playlist then gives each channel a
// tileiptv-light link.
//
// ffmpeg reads the channel through the same shared provider connection as normal viewing, so a
// light copy and the full channel together take one of the source's connections. One ffmpeg
// per channel, shared by everyone watching its light copy; it is stopped as soon as the last
// viewer leaves. Intel Quick Sync (VAAPI) is used when the GPU is reachable, software otherwise.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { DEFAULT_UA } from './fetch.js';
import { upstreamUrl } from './stream.js';

export const DEFAULT_LIGHT_MAX = 4;
export const ENCODERS = ['auto', 'vaapi', 'software'];
const DEVICE = process.env.LIGHT_VAAPI_DEVICE || '/dev/dri/renderD128';
// A viewer this far behind is dropped rather than holding everyone up (as for full streams).
const MAX_BEHIND_BYTES = 16 * 1024 * 1024;
// 50/60 fps halves to 25/30; 25/30 fps is left alone.
const FPS = "fps=fps='if(gt(source_fps,31),source_fps/2,source_fps)'";

/**
 * What ffmpeg makes:
 * - light: a 720p copy at no more than 30 fps for multi-view side windows; the sound as it was.
 * - browser: for the Watch page when the browser can't decode a channel (MPEG-2 video, Dolby AC-3
 *   sound): H.264 up to 1080p at the channel's own frame rate, and AAC stereo sound.
 */
export const PROFILES = {
  light: { height: 720, halveFps: true, rate: ['2500k', '3000k', '6000k'], audio: ['-c:a', 'copy'] },
  browser: { height: 1080, halveFps: false, rate: ['6000k', '8000k', '12000k'], audio: ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'] },
};

/** ffmpeg arguments: input is 'pipe:0' (fed from the shared stream) or a URL ffmpeg fetches itself. */
export function ffmpegArgs({ input, encoder, userAgent, device = DEVICE, profile = 'light' }) {
  const P = PROFILES[profile] || PROFILES.light;
  const fps = P.halveFps ? `${FPS},` : '';
  const a = ['-hide_banner', '-loglevel', 'error'];
  if (input !== 'pipe:0') {
    a.push('-nostdin', '-user_agent', userAgent || DEFAULT_UA, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  // A second of stream is enough to find a live channel's tracks; ffmpeg's default (5 s)
  // delays the first bytes, and players give up on a silent stream after about 10 s.
  a.push('-fflags', '+genpts+discardcorrupt', '-analyzeduration', '1000000');
  if (encoder === 'vaapi') a.push('-hwaccel', 'vaapi', '-hwaccel_device', device, '-hwaccel_output_format', 'vaapi');
  a.push('-i', input, '-map', '0:v:0', '-map', '0:a:0?');
  if (encoder === 'vaapi') {
    a.push('-vf', `deinterlace_vaapi=rate=frame:auto=1,${fps}scale_vaapi=w=-2:h='min(${P.height},ih)'`, '-c:v', 'h264_vaapi', '-profile:v', 'main');
  } else {
    a.push('-vf', `yadif=mode=0:deint=interlaced,${fps}scale=-2:'min(${P.height},ih)',format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main');
  }
  a.push('-b:v', P.rate[0], '-maxrate', P.rate[1], '-bufsize', P.rate[2], '-g', '60', '-bf', '0', ...P.audio,
    '-f', 'mpegts', '-flush_packets', '1', 'pipe:1');
  return a;
}

/** Run ffmpeg to the end; resolves { code, out, err } (code null when it could not start). */
function run(cmd, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let p;
    try {
      p = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, out, err: e.message });
    }
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { err += e.message; });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

const lastLine = (s) => String(s || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';

/** One channel's ffmpeg (for one profile) and everyone watching its output. */
class Job {
  constructor(light, ch, profile = 'light') {
    this.light = light;
    this.ch = ch;
    this.profile = profile;
    this.key = `${ch.id}|${profile}`;
    this.label = profile === 'browser' ? 'Browser copy' : 'Light stream';
    this.clients = new Set();
    this.closed = false;
    this.stopping = false;
    this.proc = null;
    this.release = null;
    this.err = '';
  }

  async start(ctx) {
    const { ch } = this;
    const hub = ctx.streams.hub(ch, upstreamUrl(ch, 'ts'));
    // Held open until ffmpeg joins: picking the encoder can take a moment (a test encode, the first
    // time), and a shared stream with nobody on it would close at its first data.
    hub.holds++;
    try {
      return await this.attach(ctx, hub);
    } finally {
      hub.holds--;
    }
  }

  async attach(ctx, hub) {
    const { ch } = this;
    const r = await hub.result;
    if (this.closed) {
      setImmediate(() => { if (!hub.clients.size && !hub.holds) hub.close(); });
      return { status: 503 };
    }
    if (r.status) {
      this.close();
      return r;
    }
    const encoder = await this.light.encoder();
    if (this.closed) return { status: 503 };
    // An HLS channel: ffmpeg follows the playlist itself, holding the channel's connection slot.
    const input = r.hls ? r.url : 'pipe:0';
    if (r.hls) this.release = ctx.streams.hold({ id: ch.id, source_id: ch.source_id });
    const [bin, ...pre] = this.light.cmd;
    const p = spawn(bin, [...pre, ...ffmpegArgs({ input, encoder, userAgent: ch.user_agent, profile: this.profile })], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    this.encoder = encoder;
    p.stdin.on('error', () => {}); // ffmpeg gone while the shared stream still writes
    p.on('error', (e) => { this.err = e.message; this.close(); });
    p.stderr.on('data', (d) => { this.err = (this.err + d).slice(-2000); });
    p.stdout.on('data', (chunk) => {
      for (const res of this.clients) {
        if (res.writableLength > MAX_BEHIND_BYTES) res.destroy();
        else res.write(chunk);
      }
    });
    p.on('close', (code) => {
      if (!this.stopping && this.clients.size) {
        this.light.ctx.log?.(`${this.label} "${ch.name}": ffmpeg stopped${code ? ` (${lastLine(this.err) || `exit ${code}`})` : ''}`);
      }
      this.close();
    });
    if (r.ts) {
      this.hub = hub;
      p.stdin.iptvmWho = this.profile === 'browser' ? 'the browser-copy encoder (ffmpeg)' : 'the light-stream encoder (ffmpeg)';
      p.stdin.iptvmEncoder = true;
      hub.add(p.stdin);
    }
    else p.stdin.end();
    return { ok: true };
  }

  add(res) {
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
      if (!this.clients.size) this.close();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopping = true;
    if (this.light.jobs.get(this.key) === this) this.light.jobs.delete(this.key);
    const p = this.proc;
    if (p && p.exitCode == null && p.signalCode == null) {
      p.stdin.destroy(); // leaves the shared stream (which closes if no one else watches)
      p.kill('SIGTERM');
      setTimeout(() => { if (p.exitCode == null && p.signalCode == null) p.kill('SIGKILL'); }, 2000).unref();
    }
    this.release?.();
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

export class Light {
  // cmd: how to run ffmpeg, as [program, ...leading arguments] (tests put a stand-in here).
  constructor(ctx, { cmd = [process.env.FFMPEG_PATH || 'ffmpeg'], device = DEVICE } = {}) {
    this.ctx = ctx;
    this.cmd = cmd;
    this.device = device;
    this.jobs = new Map(); // channel id -> Job
    this.vodCopies = 0; // movies and episodes being converted for the Watch page (see vodwatch.js)
    this.version = null; // ffmpeg's version once found
    this.autoChoice = null; // what "auto" settled on: 'vaapi' or 'software'
  }

  max() {
    const n = Number(this.ctx.db.getSetting('light_max'));
    return Number.isInteger(n) && n >= 1 ? n : DEFAULT_LIGHT_MAX;
  }

  setting() {
    const e = this.ctx.db.getSetting('light_encoder');
    return ENCODERS.includes(e) ? e : 'auto';
  }

  /**
   * ffmpeg's version string, or null when it isn't installed. Found once, it is remembered; until
   * then every call looks again (quick when it's missing), so installing it needs no restart.
   */
  async ffmpeg() {
    if (!this.version) {
      const r = await run(this.cmd, ['-hide_banner', '-version'], 10_000);
      this.version = r.code === 0 ? (/version\s+(\S+)/.exec(r.out)?.[1] || 'unknown') : null;
      // Found after "auto" settled without it: let it choose again.
      if (this.version) this.autoChoice = null;
    }
    return this.version;
  }

  hasDevice() {
    try {
      fs.accessSync(this.device, fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** The encoder to use now: the setting, or for "auto" Quick Sync if a short test encode works. */
  async encoder() {
    const s = this.setting();
    if (s !== 'auto') return s;
    if (!this.autoChoice) {
      this.autoChoice = this.hasDevice() && (await this.test('vaapi', 1)).ok ? 'vaapi' : 'software';
    }
    return this.autoChoice;
  }

  /**
   * Encode a generated 1080p60 picture for a few seconds, as a light stream would. Returns
   * { ok, encoder, speed } (speed: times faster than real time) or { ok: false, error }.
   */
  async test(encoder, seconds = 4) {
    const vaapi = encoder === 'vaapi';
    // A stream's own filters and encoder settings, fed a generated picture instead of a channel.
    const args = ffmpegArgs({ input: 'pipe:0', encoder, device: this.device });
    const vf = args[args.indexOf('-vf') + 1];
    const enc = args.slice(args.indexOf('-c:v'), args.indexOf('-c:a'));
    const r = await run(this.cmd, [
      '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
      ...(vaapi ? ['-init_hw_device', `vaapi=va:${this.device}`, '-filter_hw_device', 'va'] : []),
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', '-t', String(seconds),
      '-vf', vaapi ? `format=nv12,hwupload,${vf}` : vf, ...enc, '-f', 'null', '-',
    ], 60_000);
    if (r.code !== 0) return { ok: false, encoder, error: lastLine(r.err) || (r.code == null ? 'ffmpeg could not be started' : `exit ${r.code}`) };
    const speeds = [...r.out.matchAll(/^speed=\s*([\d.]+)x/gm)].map((m) => Number(m[1]));
    return { ok: true, encoder, speed: speeds.length ? speeds.pop() : null };
  }

  async status() {
    const version = await this.ffmpeg();
    return {
      ffmpeg: version,
      setting: this.setting(),
      device: this.hasDevice(),
      encoder: version ? await this.encoder() : null,
      active: [...this.jobs.values()].map((j) => ({ channel: j.ch.name, viewers: j.clients.size, profile: j.profile })),
      max: this.max(),
    };
  }

  /** Forget what "auto" chose (after the setting changes or a GPU is added). */
  reset() {
    this.autoChoice = null;
    this.version = null;
  }

  stop() {
    for (const job of [...this.jobs.values()]) job.close();
  }
}

function refuse(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '10', 'cache-control': 'no-cache' }).end(message);
}

/**
 * A channel's light copy (or, profile 'browser', its copy for the Watch page): join the one being
 * made, or start ffmpeg if there's room. Both kinds count toward the same limit.
 */
export async function serveLight(ctx, res, ch, viewer = null, { profile = 'light' } = {}) {
  const light = ctx.light;
  const key = `${ch.id}|${profile}`;
  const browser = profile === 'browser';
  let job = light.jobs.get(key);
  if (!job && !(await light.ffmpeg())) {
    return refuse(res, 503, `${browser ? 'Converting a channel' : 'Light streams'} need${browser ? 's' : ''} ffmpeg, which is not installed on this server.`);
  }
  job = light.jobs.get(key);
  if (!job) {
    const max = light.max();
    if (light.jobs.size >= max) {
      return refuse(res, 503, browser
        ? `The server is already converting ${max} stream${max === 1 ? '' : 's'}, its limit (Settings → Light streams).`
        : `Light streams are all in use (${max} at a time).`);
    }
    const admit = ctx.streams.admit(ch);
    if (!admit.ok) return refuse(res, 503, `All ${admit.limit} stream${admit.limit === 1 ? '' : 's'} for this source are in use.`);
    job = new Job(light, ch, profile);
    light.jobs.set(key, job);
    job.ready = job.start(ctx);
  }
  const r = await job.ready;
  if (res.destroyed || res.writableEnded) {
    setImmediate(() => { if (!job.clients.size) job.close(); });
    return;
  }
  if (r.status) return res.writeHead(r.status).end();
  if (job.closed) return res.writeHead(502).end();
  res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-cache' });
  job.add(res);
  if (viewer) {
    res.on('close', ctx.viewers.open({
      ...viewer,
      transcode: job.encoder,
      // The provider (through the shared stream), the encoder, and this viewer, each can fall behind.
      health: () => ({
        ...(job.hub ? job.hub.health() : { provider_pauses: 0, longest_pause_s: 0, silent_s: 0, burst_s: 0 }),
        encoder_behind_mb: ctx.streams.behindMb(job.proc?.stdin),
        behind_mb: ctx.streams.behindMb(res),
      }),
    }));
  }
}
