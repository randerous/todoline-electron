import './build.mjs';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { build, Platform, Arch } from 'electron-builder';
import { ensureRuntime } from './prepare-runtime.mjs';
process.env.ELECTRON_BUILDER_CACHE??=path.resolve('.cache/electron-builder');
process.env.ELECTRON_BUILDER_BINARIES_MIRROR??='https://npmmirror.com/mirrors/electron-builder-binaries/';
process.env.ELECTRON_MIRROR??='https://npmmirror.com/mirrors/electron/';
process.env.electron_config_cache??=path.resolve('.cache/electron');
const bundledPnpm=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback');
if(fs.existsSync(path.join(bundledPnpm,'pnpm.cmd')))process.env.PATH=bundledPnpm+path.delimiter+process.env.PATH;
// Git for Windows' pwd can return a POSIX path during builder's root probe.
// Keep its fallback collector on the package manager recorded by this project.
const metadata=JSON.parse(fs.readFileSync('package.json','utf8'));
process.env.npm_config_user_agent=`${metadata.packageManager.replace('@','/')} node/${process.version}`;
// A running portable version may lock its directory. Build each version apart.
const output=path.resolve('dist',`release-${metadata.version}`);
try{
  await build({targets:Platform.WINDOWS.createTarget(['zip'],Arch.x64),publish:'never',config:{directories:{output}}});
  const archive=`TodoLine-Electron-${metadata.version}-win-x64.zip`;
  fs.copyFileSync(path.join(output,archive),path.resolve('dist',archive));
}finally{await ensureRuntime();}
