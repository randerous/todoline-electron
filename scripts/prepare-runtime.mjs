import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
export async function ensureRuntime(){
  const packagePath=require.resolve('electron/package.json'),root=path.dirname(packagePath),localRequire=createRequire(packagePath),version=localRequire('./package.json').version;
  const name=`electron-v${version}-win32-x64.zip`,zip=path.resolve('.cache/runtime',name),expected=localRequire('./checksums.json')[name];
  if(process.platform!=='win32'||process.arch!=='x64'||!expected)throw new Error('This build is validated for Windows x64.');
  const valid=async file=>{try{return createHash('sha256').update(await fs.readFile(file)).digest('hex')===expected;}catch{return false;}};
  if(!await valid(zip)){
    let source;try{for(const dir of await fs.readdir('.cache/electron',{withFileTypes:true})){if(!dir.isDirectory())continue;const file=path.resolve('.cache/electron',dir.name,name);if(await valid(file)){source=file;break;}}}catch{}
    if(!source){process.env.ELECTRON_MIRROR??='https://npmmirror.com/mirrors/electron/';source=await localRequire('@electron/get').downloadArtifact({version,artifactName:'electron',platform:'win32',arch:'x64',cacheRoot:path.resolve('.cache/electron'),checksums:localRequire('./checksums.json')});}
    if(!await valid(source))throw new Error('Electron runtime SHA-256 mismatch');await fs.mkdir(path.dirname(zip),{recursive:true});await fs.copyFile(source,zip);
  }
  try{await fs.access(path.join(root,'dist/electron.exe'));if((await fs.readFile(path.join(root,'path.txt'),'utf8'))==='electron.exe')return;}catch{}
  const {extract}=localRequire('@electron-internal/extract-zip');await extract(zip,{dir:path.join(root,'dist')});await fs.writeFile(path.join(root,'path.txt'),'electron.exe');
}
await ensureRuntime();
