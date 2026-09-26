import { describe, expect, it } from 'vitest';
import { clipIdFor } from '../flags/ids';
import { CLIP_MAX_MS, CLIP_MIN_MS, planClips } from './plan';

const S = '405d0588-302d-4b44-9e4e-96c8a73c75fe';
const flag = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs });
const ranges = (plan: ReturnType<typeof planClips>) => plan.map((c) => [c.startMs, c.endMs, c.flagIds]);

describe('planClips', () => {
  it('pads 3 s before and 2 s after, with the thumbnail at the flag midpoint', () => {
    const [clip, ...more] = planClips(S, [flag('a', 30_000, 33_000)], 75_410);
    expect(more).toEqual([]);
    expect(clip).toEqual({ id: clipIdFor(S, 27_000, 35_000), startMs: 27_000, endMs: 35_000, flagIds: ['a'], thumbMs: 31_500 });
  });

  it('merges flags whose padded windows overlap, even when the flags themselves do not', () => {
    // [27, 35] and [33, 40] overlap; [57, 64] is on its own.
    const plan = planClips(S, [flag('c', 60_000, 62_000), flag('b', 36_000, 38_000), flag('a', 30_000, 33_000)], 75_410);
    expect(ranges(plan)).toEqual([
      [27_000, 40_000, ['a', 'b']],
      [57_000, 64_000, ['c']],
    ]);
    // Thumbnail: midpoint of the merged moment [30, 38].
    expect(plan[0]?.thumbMs).toBe(34_000);
  });

  it('merges windows that just touch, and whole chains', () => {
    // a pads to [7, 12], b to [12, 17], c to [16, 21]
    expect(ranges(planClips(S, [flag('a', 10_000, 10_000), flag('b', 15_000, 15_000), flag('c', 19_000, 19_000)], 60_000))).toEqual([
      [7_000, 21_000, ['a', 'b', 'c']],
    ]);
  });

  it('keeps flags whose windows do not overlap apart', () => {
    expect(ranges(planClips(S, [flag('a', 10_000, 10_000), flag('b', 15_100, 15_100)], 60_000))).toEqual([
      [7_000, 12_000, ['a']],
      [12_100, 17_100, ['b']],
    ]);
  });

  it('clamps to the video and widens edge clips to 4 s', () => {
    expect(ranges(planClips(S, [flag('start', 0, 500)], 60_000))).toEqual([[0, CLIP_MIN_MS, ['start']]]);
    expect(ranges(planClips(S, [flag('end', 59_800, 60_000)], 60_000))).toEqual([[56_000, 60_000, ['end']]]);
    // Shorter than 4 s: the whole video.
    expect(ranges(planClips(S, [flag('tiny', 1_000, 1_500)], 2_500))).toEqual([[0, 2_500, ['tiny']]]);
  });

  it('caps clips at 20 s: a long flag keeps its onset', () => {
    const [clip] = planClips(S, [flag('long', 10_000, 50_000)], 75_000);
    expect([clip?.startMs, clip?.endMs]).toEqual([7_000, 7_000 + CLIP_MAX_MS]);
    // The midpoint (30 s) is past the end of the clip, so the thumbnail stays inside it.
    expect(clip?.thumbMs).toBe(7_000 + CLIP_MAX_MS - 100);
  });

  it('splits an overlapping chain rather than exceed 20 s', () => {
    // Padded: [7, 14] [11, 18] [15, 22] [19, 26] [23, 30]: one chain, 23 s long.
    const flags = [10, 14, 18, 22, 26].map((s, i) => flag(`f${i}`, s * 1000, (s + 2) * 1000));
    const plan = planClips(S, flags, 60_000);
    expect(ranges(plan)).toEqual([
      [7_000, 26_000, ['f0', 'f1', 'f2', 'f3']],
      [23_000, 30_000, ['f4']],
    ]);
    for (const c of plan) expect(c.endMs - c.startMs).toBeLessThanOrEqual(CLIP_MAX_MS);
    // Every flag is in exactly one clip.
    expect(plan.flatMap((c) => c.flagIds).sort()).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
  });

  it('gives no clip to flags that start after the video ends', () => {
    expect(planClips(S, [flag('late', 80_000, 81_000)], 75_000)).toEqual([]);
  });

  it('is deterministic: same flags, any order, same ids', () => {
    const a = planClips(S, [flag('x', 5_000, 6_000), flag('y', 40_000, 41_000)], 60_000);
    const b = planClips(S, [flag('y', 40_000, 41_000), flag('x', 5_000, 6_000)], 60_000);
    expect(b).toEqual(a);
    expect(new Set(a.map((c) => c.id)).size).toBe(2);
    expect(a[0]?.id).toMatch(/^[0-9a-f]{16}$/);
    // Another session: other ids.
    expect(planClips('00000000-0000-4000-8000-000000000000', [flag('x', 5_000, 6_000)], 60_000)[0]?.id).not.toBe(a[0]?.id);
  });
});
