export interface ClipboardEntry { name:string; data:Buffer }
export function readHtmlClipboard(bytes:Buffer):string{
  if(!bytes.length)return '';
  const invalid=()=>new Error('剪贴板 HTML 字节范围无效，未插入内容。');
  if(bytes.length>160*1024*1024)throw new Error('剪贴板 HTML 过大，请分批复制。');
  const header=bytes.subarray(0,4096).toString('ascii');
  let headerEnd=0;
  const field=(key:string)=>{const value=new RegExp('(?:^|[\\r\\n])'+key+':[ \\t]*(-?\\d+)[ \\t]*(?=[\\r\\n]|$)').exec(header);if(!value)throw invalid();headerEnd=Math.max(headerEnd,value.index+value[0].length);return Number(value[1]);};
  const start=field('StartHTML'),end=field('EndHTML'),from=field('StartFragment'),to=field('EndFragment');
  if(![start,end,from,to].every(Number.isSafeInteger)||from<headerEnd||to<from||to>bytes.length||start!==-1&&(start<headerEnd||start>from)||end!==-1&&(end<to||end>bytes.length)||start===-1&&end!==-1||end===-1&&start!==-1)throw invalid();
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(from,to));}catch{throw invalid();}
}
export function htmlClipboard(fragment:string):Buffer{
  const prefix='<html><body><!--StartFragment-->',suffix='<!--EndFragment--></body></html>';
  const header=(a:number,b:number,c:number,d:number)=>`Version:1.0\r\nStartHTML:${String(a).padStart(10,'0')}\r\nEndHTML:${String(b).padStart(10,'0')}\r\nStartFragment:${String(c).padStart(10,'0')}\r\nEndFragment:${String(d).padStart(10,'0')}\r\n`;
  const start=Buffer.byteLength(header(0,0,0,0)),from=start+Buffer.byteLength(prefix),to=from+Buffer.byteLength(fragment),end=to+Buffer.byteLength(suffix);
  return Buffer.from(header(start,end,from,to)+prefix+fragment+suffix+'\0','utf8');
}
export function bitmapClipboard(width:number,height:number,bitmap:Buffer):Buffer{
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||width*height*4!==bitmap.length)throw new Error('无效图片尺寸');
  const header=Buffer.alloc(124);header.writeUInt32LE(124,0);header.writeInt32LE(width,4);header.writeInt32LE(-height,8);header.writeUInt16LE(1,12);header.writeUInt16LE(32,14);header.writeUInt32LE(3,16);header.writeUInt32LE(bitmap.length,20);
  [0x00ff0000,0x0000ff00,0x000000ff,0xff000000].forEach((mask,i)=>header.writeUInt32LE(mask,40+i*4));header.writeUInt32LE(0x73524742,56);header.writeUInt32LE(4,108);
  return Buffer.concat([header,bitmap]);
}
export function clipboardPacket(entries:ClipboardEntry[]):Buffer{
  if(!entries.length||entries.length>8)throw new Error('无效剪贴板格式');
  const head=Buffer.alloc(8);head.writeUInt32LE(0x50434c54);head.writeUInt32LE(entries.length,4);
  const chunks:Buffer[]=[head];let total=0;
  for(const entry of entries){const name=Buffer.from(entry.name,'ascii');total+=entry.data.length;if(name.length>127||!entry.data.length||total>512*1024*1024)throw new Error('剪贴板内容过大');const sizes=Buffer.alloc(8);sizes.writeUInt32LE(name.length);sizes.writeUInt32LE(entry.data.length,4);chunks.push(sizes,name,entry.data);}
  return Buffer.concat(chunks);
}
