// Runs electron-vite with ELECTRON_RUN_AS_NODE cleared.
//
// VS Code's integrated terminal (itself an Electron app) exports
// ELECTRON_RUN_AS_NODE=1 to child processes. That makes the `electron` binary
// behave as plain Node, so the app exits immediately (the SmartSpectra sample
// README documents the same pitfall). Clearing it here makes `npm start` work
// from any terminal.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// electron-vite's package "exports" don't expose its bin, so locate it on disk.
const cli = fileURLToPath(new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url));
if (!existsSync(cli)) {
  console.error('electron-vite is not installed. Run `npm install` first.');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
