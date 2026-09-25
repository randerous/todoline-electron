// macOS development runtime setup.
//
// prepare-native.mjs only accepts Windows x64 and downloads a SHA-256 pinned
// Electron-ABI binding. On macOS both ABIs are needed:
//   * node ABI    -> node_modules/better-sqlite3/build/Release (vitest, storage tests)
//   * electron ABI-> .cache/native/electron.node            (scripts/build-mac.mjs)
//
// Prebuilds come from the npmmirror mirror first because the GitHub release
// assets are unreachable on some networks. Override with:
//   TODOLINE_SQLITE_MIRROR, TODOLINE_ELECTRON_MIRROR
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
if (process.platform === 'win32') {
  console.log('prepare-mac: Windows uses scripts/prepare-native.mjs; nothing to do.');
  process.exit(0);
}
const platform = process.platform, arch = process.arch;
const sqliteVersion = require('better-sqlite3/package.json').version;
const electronVersion = require('electron/package.json').version;
const electronAbi = (await fs.readFile('node_modules/electron/abi_version', 'utf8')).trim();
const nodeAbi = process.versions.modules;
const mirror = (process.env.TODOLINE_SQLITE_MIRROR ?? 'https://npmmirror.com/mirrors/better-sqlite3').replace(/\/$/, '');
const downloads = '.cache/downloads';

async function fetchPrebuild(name) {
  const url = `${mirror}/v${sqliteVersion}/${name}`;
  const local = path.join(downloads, name);
  if (existsSync(local)) return local;
  console.log(`prepare-mac: downloading ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Cannot download ${url} (HTTP ${response.status}). Set TODOLINE_SQLITE_MIRROR to a reachable mirror.`);
  await fs.mkdir(downloads, { recursive: true });
  await fs.writeFile(local, Buffer.from(await response.arrayBuffer()));
  return local;
}

async function installBinding({ runtime, abi, target }) {
  if (existsSync(target)) { console.log(`prepare-mac: ${target} already present`); return; }
  const name = `better-sqlite3-v${sqliteVersion}-${runtime}-v${abi}-${platform}-${arch}.tar.gz`;
  const archive = await fetchPrebuild(name);
  const staging = path.join('.cache/native', `${runtime}-extract`);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', staging, '--strip-components=2', 'build/Release/better_sqlite3.node']);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(staging, 'better_sqlite3.node'), target);
  await fs.rm(staging, { recursive: true, force: true });
  console.log(`prepare-mac: ${target} ready`);
}

await installBinding({ runtime: 'node', abi: nodeAbi, target: 'node_modules/better-sqlite3/build/Release/better_sqlite3.node' });
await installBinding({ runtime: 'electron', abi: electronAbi, target: '.cache/native/electron.node' });

if (!existsSync(path.join('node_modules/electron/dist', 'Electron.app'))) {
  console.log('prepare-mac: Electron binary missing, running node_modules/electron/install.js');
  execFileSync(process.execPath, [path.join('node_modules/electron/install.js')], {
    stdio: 'inherit',
    env: { ...process.env, ...(process.env.TODOLINE_ELECTRON_MIRROR ? { ELECTRON_MIRROR: process.env.TODOLINE_ELECTRON_MIRROR } : {}) },
  });
}
console.log(`prepare-mac: ready (node ABI ${nodeAbi}, electron ${electronVersion} ABI ${electronAbi}, ${platform}-${arch})`);
