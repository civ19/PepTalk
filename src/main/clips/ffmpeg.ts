// ffmpeg commands for clips and thumbnails. Each writes to a temp file and
// renames it into place only on success, so a file at the final path is always
// complete (clip generation skips files that already exist).

import { rename, rm, stat } from 'node:fs/promises';
import { runFfmpeg } from '../../capture/main/media';

// A 20 s 720p clip takes ~2 s with -preset veryfast; these only catch a hung ffmpeg.
const ENCODE_TIMEOUT_MS = 180_000;
const FRAME_TIMEOUT_MS = 30_000;

const secs = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(3);

/** 'clips/abc.mp4' -> 'clips/abc.tmp.mp4' (ffmpeg picks the format from the extension). */
const tmpPathFor = (file: string): string => file.replace(/(\.[^./\\]+)$/, '.tmp$1');

async function runToFile(what: string, args: string[], output: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
  const tmp = tmpPathFor(output);
  await rm(tmp, { force: true });
  const { code, stderr } = await runFfmpeg([...args, tmp], { timeoutMs, ...(signal ? { signal } : {}) });
  const size = (await stat(tmp).catch(() => null))?.size ?? 0;
  if (code !== 0 || size === 0) {
    await rm(tmp, { force: true });
    const detail = stderr.trim().slice(-500) || 'no output';
    throw new Error(code === 0 ? `${what}: ffmpeg wrote nothing (${detail})` : `${what}: ffmpeg exit ${String(code)}: ${detail}`);
  }
  await rename(tmp, output);
}

/** Cuts session time [startMs, endMs] of `input` into an H.264 + AAC MP4 that starts playing before it's fully loaded. */
export async function encodeClip(input: string, output: string, startMs: number, endMs: number, signal?: AbortSignal): Promise<void> {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    // -ss before -i seeks in the input, which is fast. ffmpeg then decodes from
    // the keyframe before startMs and drops what comes before it, so the cut is
    // still exact to the frame, and clip time 0 is session time startMs.
    '-ss', secs(startMs), '-i', input, '-t', secs(endMs - startMs),
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    // MediaRecorder video has a variable frame rate. Keep its frame times: for
    // mp4 the default resamples to a constant rate and duplicates frames, and
    // the default encoder time base (1/frame rate) snaps them to a grid.
    '-fps_mode', 'vfr', '-enc_time_base', '-1',
    '-c:a', 'aac', '-b:a', '128k',
    // Index (moov) first, so the player can start and seek without reading the whole file.
    '-movflags', '+faststart',
  ];
  await runToFile('clip encode', args, output, ENCODE_TIMEOUT_MS, signal);
}

/** Writes the frame shown at session time `atMs` as a 640 px wide JPEG. */
export async function extractFrame(input: string, output: string, atMs: number, signal?: AbortSignal): Promise<void> {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', secs(atMs), '-i', input,
    '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-update', '1',
  ];
  await runToFile('thumbnail', args, output, FRAME_TIMEOUT_MS, signal);
}
