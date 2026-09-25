import fs from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

// Resolution-independent distance fields keep the three-line brand mark crisp
// from the Windows tray to the launcher. Colour and lighting share one design.
const SS=4;                                   // supersampling for anti-aliasing
const SIZES=[16,24,32,48,64,128,256];
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*clamp(t,0,1));
const TOP=[34,166,191],BOTTOM=[61,70,183],MARK=[241,250,255];

/** Signed distance to a rounded rectangle; negative inside. */
function sdf(x,y,x0,y0,x1,y1,r){
  const cx=(x0+x1)/2,cy=(y0+y1)/2;
  const hx=Math.max((x1-x0)/2-r,0),hy=Math.max((y1-y0)/2-r,0);
  const qx=Math.abs(x-cx)-hx,qy=Math.abs(y-cy)-hy;
  return Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r;
}

/** Paint one supersampled pixel; the buffer keeps premultiplied colour. */
function over(buf,i,rgb,alpha){
  if(alpha<=0)return;
  const a=clamp(alpha,0,1),keep=1-a;
  buf[i]=buf[i]*keep+rgb[0]*a;buf[i+1]=buf[i+1]*keep+rgb[1]*a;
  buf[i+2]=buf[i+2]*keep+rgb[2]*a;buf[i+3]=buf[i+3]*keep+a;
}

function render(size){
  const S=size*SS,buf=new Float32Array(S*S*4);
  // Snap the mark at small sizes; the larger tile keeps soft, continuous curves.
  const u=v=>Math.round(v*size/256)*SS,bar=(top,right)=>{
    const y0=u(top),y1=Math.max(u(top+17),y0+SS);
    return {x0:u(58),y0,x1:Math.max(u(right),u(58)+SS),y1};
  };
  const scale=S/256;
  const tile={x0:10*scale,y0:8*scale,x1:246*scale,y1:244*scale,r:52*scale};
  // Match the window's AlignLeft mark: top / middle / bottom = 18 / 12 / 14.
  const bars=[18,12,14].map((length,i)=>bar(68+i*51,58+140*length/18));
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){
    const px=x+.5,py=y+.5,i=(y*S+x)*4;
    const d=sdf(px,py,tile.x0,tile.y0,tile.x1,tile.y1,tile.r);
    const shadow=sdf(px,py-4*scale,tile.x0,tile.y0,tile.x1,tile.y1,tile.r);
    over(buf,i,[17,30,74],Math.exp(-Math.max(0,shadow)/(2.5*scale))*.22);
    const cover=clamp(.5-d,0,1);
    if(cover<=0)continue;
    const nx=px/S,ny=py/S;
    let color=mix(TOP,BOTTOM,ny*.72+nx*.28);
    const glow=Math.exp(-((nx-.22)**2+(ny-.12)**2)/.12);
    color=mix(color,[101,229,223],glow*.38);
    color=mix(color,[39,44,129],Math.max(0,ny-.55)*.28);
    over(buf,i,color,cover);
    // A restrained top rim gives the tile an edge on both light and dark desktops.
    const rim=clamp(1+d/(1.1*scale),0,1)*cover;
    over(buf,i,[200,252,255],rim*(.12+.26*(1-ny)));
    for(const line of bars){
      const r=(line.y1-line.y0)/2;
      const cast=sdf(px,py-2*scale,line.x0,line.y0,line.x1,line.y1,r);
      over(buf,i,[15,42,109],clamp(1-cast/(2*scale),0,1)*cover*.2);
      const stroke=clamp(.5-sdf(px,py,line.x0,line.y0,line.x1,line.y1,r),0,1)*cover;
      over(buf,i,mix([255,255,255],MARK,ny),stroke);
    }
  }
  const out=Buffer.alloc(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let r=0,g=0,b=0,a=0;
    for(let sy=0;sy<SS;sy++)for(let sx=0;sx<SS;sx++){
      const i=(((y*SS+sy)*S)+x*SS+sx)*4;r+=buf[i];g+=buf[i+1];b+=buf[i+2];a+=buf[i+3];
    }
    const n=SS*SS,alpha=a/n,o=(y*size+x)*4;
    out[o]=alpha>0?clamp(Math.round(r/n/alpha),0,255):0;
    out[o+1]=alpha>0?clamp(Math.round(g/n/alpha),0,255):0;
    out[o+2]=alpha>0?clamp(Math.round(b/n/alpha),0,255):0;
    out[o+3]=clamp(Math.round(alpha*255),0,255);
  }
  return out;
}

const table=Array.from({length:256},(_,i)=>{let n=i;for(let j=0;j<8;j++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function chunk(name,data){
  const type=Buffer.from(name);let crc=0xffffffff;
  for(const byte of Buffer.concat([type,data]))crc=table[(crc^byte)&255]^(crc>>>8);
  const header=Buffer.alloc(4),end=Buffer.alloc(4);
  header.writeUInt32BE(data.length);end.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([header,type,data,end]);
}
function png(rgba,size){
  const raw=Buffer.alloc((size*4+1)*size);
  for(let y=0;y<size;y++)rgba.copy(raw,y*(size*4+1)+1,y*size*4,(y+1)*size*4);
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
/** Windows reads small entries fastest as a bottom-up 32-bit DIB. */
function dib(rgba,size){
  const stride=Math.ceil(size/32)*4,header=Buffer.alloc(40),pixels=Buffer.alloc(size*size*4),mask=Buffer.alloc(stride*size);
  header.writeUInt32LE(40,0);header.writeInt32LE(size,4);header.writeInt32LE(size*2,8);
  header.writeUInt16LE(1,12);header.writeUInt16LE(32,14);header.writeUInt32LE(pixels.length,20);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const from=((size-1-y)*size+x)*4,to=(y*size+x)*4;
    pixels[to]=rgba[from+2];pixels[to+1]=rgba[from+1];pixels[to+2]=rgba[from];pixels[to+3]=rgba[from+3];
  }
  return Buffer.concat([header,pixels,mask]);
}

const images=SIZES.map(size=>{const rgba=render(size);return {size,rgba,data:size===256?png(rgba,size):dib(rgba,size)};});
const header=Buffer.alloc(6+images.length*16);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);
let offset=header.length;
images.forEach((image,i)=>{
  const at=6+i*16;
  header[at]=image.size===256?0:image.size;header[at+1]=image.size===256?0:image.size;
  header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);
  header.writeUInt32LE(image.data.length,at+8);header.writeUInt32LE(offset,at+12);
  offset+=image.data.length;
});
await fs.mkdir('resources',{recursive:true});
await fs.writeFile('resources/icon.png',png(images.at(-1).rgba,256));
await fs.writeFile('resources/icon.ico',Buffer.concat([header,...images.map(i=>i.data)]));
console.log('icon.ico',SIZES.join('/'),offset,'bytes');
