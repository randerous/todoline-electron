import fs from 'node:fs/promises';
import path from 'node:path';
export function clipboardFilePaths(packet:Buffer):string[]{
  const invalid=()=>new Error('剪贴板文件列表无效，请重新复制。');
  if(packet.length<4||packet.length>2*1024*1024)throw invalid();
  const count=packet.readUInt32LE();if(count>1000)throw invalid();
  const files:string[]=[];let offset=4;
  for(let i=0;i<count;i++){
    if(offset+4>packet.length)throw invalid();const size=packet.readUInt32LE(offset);offset+=4;
    if(!size||size%2||size>65534||offset+size>packet.length)throw invalid();
    let file:string;try{file=new TextDecoder('utf-16le',{fatal:true}).decode(packet.subarray(offset,offset+size));}catch{throw invalid();}offset+=size;
    if(file.includes('\0')||!path.win32.isAbsolute(file)||!/^([a-z]:[\\/]|\\\\[^?.\\/][^\\/]*[\\/][^\\/]+)/i.test(file))throw invalid();
    files.push(file);
  }
  if(offset!==packet.length)throw invalid();return files;
}
export async function clipboardImageFiles(files:readonly string[]){
  // Mixed file selections follow Qt's URL-text fallback; do not read or import
  // just the image subset and silently discard the remaining selected files.
  if(!files.length||files.some(file=>! /\.(png|jpe?g|bmp|gif|webp|tiff?|ico)$/i.test(file)))return undefined;
  if(files.length>1000)throw new Error('图片数量过多，请分批复制。');
  const images:{name:string;data:Uint8Array}[]=[];let total=0;
  for(const file of files){
    const name=path.win32.basename(file);const handle=await fs.open(file,'r').catch((error:NodeJS.ErrnoException)=>{
      const reason=error.code==='ENOENT'?'文件已被移动或删除。':error.code==='EACCES'||error.code==='EPERM'?'没有读取权限或文件正在被占用。':'请检查文件是否仍可访问。';
      throw new Error(`无法读取图片 ${name}：${reason}`);
    });
    try{
      const before=await handle.stat();if(!before.isFile())throw new Error('请选择图片文件。');
      if(!before.size)throw new Error('图片文件为空。');
      if(before.size>100*1024*1024||(total+=before.size)>512*1024*1024)throw new Error('图片批次过大，请分批复制。');
      const data=Buffer.allocUnsafe(before.size);let offset=0;
      while(offset<data.length){const {bytesRead}=await handle.read(data,offset,data.length-offset,offset);if(!bytesRead)throw new Error('读取期间图片文件发生变化，请重新复制。');offset+=bytesRead;}
      const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('读取期间图片文件发生变化，请重新复制。');
      images.push({name,data:new Uint8Array(data.buffer,data.byteOffset,data.length)});
    }catch(error){throw new Error(`${name}：${String(error)}`);}finally{await handle.close();}
  }
  return images;
}
