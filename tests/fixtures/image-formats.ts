import encoded from './image-formats.json';
// Synthetic, uniform colors. JSON contains Pillow-generated LZW TIFF, BMP and multi-size ICO.
export function rawTiff(width=32,height=24,bigEndian=true){
  const count=11,bits=8+2+count*12+4,pixels=bits+8,b=Buffer.alloc(pixels+(width*height<=768?width*height*4:0));
  const u16=(n:number,p:number)=>bigEndian?b.writeUInt16BE(n,p):b.writeUInt16LE(n,p);
  const u32=(n:number,p:number)=>bigEndian?b.writeUInt32BE(n,p):b.writeUInt32LE(n,p);
  b.write(bigEndian?'MM':'II');u16(42,2);u32(8,4);u16(count,8);
  const entries=[[256,4,1,width],[257,4,1,height],[258,3,4,bits],[259,3,1,1],[262,3,1,2],[273,4,1,pixels],[277,3,1,4],[278,4,1,height],[279,4,1,width*height*4],[284,3,1,1],[338,3,1,2]];
  entries.forEach(([tag,type,n,value],i)=>{const p=10+i*12;u16(tag,p);u16(type,p+2);u32(n,p+4);if(type===3&&n===1)u16(value,p+8);else u32(value,p+8);});
  for(let i=0;i<4;i++)u16(8,bits+i*2);
  for(let p=pixels;p<b.length;p+=4)b.set([180,80,30,255],p);
  return b;
}
export const imageFixtures=[...encoded.map(f=>({...f,width:f.name.endsWith('.ico')?16:f.width,height:f.name.endsWith('.ico')?16:f.height,buffer:Buffer.from(f.data,'base64')})),{name:'大端.tiff',width:32,height:24,buffer:rawTiff()}];
