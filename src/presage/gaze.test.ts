import { describe, expect, it } from 'vitest';
import { estimateGaze } from './gaze';
import type { LandmarksReading, Point2D } from './types';

interface FaceOpts {
  /** Iris offset in eye widths (+x = image-right, +y = down). */
  irisX?: number;
  irisY?: number;
  /** Nose-tip offset as a fraction of face width (+ = image-right). */
  noseX?: number;
  /** Half the lid gap in px (eye width is 40 px). */
  lidHalfGap?: number;
  count?: number;
}

// A synthetic MediaPipe-layout face: eyes 40 px wide, face 200 px wide.
function face({ irisX = 0, irisY = 0, noseX = 0, lidHalfGap = 8, count = 478 }: FaceOpts = {}): LandmarksReading {
  const points: Point2D[] = Array.from({ length: count }, () => ({ x: 0, y: 0 }));
  const set = (i: number, x: number, y: number): void => {
    if (i < count) points[i] = { x, y };
  };
  for (const [l, r, top, bottom, iris, cx] of [
    [33, 133, 159, 145, 468, 120],
    [362, 263, 386, 374, 473, 200],
  ] as const) {
    set(l, cx - 20, 100);
    set(r, cx + 20, 100);
    set(top, cx, 100 - lidHalfGap);
    set(bottom, cx, 100 + lidHalfGap);
    set(iris, cx + irisX * 40, 100 + irisY * 40);
  }
  set(234, 60, 120);
  set(454, 260, 120);
  set(1, 160 + noseX * 200, 130);
  return { tUs: 1, points, stable: true, reset: false };
}

describe('estimateGaze', () => {
  it('reads a centered iris on a forward-facing head as camera', () => {
    const g = estimateGaze(face());
    expect(g?.direction).toBe('camera');
    expect(g?.h).toBeCloseTo(0);
    expect(g?.v).toBeCloseTo(0);
  });

  it('maps image-right to the person\'s left, and down to down', () => {
    expect(estimateGaze(face({ irisX: 0.15 }))?.direction).toBe('left');
    expect(estimateGaze(face({ irisX: -0.15 }))?.direction).toBe('right');
    expect(estimateGaze(face({ irisY: 0.12 }))?.direction).toBe('down');
    expect(estimateGaze(face({ irisY: -0.12 }))?.direction).toBe('up');
  });

  it('compensates head turn with the opposite eye movement', () => {
    // Head turned (yaw 0.5 -> +0.2 eye widths) with eyes still on the lens.
    expect(estimateGaze(face({ noseX: 0.25, irisX: -0.2 }))?.direction).toBe('camera');
    // Same head turn, eyes following the head.
    expect(estimateGaze(face({ noseX: 0.25 }))?.direction).toBe('left');
  });

  it('returns null mid-blink, for short point sets, and for an unrecognized layout', () => {
    expect(estimateGaze(face({ lidHalfGap: 1 }))).toBeNull();
    expect(estimateGaze(face({ count: 468 }))).toBeNull();
    expect(estimateGaze(face({ irisX: 0.8 }))).toBeNull();
  });
});
