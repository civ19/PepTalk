// ffmpeg helpers. A browser's MediaRecorder writes WebM without duration or
// cues (or fragmented MP4), so players can't seek it until it's remuxed.
// Remuxing is a stream copy: no re-encode. ffmpeg-static ships the binary for
// Windows, macOS and Linux.

import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const TIMEOUT_MS = 120_000;

/** Runs the bundled ffmpeg. Resolves with the exit code (null if it was killed) and the tail of stderr. */
export function runFfmpeg(
  args: string[],
  timeoutMs = TIMEOUT_MS,
): Promise<{ code: number | null; stderr: string }> {
  const bin = ffmpegPath;
  if (!bin) {
    return Promise.reject(
      new Error("ffmpeg-static has no binary for this platform"),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    const timer = setTimeout(() => {
      stderr += `\ntimed out after ${timeoutMs} ms`;
      child.kill();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/** Stream-copies `input` into `output` (container from the extension). */
export async function remux(input: string, output: string): Promise<void> {
  const mp4 = output.toLowerCase().endsWith(".mp4");
  const { code, stderr } = await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    "0",
    "-c",
    "copy",
    // Moves the index to the front so players can seek before downloading everything.
    ...(mp4 ? ["-movflags", "+faststart"] : []),
    output,
  ]);
  if (code !== 0) {
    throw new Error(
      `ffmpeg remux failed (exit ${String(code)}): ${stderr.trim().slice(-500)}`,
    );
  }
}

/** Duration in ms from ffmpeg's input banner ("Duration: 00:01:02.50"). */
export function parseDurationMs(banner: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(banner);
  if (!m) return null;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Math.round(seconds * 1000);
}

/** Duration of a media file in ms, or null if ffmpeg can't tell. */
export async function probeDurationMs(file: string): Promise<number | null> {
  // With no output file ffmpeg prints the input info and exits non-zero; that's expected.
  const { stderr } = await runFfmpeg(["-hide_banner", "-i", file]);
  return parseDurationMs(stderr);
}
