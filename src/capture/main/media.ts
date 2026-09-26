// ffmpeg helpers (main process). Chromium's MediaRecorder output is
// fragmented MP4 or a WebM without duration/cues, so seeking is slow or
// broken until it's remuxed. Remuxing is a stream copy: no re-encode.

import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

/** Path of the bundled ffmpeg binary (unpacked from app.asar in packaged builds). */
export function ffmpegPath(): string | null {
  return ffmpegStatic ? ffmpegStatic.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') : null;
}

export interface RunOptions {
  /** Kills ffmpeg when aborted (e.g. the app is quitting). */
  signal?: AbortSignal;
  /** Kills ffmpeg if it runs longer than this. */
  timeoutMs?: number;
}

/** Runs the bundled ffmpeg. Resolves with the exit code (null if it was killed) and the tail of stderr. */
export function runFfmpeg(args: string[], options: RunOptions = {}): Promise<{ code: number | null; stderr: string }> {
  const bin = ffmpegPath();
  if (!bin) return Promise.reject(new Error('ffmpeg-static has no binary for this platform'));
  const { signal, timeoutMs } = options;
  if (signal?.aborted) return Promise.reject(new Error('ffmpeg was cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    const kill = (why: string): void => {
      stderr += `\n${why}`;
      child.kill();
    };
    const onAbort = (): void => kill('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = timeoutMs === undefined ? null : setTimeout(() => kill(`timed out after ${timeoutMs} ms`), timeoutMs);
    const done = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('close', (code) => {
      done();
      resolve({ code, stderr });
    });
  });
}

/** Stream-copies `input` into `output` (container from the extension). */
export async function remux(input: string, output: string): Promise<void> {
  const mp4 = output.toLowerCase().endsWith('.mp4');
  const { code, stderr } = await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-map',
    '0',
    '-c',
    'copy',
    // Moves the index to the front so players can seek before downloading everything.
    ...(mp4 ? ['-movflags', '+faststart'] : []),
    output,
  ]);
  if (code !== 0) throw new Error(`ffmpeg remux failed (exit ${String(code)}): ${stderr.trim().slice(-500)}`);
}

export interface MediaInfo {
  durationMs: number | null;
  /** Presentation time of the first packet, in ms. */
  startMs: number | null;
}

/** Reads duration and start time from ffmpeg's input banner. */
export async function probe(file: string): Promise<MediaInfo> {
  // Without an output ffmpeg prints the input info and exits non-zero; that's expected.
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', file]);
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const start = /start:\s*(-?\d+(?:\.\d+)?)/.exec(stderr);
  const durationMs = dur ? Math.round((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 1000) : null;
  return { durationMs, startMs: start ? Math.round(Number(start[1]) * 1000 * 1000) / 1000 : null };
}
