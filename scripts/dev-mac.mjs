// macOS development launcher: build with build-mac.mjs, then start Electron.
//
// Electron's Chromium sandbox cannot initialize in some restricted environments
// (nested sandboxes, CI, remote shells); pass --no-sandbox when that happens.
// It is added automatically on macOS unless TODOLINE_KEEP_SANDBOX=1 is set.
import './build-mac.mjs';
import { spawn } from 'node:child_process';
const { default: electron } = await import('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = ['.', ...process.argv.slice(2)];
if (!process.env.TODOLINE_KEEP_SANDBOX && !args.includes('--no-sandbox')) {
  args.push('--no-sandbox');
  console.log('dev-mac: added --no-sandbox (set TODOLINE_KEEP_SANDBOX=1 to keep the Chromium sandbox)');
}
const child = spawn(electron, args, { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 0));
