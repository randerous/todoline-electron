import { app,clipboard } from 'electron';
import {decodedImage} from './image-codec';
import { spawn,execFile } from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {clipboardFilePaths,clipboardImageFiles} from './clipboard-files';
import { clipboardPacket,htmlClipboard,readHtmlClipboard,bitmapClipboard,type ClipboardEntry } from './clipboard-format';
type Payload={text:string;html?:string;externalHtml?:string;events?:string;image?:Uint8Array};
let pending=Promise.resolve();
// Electron's own clipboard can write text/HTML/images on every platform, but on
// macOS clipboard.writeBuffer() clears the pasteboard, so the structural event
// payload cannot live in a second custom format next to the standard ones.
// Carry it inside the HTML instead: external applications ignore the comment,
// while the app itself recovers the exact event structure when pasting.
const EVENTS_MARKER=/<!--todoline-events:([A-Za-z0-9+/=]*)-->/;
function embedEvents(html:string,events:string){return `<!--todoline-events:${Buffer.from(events,'utf8').toString('base64')}-->${html}`;}
function extractEvents(html:string){const match=EVENTS_MARKER.exec(html);if(!match)return '';try{return Buffer.from(match[1],'base64').toString('utf8');}catch{return '';}}
function stripEvents(html:string){return html.replace(EVENTS_MARKER,'');}
function clipboardExecutable(){return app.isPackaged?path.join(process.resourcesPath,'app.asar.unpacked','out','main','clipboard-win.exe'):path.join(__dirname,'clipboard-win.exe');}
export async function readClipboard(){
  await pending;
  const img=clipboard.readImage();
  const text=clipboard.readText(),richText=clipboard.has('application/x-tde-richtext')||clipboard.has('application/x-todoline-html'),events=clipboard.readBuffer('application/x-tde-events').toString('utf8');
  if(!events&&img.isEmpty()&&process.platform==='win32'&&clipboard.availableFormats().includes('text/uri-list')){
    const packet=await new Promise<Buffer>((resolve,reject)=>execFile(clipboardExecutable(),['--read-files'],{windowsHide:true,timeout:10000,maxBuffer:2*1024*1024,encoding:'buffer'},(error,stdout)=>error?reject(new Error('无法读取文件剪贴板，请重新复制后重试。')):resolve(stdout)));
    const files=clipboardFilePaths(packet);
    if(files.length){const images=await clipboardImageFiles(files);return {text:images?'':text||files.map(file=>pathToFileURL(file).href).join('\n'),html:'',events:'',images};}
  }
  // Qt can put a complete HTML document inside CF_HTML's fragment markers.
  // Chromium returns an empty string for that layout; use validated byte offsets.
  const rawHtml=clipboard.readBuffer('application/x-todoline-html').toString('utf8')||clipboard.readHTML()||(!events&&img.isEmpty()&&(richText||!text)?readHtmlClipboard(clipboard.readBuffer('HTML Format')):'');
  const embedded=events?'':extractEvents(rawHtml);
  const html=embedded?stripEvents(rawHtml):rawHtml;
  return {text,html,events:events||embedded,richText:richText||!!embedded,image:img.isEmpty()?undefined:new Uint8Array(img.toPNG())};
}
function escapeText(value:string){return value.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));}
/** Portable clipboard writer: standard text/HTML/image through Electron itself. */
async function writePortableClipboard(data:Payload){
  const image=data.image?await decodedImage(data.image):undefined;
  const base=data.externalHtml??data.html??(data.text?`<p>${escapeText(data.text)}</p>`:'');
  const html=data.events&&!image?embedEvents(base,data.events):base;
  clipboard.write({text:data.text,html,...(image?{image}:{})});
  if(clipboard.readText()!==data.text)throw new Error('剪贴板在写入后发生变化，请重试复制。');
  if(image&&clipboard.readImage().isEmpty())throw new Error('剪贴板在写入后发生变化，请重试复制。');
  if(data.events&&!image&&extractEvents(clipboard.readHTML())!==data.events)throw new Error('剪贴板在写入后发生变化，请重试复制。');
}
export function writeClipboard(data:Payload){
  const operation=pending.catch(()=>{}).then(async()=>{
    if(process.platform!=='win32')return writePortableClipboard(data);
    const entries:ClipboardEntry[]=[{name:'CF_UNICODETEXT',data:Buffer.from(data.text+'\0','utf16le')}];
    if(data.html)entries.push({name:'application/x-todoline-html',data:Buffer.from(data.html,'utf8')});
    if(data.externalHtml)entries.push({name:'HTML Format',data:htmlClipboard(data.externalHtml)});
    if(data.events)entries.push({name:'application/x-tde-events',data:Buffer.from(data.events,'utf8')});
    if(data.image){const image=await decodedImage(data.image);const size=image.getSize();entries.push({name:'PNG',data:image.toPNG()},{name:'CF_DIBV5',data:bitmapClipboard(size.width,size.height,image.toBitmap())});}
    const packet=clipboardPacket(entries),executable=clipboardExecutable();
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','ignore','ignore']});
      const timeout=setTimeout(()=>{child.kill();reject(new Error('剪贴板写入超时'));},10000);
      child.once('error',error=>{clearTimeout(timeout);reject(error);});
      child.once('exit',code=>{clearTimeout(timeout);if(code===0)resolve();else reject(new Error(code===3?'剪贴板正被其他程序使用，请重试复制。':`剪贴板写入失败（${code}）。`));});
      child.stdin.on('error',()=>{});child.stdin.end(packet);
    });
    // A successful copy must leave both standard and Qt formats available.
    if(clipboard.readText()!==data.text||(data.events&&clipboard.readBuffer('application/x-tde-events').toString('utf8')!==data.events))throw new Error('剪贴板在写入后发生变化，请重试复制。');
  });
  pending=operation;
  void operation.finally(()=>{if(pending===operation)pending=Promise.resolve();}).catch(()=>{});
  return operation;
}
