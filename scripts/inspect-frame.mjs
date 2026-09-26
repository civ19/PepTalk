// npm run inspect-frame <sessionId | session folder> <tMs> [<tMs> ...] [-- --shift=<ms>]
//
// Alignment check: extracts the video frame at each tMs and draws the eye
// landmarks stored for that tMs on top (corners/lids green, irises red). If
// video and samples share one clock, the dots sit on the eyes even while the
// head is moving. Also prints the samples in effect at that moment.
// Writes <session folder>/inspect-<tMs>.png.
//
// --shift=<ms> draws the landmarks from tMs + shift instead: a deliberately
// misaligned control. Compare it with the unshifted image during head motion.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');

const argv = process.argv.slice(2);
const shiftArg = argv.find((a) => a.startsWith('--shift='));
const shiftMs = shiftArg ? Number(shiftArg.slice('--shift='.length)) : 0;
const [target, ...times] = argv.filter((a) => !a.startsWith('--'));
if (!target || times.length === 0) {
  console.error('usage: npm run inspect-frame <sessionId | folder> <tMs> [<tMs> ...]');
  process.exit(1);
}
const dir = [target, join(root, 'sessions', target), join(root, 'fixtures', target)].find((d) => existsSync(join(d, 'session.json')));
if (!dir) {
  console.error(`no session.json for ${target}`);
  process.exit(1);
}
const session = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
if (!session.recordingPath) {
  console.error('session has no recording');
  process.exit(1);
}
const records = readFileSync(join(dir, 'samples.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  })
  .sort((a, b) => a.tMs - b.tMs);
const face = records.filter((r) => r.kind === 'face' && r.eyeLandmarks);
const vitals = records.filter((r) => r.kind === 'vitals');
const validation = records.filter((r) => r.kind === 'validation');

for (const tArg of times) {
  const tMs = Number(tArg);
  const want = tMs + shiftMs;
  const nearest = face.reduce((best, r) => (!best || Math.abs(r.tMs - want) < Math.abs(best.tMs - want) ? r : best), null);
  if (!nearest) {
    console.error('no face samples with landmarks');
    process.exit(1);
  }
  const eyes = nearest.eyeLandmarks;
  const box = (p, color, size) => `drawbox=x=${Math.round(p.x - size / 2)}:y=${Math.round(p.y - size / 2)}:w=${size}:h=${size}:color=${color}:t=fill`;
  // The frame on screen at tMs: the first frame at or after tMs - 2 ms (samples sit ~0.5 ms after
  // their frame's pts). Fast-seek to 3 s before, keeping the file's own timestamps (-copyts).
  const filters = [`select=gte(t\\,${((tMs - 2) / 1000).toFixed(4)})`, 'showinfo'];
  for (const e of [eyes.right, eyes.left]) {
    for (const p of [e.outerCorner, e.innerCorner, e.upperLid, e.lowerLid]) filters.push(box(p, 'lime', 4));
    for (const p of e.irisContour) filters.push(box(p, 'red', 3));
    filters.push(box(e.irisCenter, 'red', 5));
  }
  const out = join(dir, `inspect-${Math.round(tMs)}${shiftMs ? `-shift${shiftMs}` : ''}.png`);
  const res = spawnSync(
    ffmpeg,
    ['-hide_banner', '-y', '-ss', Math.max(0, tMs / 1000 - 3).toFixed(3), '-copyts', '-i', join(dir, session.recordingPath), '-frames:v', '1', '-vf', filters.join(','), out],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    console.error(res.stderr.slice(-800));
    process.exit(1);
  }
  const pts = /pts_time:([\d.]+)/.exec(res.stderr);
  const lastBefore = (arr) => arr.filter((r) => r.tMs <= tMs).at(-1) ?? null;
  const pulse = [...vitals].reverse().find((v) => v.tMs <= tMs && v.pulseBpm !== null) ?? null;
  const val = lastBefore(validation);
  console.log(`\n=== tMs ${tMs} -> ${out}`);
  console.log(`video frame shown: pts ${pts ? (Number(pts[1]) * 1000).toFixed(1) : '?'} ms; face sample used: tMs ${nearest.tMs} (${(nearest.tMs - tMs).toFixed(1)} ms away${shiftMs ? ', SHIFTED CONTROL' : ''})`);
  console.log(`face: blinking=${nearest.blinking} talking=${nearest.talking} gaze=${nearest.gaze?.direction ?? '-'} headPose=${JSON.stringify(nearest.headPose)}`);
  if (nearest.expressions) {
    const top = Object.entries(nearest.expressions).sort((a, b) => b[1] - a[1]).slice(0, 2);
    console.log(`expression: ${top.map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(', ')}`);
  }
  console.log(`last pulse: ${pulse ? `${pulse.pulseBpm} bpm (conf ${pulse.pulseConfidence}) at tMs ${pulse.tMs}` : 'none yet'}`);
  console.log(`validation: ${val ? `${val.name} since tMs ${val.tMs}` : 'none yet'}`);
}
