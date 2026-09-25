import {app,nativeImage,type NativeImage} from 'electron';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {decodeBrowserImage} from './browser-image';

const previews=new Map<string,Buffer>(),pending=new Map<string,Promise<Buffer>>();
let cachedBytes=0,tail=Promise.resolve();
const cacheLimit=32*1024*1024,outputLimit=256*1024*1024;
export {imageMime} from '../shared/image-mime';
import {imageMime} from '../shared/image-mime';

function validateBytes(data:Uint8Array){if(!(data instanceof Uint8Array)||!data.byteLength||data.byteLength>100*1024*1024)throw new Error('图片大小超出限制');}
function validateImage(image:NativeImage){
  if(image.isEmpty())throw new Error('无法读取图片');
  const {width,height}=image.getSize();if(width>32768||height>32768||width*height>64000000)throw new Error('图片像素尺寸超出限制');
  return image;
}
function convert(bytes:Buffer,mime:string):Promise<Buffer>{
  const key=createHash('sha256').update(bytes).digest('hex'),cached=previews.get(key);
  if(cached){previews.delete(key);previews.set(key,cached);return Promise.resolve(cached);}
  const running=pending.get(key);if(running)return running;
  const operation=tail.catch(()=>{}).then(()=>mime==='image/gif'||mime==='image/webp'?decodeBrowserImage(bytes,mime):new Promise<Buffer>((resolve,reject)=>{
    const executable=app.isPackaged?path.join(process.resourcesPath,'app.asar.unpacked','out','main','image-codec.exe'):path.join(__dirname,'image-codec.exe');
    const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','ignore']}),chunks:Buffer[]=[];let length=0,settled=false;
    const finish=(error?:Error,data?:Buffer)=>{if(settled)return;settled=true;clearTimeout(timeout);if(error){child.kill();reject(error);}else resolve(data!);};
    const timeout=setTimeout(()=>finish(new Error('图片解码超时')),30000);
    child.once('error',e=>finish(e));child.stdin.on('error',()=>{});
    child.stdout.on('data',(chunk:Buffer)=>{if(settled)return;if((length+=chunk.length)>outputLimit)finish(new Error('图片像素尺寸超出限制'));else chunks.push(chunk);});
    child.once('close',code=>{if(settled)return;if(code!==0||!length)finish(new Error(code===3?'图片像素尺寸超出限制':'无法读取图片'));else finish(undefined,Buffer.concat(chunks,length));});
    child.stdin.end(bytes);
  })).then(data=>{
    if(data.length<=cacheLimit){while(previews.size>=16||cachedBytes+data.length>cacheLimit){const first=previews.keys().next().value!;cachedBytes-=previews.get(first)!.length;previews.delete(first);}previews.set(key,data);cachedBytes+=data.length;}
    return data;
  });
  pending.set(key,operation);tail=operation.then(()=>{},()=>{});
  void operation.finally(()=>pending.delete(key)).catch(()=>{});return operation;
}
export async function imagePreview(data:Uint8Array,still=false){
  validateBytes(data);const bytes=Buffer.from(data),mime=imageMime(bytes);
  if(['image/tiff','image/bmp','image/x-icon'].includes(mime)||still&&['image/gif','image/webp'].includes(mime))return {data:await convert(bytes,mime),mime:'image/png'};
  return {data:bytes,mime};
}
export async function decodedImage(data:Uint8Array){const preview=await imagePreview(data,true);return validateImage(nativeImage.createFromBuffer(preview.data));}
export async function imageInfo(data:Uint8Array){return (await decodedImage(data)).getSize();}
