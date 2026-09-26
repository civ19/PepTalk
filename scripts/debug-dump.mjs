// npm run debug:dump [-- <seconds>] [-- --manual]
//
// Launches the app with the raw payload dump on: the session starts by itself,
// the first <seconds> (default 60) of SDK events are written to
// debug/payload-dump.ndjson, then the session is stopped and the app closes.
// With --manual, nothing starts automatically; every session you start dumps
// its first <seconds>.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const seconds = args.find((a) => /^\d+$/.test(a)) ?? '60';
const manual = args.includes('--manual');

const launch = fileURLToPath(new URL('./launch.mjs', import.meta.url));
const env = { ...process.env, PRESAGE_DEBUG_DUMP_SECONDS: seconds, PRESAGE_DEBUG_AUTORUN: manual ? '0' : '1' };
const child = spawn(process.execPath, [launch, 'preview'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
