import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
if(process.platform!=='win32')throw new Error('This release builds the Windows clipboard helper.');
const source='src/native/clipboard-win.c',out='out/main/clipboard-win.exe',stamp='.cache/native/clipboard-source.sha256';
const hash=createHash('sha256').update(fs.readFileSync(source)).digest('hex');
if(!fs.existsSync(out)||!fs.existsSync(stamp)||fs.readFileSync(stamp,'utf8')!==hash){
  const compiler=process.env.CC||(fs.existsSync('E:/Qt/Tools/mingw1310_64/bin/gcc.exe')?'E:/Qt/Tools/mingw1310_64/bin/gcc.exe':'gcc');
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.mkdirSync(path.dirname(stamp),{recursive:true});
  execFileSync(compiler,['-std=c11','-O2','-s','-static',source,'-luser32','-lshell32','-o',out],{stdio:'inherit',windowsHide:true,env:{...process.env,PATH:path.dirname(compiler)+path.delimiter+process.env.PATH}});
  fs.writeFileSync(stamp,hash);
}
