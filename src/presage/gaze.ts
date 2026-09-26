// Gaze / eye-contact estimate from the SDK's face landmarks. Pure geometry: no
// SDK, DOM or Electron imports.
//
// The SDK sends 478 landmarks but doesn't document their layout. 478 is
// MediaPipe Face Mesh's 468 points plus 10 iris points (the SDK bundles
// MediaPipe, see its NOTICE), so the indices below follow that layout. Each
// iris must sit between its eye corners; if it doesn't, the layout is not what
// we expect and we return null rather than a wrong reading.
//
// Coordinates are in the unmirrored camera frame, so image-right is the
// person's left.
//
// How the estimate works:
//  - Horizontal: where each iris sits between its two eye corners, plus a
//    head-turn term (nose tip position between the cheek edges). Turning the
//    head while keeping your eyes on the camera moves these in opposite
//    directions, so they cancel out.
//  - Vertical: iris distance above/below the line joining the eye corners.
//    Head tilt is not compensated, so this axis is rougher than horizontal.

import { GAZE } from './constants';
import type { GazeDirection, GazeReading, LandmarksReading, Point2D } from './types';

const MESH_POINTS = 478;

// Corners listed image-left to image-right.
const EYES = [
  { left: 33, right: 133, top: 159, bottom: 145, iris: 468 }, // person's right eye
  { left: 362, right: 263, top: 386, bottom: 374, iris: 473 }, // person's left eye
] as const;
const NOSE_TIP = 1;
const CHEEK_IMAGE_LEFT = 234;
const CHEEK_IMAGE_RIGHT = 454;

const sub = (a: Point2D, b: Point2D): Point2D => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point2D, b: Point2D): number => a.x * b.x + a.y * b.y;

/** Classify offsets (eye widths) into a direction, using the GAZE thresholds. */
export function classifyGaze(h: number, v: number): GazeDirection {
  const nh = Math.abs(h) / GAZE.maxCameraH;
  const nv = Math.abs(v) / GAZE.maxCameraV;
  if (nh <= 1 && nv <= 1) return 'camera';
  if (nh >= nv) return h > 0 ? 'left' : 'right';
  return v > 0 ? 'down' : 'up';
}

/** Estimate gaze from one landmark set. Null if the eyes are closed or the layout isn't recognized. */
export function estimateGaze(lm: LandmarksReading): GazeReading | null {
  const p = lm.points;
  if (p.length < MESH_POINTS) return null;

  let h = 0;
  let v = 0;
  let openness = 0;
  for (const eye of EYES) {
    const left = p[eye.left];
    const right = p[eye.right];
    const top = p[eye.top];
    const bottom = p[eye.bottom];
    const iris = p[eye.iris];
    if (!left || !right || !top || !bottom || !iris) return null;
    const axis = sub(right, left);
    const w2 = dot(axis, axis);
    if (w2 < 1e-9) return null;
    const w = Math.sqrt(w2);
    // 0 at the image-left corner, 1 at the image-right corner.
    const along = dot(sub(iris, left), axis) / w2;
    if (along < 0 || along > 1) return null;
    // Unit normal to the corner line, pointing image-down (y grows downward).
    const normal = { x: -axis.y / w, y: axis.x / w };
    const mid = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
    h += along - 0.5;
    v += dot(sub(iris, mid), normal) / w;
    openness += Math.abs(dot(sub(bottom, top), normal)) / w;
  }
  h /= EYES.length;
  v /= EYES.length;
  openness /= EYES.length;
  if (openness < GAZE.minEyeOpenness) return null;

  const nose = p[NOSE_TIP];
  const cheekL = p[CHEEK_IMAGE_LEFT];
  const cheekR = p[CHEEK_IMAGE_RIGHT];
  if (!nose || !cheekL || !cheekR) return null;
  const faceAxis = sub(cheekR, cheekL);
  const f2 = dot(faceAxis, faceAxis);
  if (f2 < 1e-9) return null;
  // -1..1, positive when the nose points toward image-right (the person's left).
  const yaw = (dot(sub(nose, cheekL), faceAxis) / f2 - 0.5) * 2;

  const gazeH = h + GAZE.headYawWeight * yaw;
  return { tUs: lm.tUs, h: gazeH, v, direction: classifyGaze(gazeH, v) };
}
