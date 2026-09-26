// npm run flag        -- <sessionId> <startMs> <endMs> <type>   adds a manual flag
// npm run clips       -- <sessionId>                            cuts clips for the session's flags
// npm run detect      -- <sessionId>                            runs the detectors (placeholder for now)
// npm run flags:check -- <sessionId>                            checks flags.json, clips.json, clips/ and TigerData agree
//
// Runs the app's own code (src/main/flags/service.ts) in plain Node through
// vite-node, on sessions/<id>/ in the dev folder or in the packaged app's
// userData folder. When DATABASE_URL is set (environment or .env) and the
// session is already in TigerData, the result is mirrored there too.
//
// Don't run it on a session the app is cutting clips for at the same moment:
// the two processes don't coordinate their file writes.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseUrlFromEnv } from '../src/capture/main/db';
import { diffFlagsWithDb } from '../src/main/flags/db';
import { FlagsService, parseNewFlag, type SyncResult } from '../src/main/flags/service';
import { FLAG_TYPES, type Clip, type Flag } from '../src/shared/flags';

const USAGE = `usage:
  npm run flag -- <sessionId> <startMs> <endMs> <type>
  npm run clips -- <sessionId>
  npm run detect -- <sessionId>
  npm run flags:check -- <sessionId>
<type> is one of: ${FLAG_TYPES.join(', ')}`;

const root = fileURLToPath(new URL('..', import.meta.url));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function appDataDir(): string {
  if (process.platform === 'win32') return process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
}

/** Same places scripts/export-fixture.mjs looks: ./sessions (dev), then the packaged app's userData. */
function sessionsDirFor(sessionId: string): string {
  const candidates = [join(root, 'sessions'), join(appDataDir(), 'presage-vitals-module', 'sessions')];
  const found = candidates.find((d) => existsSync(join(d, sessionId, 'session.json')));
  if (!found) fail(`session ${sessionId} not found in:\n  ${candidates.join('\n  ')}`);
  return found;
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const describeFlag = (f: Flag): string =>
  `${f.id}  ${f.type.padEnd(16)} ${secs(f.startMs)}-${secs(f.endMs)}  ${f.severity}/${f.source}  ${JSON.stringify(f.evidence)}${f.clipId ? `  clip ${f.clipId}` : ''}`;
const describeClip = (c: Clip): string =>
  `${c.id}  ${secs(c.startMs)}-${secs(c.endMs)} (${secs(c.endMs - c.startMs)})  ${c.status}  flags: ${c.flagIds.join(', ')}${c.error ? `\n    ${c.error}` : ''}`;

function reportSync(result: SyncResult): boolean {
  switch (result.status) {
    case 'synced':
      console.log(`TigerData: mirrored ${result.flags} flag(s), ${result.clips} clip(s)`);
      return true;
    case 'unchanged':
      console.log('TigerData: already up to date');
      return true;
    case 'skipped':
      console.log(`TigerData: skipped (${result.reason})`);
      return true;
    case 'failed':
      console.error(`TigerData: sync failed (the local files were updated): ${result.error}`);
      return false;
  }
}

/** Read-only: flags.json, clips.json, the clip files and the TigerData rows all agree. */
async function check(id: string): Promise<boolean> {
  const dir = service.store.dirOf(id);
  const session = await service.store.readSession(id);
  const { flags, clips } = await service.list(id);
  const problems: string[] = [];
  const clipById = new Map(clips.map((c) => [c.id, c]));
  for (const f of flags) {
    if (f.clipId === undefined) problems.push(`flag ${f.id}: no clip yet (run npm run clips)`);
    else if (!clipById.get(f.clipId)?.flagIds.includes(f.id)) problems.push(`flag ${f.id}: clip ${f.clipId} doesn't list it`);
  }
  for (const c of clips) {
    for (const flagId of c.flagIds) if (!flags.some((f) => f.id === flagId)) problems.push(`clip ${c.id}: lists unknown flag ${flagId}`);
    if (c.status !== 'ready') problems.push(`clip ${c.id}: status ${c.status}${c.error ? ` (${c.error})` : ''}`);
    for (const rel of [c.path, c.thumbPath]) if (c.status === 'ready' && !existsSync(join(dir, rel))) problems.push(`clip ${c.id}: ${rel} is missing`);
  }
  const url = databaseUrlFromEnv();
  if (!url) console.log('TigerData: not configured (DATABASE_URL is not set); checked local files only');
  else if (session.upload.status !== 'uploaded') console.log('TigerData: the session is not uploaded yet; checked local files only');
  else problems.push(...(await diffFlagsWithDb(url, dir, session, flags, clips)));
  for (const p of problems) console.error(`  ${p}`);
  console.log(
    problems.length
      ? `${problems.length} problem(s).`
      : `OK: ${flags.length} flag(s) and ${clips.length} clip(s) agree across flags.json, clips.json, clips/${url && session.upload.status === 'uploaded' ? ' and TigerData' : ''}.`,
  );
  return problems.length === 0;
}

const envFile = join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const [command, sessionId, ...rest] = process.argv.slice(2);
if (!command || !sessionId) fail(USAGE);
const service = new FlagsService({
  sessionsDir: sessionsDirFor(sessionId),
  databaseUrl: databaseUrlFromEnv,
  // One sync at the end, reported below.
  autoSync: false,
  // Progress comes from onClipUpdate below; keep warnings and errors.
  log: { info: () => undefined, warn: console.warn, error: console.error },
});

let ok = true;
try {
  if (command === 'add') {
    const [start, end, type] = rest;
    if (start === undefined || end === undefined || type === undefined || rest.length > 3) fail(USAGE);
    const flag = await service.add(sessionId, parseNewFlag({ type, startMs: Number(start), endMs: Number(end) }));
    console.log(`flag ${describeFlag(flag)}`);
    const { flags } = await service.list(sessionId);
    console.log(`${flags.length} flag(s) in ${join(service.store.dirOf(sessionId), 'flags.json')}. Cut clips with: npm run clips -- ${sessionId}`);
  } else if (command === 'clips') {
    const started = Date.now();
    service.onClipUpdate((c) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${c.status.padEnd(7)} ${c.id} ${secs(c.startMs)}-${secs(c.endMs)}`));
    const clips = await service.generateClips(sessionId);
    const { flags } = await service.list(sessionId);
    console.log(`\n${clips.length} clip(s) for ${flags.length} flag(s) in ${Date.now() - started} ms:`);
    for (const c of clips) console.log(`  ${describeClip(c)}`);
    for (const f of flags.filter((x) => x.clipId === undefined)) console.log(`  (no clip: flag ${f.id} starts after the recording ends)`);
    ok = clips.every((c) => c.status === 'ready');
  } else if (command === 'detect') {
    const found = await service.runDetectors(sessionId);
    console.log(`${found.length} detector flag(s)${found.length ? ':' : '.'}`);
    for (const f of found) console.log(`  ${describeFlag(f)}`);
  } else if (command === 'check') {
    ok = await check(sessionId);
  } else {
    fail(USAGE);
  }
  if (command !== 'check') ok = reportSync(await service.sync(sessionId)) && ok;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  ok = false;
}
process.exit(ok ? 0 : 1);
