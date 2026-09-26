// npm run export-fixture <sessionId> [-- --force]
//
// Copies sessions/<id>/ (session.json, samples.ndjson, recording.*) to
// fixtures/<id>/ so the analytics module can be developed without a webcam.
// Looks in ./sessions (dev) and the packaged app's userData sessions folder.
//
// The copy contains the recorded person's face video, voice and physiological
// readings: only share fixtures recorded by (and with the consent of) the
// person in them.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const force = args.includes('--force');
if (!id) {
  console.error('usage: npm run export-fixture <sessionId>');
  process.exit(1);
}

const appData =
  process.platform === 'win32'
    ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
const candidates = [join(root, 'sessions', id), join(appData, 'presage-vitals-module', 'sessions', id)];
const src = candidates.find((d) => existsSync(join(d, 'session.json')));
if (!src) {
  console.error(`session ${id} not found in:\n  ${candidates.join('\n  ')}`);
  process.exit(1);
}

const session = JSON.parse(readFileSync(join(src, 'session.json'), 'utf8'));
if (session.status === 'recording') {
  console.error(`session ${id} is still recording (or the app crashed; relaunch the app to recover it first).`);
  process.exit(1);
}
const files = ['session.json', 'samples.ndjson', session.recordingPath].filter(Boolean);
const dest = join(root, 'fixtures', id);
if (existsSync(dest) && !force) {
  console.error(`${dest} already exists (pass -- --force to overwrite)`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
for (const f of files) {
  if (!existsSync(join(src, f))) {
    console.warn(`missing ${f}, skipped`);
    continue;
  }
  copyFileSync(join(src, f), join(dest, f));
  console.log(`copied ${f} (${(statSync(join(dest, f)).size / 1e6).toFixed(2)} MB)`);
}
const extra = readdirSync(src).filter((f) => !files.includes(f));
if (extra.length) console.log(`not copied: ${extra.join(', ')}`);
console.log(`\nfixture: ${dest}`);
console.log("It contains a real person's face video, voice and vitals. Share it only with their consent.");
