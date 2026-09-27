import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { afterAll, describe, expect, it } from "vitest";
import {
  FRAME_BYTES,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  readFrames,
} from "../src/modules/presage/videoFrames";

const dir = mkdtempSync(join(tmpdir(), "preptalk-frames-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A 1 second, 30 fps, 4:3 red WebM, the shape a browser's default camera records. */
function redWebm(): string {
  const file = join(dir, "red.webm");
  const { status, stderr } = spawnSync(ffmpegPath!, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:size=320x240:rate=30:duration=1",
    "-c:v",
    "libvpx",
    file,
  ]);
  if (status !== 0) throw new Error(String(stderr));
  return file;
}

async function decode(file: string): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  for await (const frame of readFrames(file)) frames.push(frame);
  return frames;
}

const pixel = (frame: Buffer, x: number, y: number): number[] => {
  const at = (y * FRAME_WIDTH + x) * 3;
  return [...frame.subarray(at, at + 3)];
};

describe("readFrames", () => {
  it("decodes a recording into 1280x720 RGB frames at 30 fps, keeping its shape", async () => {
    const frames = await decode(redWebm());

    expect(frames).toHaveLength(30);
    expect(frames.every((frame) => frame.length === FRAME_BYTES)).toBe(true);
    // A 4:3 video fills the middle 960x720; the bars beside it are black.
    expect(Math.max(...pixel(frames[0], 20, FRAME_HEIGHT / 2))).toBeLessThan(8);
    const [r, g, b] = pixel(frames[0], FRAME_WIDTH / 2, FRAME_HEIGHT / 2);
    expect(r).toBeGreaterThan(200);
    expect(Math.max(g, b)).toBeLessThan(40);
  });

  it("fails on a file ffmpeg can't decode", async () => {
    const file = join(dir, "broken.webm");
    writeFileSync(file, "not a video");
    await expect(decode(file)).rejects.toThrow(/ffmpeg could not decode/);
  });
});
