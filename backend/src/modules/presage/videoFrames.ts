// Decodes a recording into the raw frames SmartSpectra takes through
// useCustomInput() / sendFrame(). Its own file reader can't open videos on
// Windows (the win32 runtime package ships without FFmpeg), and its face
// detection misses faces in frames much under 720 px tall, so every frame is
// scaled to fit 1280x720, keeping its shape with black bars.

import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;
export const FRAME_RATE = 30;
/** Bytes in one RGB frame. */
export const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 3;

/** ffmpeg arguments that write `input` to stdout as RGB frames of FRAME_WIDTH x FRAME_HEIGHT at FRAME_RATE. */
export function frameArgs(input: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-an",
    "-vf",
    `fps=${FRAME_RATE},scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=decrease,pad=${FRAME_WIDTH}:${FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ];
}

/**
 * Decodes `input` with the bundled ffmpeg, yielding one RGB frame at a time.
 * Stopping early kills ffmpeg. Throws if ffmpeg can't decode the file.
 */
export async function* readFrames(input: string): AsyncGenerator<Buffer> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static has no binary for this platform");
  }
  const child = spawn(ffmpegPath, frameArgs(input), { windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-2_000);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  // Awaited below; this only stops an early exit from reporting it as unhandled.
  exited.catch(() => undefined);
  try {
    let frame = Buffer.allocUnsafe(FRAME_BYTES);
    let filled = 0;
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      let offset = 0;
      while (offset < chunk.length) {
        const copied = chunk.copy(frame, filled, offset);
        filled += copied;
        offset += copied;
        if (filled === FRAME_BYTES) {
          yield frame;
          frame = Buffer.allocUnsafe(FRAME_BYTES);
          filled = 0;
        }
      }
    }
    const code = await exited;
    if (code !== 0) {
      throw new Error(
        `ffmpeg could not decode the recording (exit ${String(code)}): ${stderr.trim()}`,
      );
    }
  } finally {
    if (child.exitCode === null) child.kill();
  }
}
