import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const source='src/native/image-codec.cpp',out='out/main/image-codec.exe',stamp='.cache/native/image-codec-source.sha256';
const hash=createHash('sha256').update(fs.readFileSync(source)).digest('hex');
if(!fs.existsSync(out)||!fs.existsSync(stamp)||fs.readFileSync(stamp,'utf8')!==hash){
  const compiler=process.env.CXX||(fs.existsSync('E:/Qt/Tools/mingw1310_64/bin/g++.exe')?'E:/Qt/Tools/mingw1310_64/bin/g++.exe':'g++');
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.mkdirSync(path.dirname(stamp),{recursive:true});
  execFileSync(compiler,['-std=c++17','-O2','-s','-static',source,'-lole32','-lwindowscodecs','-luuid','-o',out],{stdio:'inherit',windowsHide:true,env:{...process.env,PATH:path.dirname(compiler)+path.delimiter+process.env.PATH}});
  fs.writeFileSync(stamp,hash);
}
