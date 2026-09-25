import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const require=createRequire(import.meta.url);
// `prepare` runs on every install. The validated binding below only exists for
// Windows x64; other platforms use the prebuilds that `prepare-mac.mjs` fetches,
// so stop before importing prepare-runtime.mjs (it throws off Windows).
if(process.platform!=='win32'||process.arch!=='x64'){
  console.log('prepare-native: skipping, this validated native build targets Windows x64 (macOS: pnpm prepare:mac).');
  process.exit(0);
}
await import('./prepare-runtime.mjs');
const electron=require('electron/package.json').version,sqlite=require('better-sqlite3/package.json').version;
const supported={electron:'40.10.6',sqlite:'12.11.1',abi:'143',sha256:'444e397d34802809350005cd1778de213e0b8a7813ac04b22f1124a556a86c3e'};
if(electron!==supported.electron||sqlite!==supported.sqlite)throw new Error('This validated native build targets Electron 40.10.6 + SQLite module 12.11.1 on Windows x64. Revalidate the binary when upgrading.');
await fs.mkdir('.cache/native',{recursive:true});
const archive='.cache/native/electron.tar.gz';
let bytes;try{bytes=await fs.readFile(archive);}catch{}
const valid=b=>b&&createHash('sha256').update(b).digest('hex')===supported.sha256;
if(!valid(bytes)){
  const name=`better-sqlite3-v${sqlite}-electron-v${supported.abi}-win32-x64.tar.gz`;
  const sources=[`https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqlite}/${name}`,`https://npmmirror.com/mirrors/better-sqlite3/v${sqlite}/${name}`];
  for(const url of sources){try{const res=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!res.ok)throw new Error(String(res.status));const value=Buffer.from(await res.arrayBuffer());if(!valid(value))throw new Error('Native binary checksum mismatch');bytes=value;break;}catch(e){console.error('Native download:',new URL(url).hostname,e.message);}}
  if(!valid(bytes))throw new Error('Unable to download the validated native module.');
  await fs.writeFile(archive,bytes);
}
execFileSync('tar',['-xf',archive,'-C','.cache/native','build/Release/better_sqlite3.node'],{windowsHide:true});
await fs.copyFile('.cache/native/build/Release/better_sqlite3.node','.cache/native/electron.node');
console.log('Electron SQLite native module ready (SHA-256 verified). Node test binding remains separate.');
