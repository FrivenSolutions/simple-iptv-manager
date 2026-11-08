// Movies and episodes on the Watch page. The browser plays them through this server (it can't
// reach the provider itself), seeking with Range requests as a player app would. When it can't
// decode one (Dolby sound in an MKV, an old AVI), ffmpeg makes a copy it can: the picture as it
// is where the browser plays it, else H.264, and AAC stereo sound. Each seek starts a new copy
// from that point, so the page asks for how long the title runs first.
import { spawn } from 'node:child_process';
import { DEFAULT_UA } from './fetch.js';

// Pictures a browser plays as they are (H.265 depends on the machine; a failure re-asks with encode).
const BROWSER_VIDEO = ['h264', 'hevc'];

/** ffmpeg arguments for a browser copy of a movie or episode, from t seconds in. */
export function vodCopyArgs({ url, userAgent, t = 0, vcodec = null, encode = false }) {
  const copy = !encode && BROWSER_VIDEO.includes(vcodec);
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-user_agent', userAgent || DEFAULT_UA, '-reconnect', '1', '-reconnect_delay_max', '5',
    ...(t > 0 ? ['-ss', String(t)] : []),
    '-i', url, '-map', '0:v:0', '-map', '0:a:0?',
    ...(copy
      ? ['-c:v', 'copy', ...(vcodec === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-vf', "scale=-2:'min(1080,ih)',format=yuv420p"]),
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    // Fragmented MP4: a browser plays it as it arrives.
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1',
  ];
}

/** What ffmpeg says about a title: { duration (seconds), video, audio } (codec names), each null if unknown. */
export function parseProbe(text) {
  const d = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
  return {
    duration: d ? Math.round(Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) : null,
    video: /Stream #[^\n]*?: Video: (\w+)/.exec(text)?.[1] || null,
    audio: /Stream #[^\n]*?: Audio: (\w+)/.exec(text)?.[1] || null,
  };
}

// The provider connection a movie or episode takes, as for a player app's.
function hold(ctx, target) {
  const item = { id: target.key, source_id: target.src.id };
  const admit = ctx.streams.admit(item);
  return admit.ok ? { release: ctx.streams.hold(item) } : { limit: admit.limit };
}

const lastLine = (s) => String(s || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';

/** How long a title runs and what it's in, for a browser copy. */
export async function probeVod(ctx, target) {
  if (!(await ctx.light.ffmpeg())) return { ffmpeg: false };
  const h = hold(ctx, target);
  if (!h.release) return { ffmpeg: true, busy: h.limit };
  try {
    const err = await new Promise((resolve) => {
      let text = '';
      const p = spawn(ctx.light.cmd[0], [...ctx.light.cmd.slice(1),
        '-hide_banner', '-nostdin', '-user_agent', target.src.user_agent || DEFAULT_UA, '-i', target.url], { stdio: ['ignore', 'ignore', 'pipe'] });
      const timer = setTimeout(() => p.kill('SIGKILL'), 20_000);
      p.stderr.on('data', (d) => { text += d; });
      p.on('error', () => resolve(text));
      p.on('close', () => {
        clearTimeout(timer);
        resolve(text);
      });
    });
    return { ffmpeg: true, ...parseProbe(err) };
  } finally {
    h.release();
  }
}

/**
 * A browser copy of a movie or episode from t seconds in. One ffmpeg per request, stopped when
 * the browser lets go (a seek closes it and asks again); it counts toward the conversion limit.
 */
export async function serveVodCopy(ctx, res, target, { t = 0, vcodec = null, encode = false, viewer = null } = {}) {
  const light = ctx.light;
  const text = (status, msg) => res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(msg);
  if (!(await light.ffmpeg())) return text(503, 'Converting needs ffmpeg, which is not installed on this server.');
  const max = light.max();
  if (light.jobs.size + light.vodCopies >= max) return text(503, `The server is already converting ${max} stream${max === 1 ? '' : 's'}, its limit (Settings → Light streams).`);
  const h = hold(ctx, target);
  if (!h.release) return text(503, `All ${h.limit} stream${h.limit === 1 ? '' : 's'} for this source are in use.`);
  light.vodCopies++;
  const args = vodCopyArgs({ url: target.url, userAgent: target.src.user_agent, t, vcodec, encode });
  const p = spawn(light.cmd[0], [...light.cmd.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  let unview = () => {};
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    light.vodCopies--;
    h.release();
    unview();
    p.kill('SIGKILL');
  };
  res.on('close', finish);
  p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  p.on('error', (e) => { err += e.message; });
  // Headers wait for the first bytes, so a title that won't open says why instead of playing nothing.
  p.stdout.once('data', (first) => {
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-cache' });
    if (viewer) unview = ctx.viewers.open({ ...viewer, transcode: encode || !BROWSER_VIDEO.includes(vcodec) ? 'software' : 'sound only' });
    res.write(first);
    p.stdout.pipe(res);
  });
  p.on('close', (code) => {
    if (!res.headersSent && !res.destroyed) text(502, `The copy couldn't be made: ${lastLine(err) || `ffmpeg stopped (${code})`}`);
    else res.end();
    finish();
  });
}
