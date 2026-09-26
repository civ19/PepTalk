// Post-build checks (run by `npm run verify`, after `electron-vite build`):
//  1. out/main keeps the SmartSpectra SDK external (a runtime require, not inlined).
//  2. out/preload contains the SDK's preload bridge but no koffi/native loader.
//  3. The native runtime for this platform resolves from node_modules the same
//     way the SDK does at runtime.
//  4. No `any` outside src/presage/decode.ts.
//  5. No blood-pressure / clinical vocabulary in UI or summary-producing code.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const require = createRequire(join(root, 'package.json'));
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

const read = (p) => readFileSync(join(root, p), 'utf8');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

// 1 + 2: build output
const mainJs = walk(join(root, 'out/main')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
check(/require\(["']@smartspectra\/node-sdk\/main["']\)/.test(mainJs), 'out/main requires @smartspectra/node-sdk/main at runtime (external)');
check(!/koffi\.load\(|resolveNativeLibrary/.test(mainJs), 'out/main does not inline the SDK FFI / native resolver');

const preloadJs = walk(join(root, 'out/preload')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
check(preloadJs.includes('__smartspectraBridge'), 'out/preload contains the SDK preload bridge');
check(!/koffi|resolveNativeLibrary|require\(["']@smartspectra/.test(preloadJs), 'out/preload has no koffi / native loader / node_modules require (sandbox-safe)');

// 3: native runtime resolution (mirrors @smartspectra/node-sdk/js/resolve-native.js)
const lib = { win32: 'smartspectra_capi.dll', darwin: 'libsmartspectra_capi.dylib', linux: 'libsmartspectra_capi.so' }[process.platform];
const pkg = `@smartspectra/node-sdk-${process.platform}-${process.arch}`;
let libPath = null;
try {
  libPath = join(dirname(require.resolve(`${pkg}/package.json`)), lib);
} catch {
  /* reported below */
}
check(libPath !== null && existsSync(libPath), `native runtime present: ${libPath ?? pkg + ' not installed'}`);

// 4: no `any` outside the decode adapter
const srcFiles = walk(join(root, 'src')).filter((f) => f.endsWith('.ts'));
const anyRe = /(:\s*any\b|<any>|\bas\s+any\b|any\[\])/;
const anyHits = srcFiles
  .filter((f) => !f.replace(/\\/g, '/').endsWith('src/presage/decode.ts'))
  .filter((f) => anyRe.test(readFileSync(f, 'utf8')))
  .map((f) => relative(root, f));
check(anyHits.length === 0, `no \`any\` outside src/presage/decode.ts${anyHits.length ? ': ' + anyHits.join(', ') : ''}`);

// 5: wellness-only vocabulary in anything the user sees or that ends up in the JSON
const vocabFiles = [...walk(join(root, 'src/renderer')), join(root, 'src/presage/sessionRecorder.ts'), join(root, 'src/presage/tracker.ts'), join(root, 'src/presage/types.ts')];
const banned = /blood[\s-]?pressure|arterial|systolic|diastolic|hypertens|apnea|diagnos|medical|clinical|patient|arrhythm|symptom/i;
const vocabHits = vocabFiles
  .filter((f) => banned.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')))
  .map((f) => relative(root, f));
check(vocabHits.length === 0, `no blood-pressure / clinical vocabulary in UI or summary code${vocabHits.length ? ': ' + vocabHits.join(', ') : ''}`);

process.exit(failures ? 1 : 0);
