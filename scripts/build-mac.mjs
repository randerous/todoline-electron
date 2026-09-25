// macOS development build: same steps as build.mjs minus the Windows-only
// native helpers (clipboard-win.exe / image-codec.exe) and the win32 runtime
// validation in prepare-runtime.mjs / prepare-native.mjs.
//
// It expects an Electron-ABI better_sqlite3.node prebuild in .cache/native, e.g.
//   curl -L -o bs3.tgz https://npmmirror.com/mirrors/better-sqlite3/v12.11.1/better-sqlite3-v12.11.1-electron-v143-darwin-arm64.tar.gz
//   tar -xzf bs3.tgz --strip-components=2 -C .cache/native build/Release/better_sqlite3.node
//   cp .cache/native/better_sqlite3.node .cache/native/electron.node
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { copyFile, mkdir, access } from 'node:fs/promises';

await access('.cache/native/electron.node').catch(() => {
  throw new Error('Missing .cache/native/electron.node (Electron ABI better-sqlite3 binding).');
});
await mkdir('out/main', { recursive: true });
await copyFile('.cache/native/electron.node', 'out/main/better_sqlite3.node');
await build({ entryPoints: ['src/main/index.ts'], outfile: 'out/main/index.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'], sourcemap: true });
await build({ entryPoints: ['src/main/db-worker.ts'], outfile: 'out/main/db-worker.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'], sourcemap: true });
await build({ entryPoints: ['src/main/preload.ts'], outfile: 'out/main/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['src/main/image-preload.ts'], outfile: 'out/main/image-preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['src/main/reminder-preload.ts'], outfile: 'out/main/reminder-preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await viteBuild();
console.log('macOS development build written to out/');
