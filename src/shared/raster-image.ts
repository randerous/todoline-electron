export type BrowserImageMime='image/gif'|'image/webp';
export interface RasterDecodeRequest {data:Uint8Array;mime:BrowserImageMime;}
export const imageInputLimit=100*1024*1024,imageOutputLimit=256*1024*1024;
export function checkImageSize(width:number,height:number){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>32768||height>32768||width*height>64000000)throw new Error('图片像素尺寸超出限制');
  return {width,height};
}
// Inspect container/frame dimensions before asking Chromium to allocate decoded pixels.
// The actual codec still validates the compressed bitstream independently.
export function rasterDimensions(data:Uint8Array,mime:BrowserImageMime){
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  const invalid=()=>{throw new Error('无法读取图片');};
  const need=(p:number,n:number,end=data.length)=>{if(p<0||p+n>end)invalid();};
  const tag=(p:number,n:number)=>{need(p,n);return String.fromCharCode(...data.subarray(p,p+n));};
  const u16=(p:number)=>{need(p,2);return view.getUint16(p,true);};
  const u24=(p:number)=>{need(p,3);return data[p]|data[p+1]<<8|data[p+2]<<16;};
  const u32=(p:number)=>{need(p,4);return view.getUint32(p,true);};
  if(mime==='image/gif'){
    need(0,13);if(!/^GIF8[79]a$/.test(tag(0,6)))invalid();const size=checkImageSize(u16(6),u16(8));
    let p=13,frames=0;if(data[10]&128)p+=3*(2**((data[10]&7)+1));need(p,0);
    const blocks=()=>{for(;;){need(p,1);const n=data[p++];if(!n)return;need(p,n);p+=n;}};
    for(;;){need(p,1);const kind=data[p++];if(kind===0x3b){if(!frames)invalid();return size;}
      if(kind===0x21){need(p,1);p++;blocks();continue;}
      if(kind!==0x2c)invalid();need(p,9);checkImageSize(u16(p+4),u16(p+6));const packed=data[p+8];p+=9;
      if(packed&128)p+=3*(2**((packed&7)+1));need(p,1);p++;blocks();frames++;
    }
  }
  need(0,12);if(tag(0,4)!=='RIFF'||tag(8,4)!=='WEBP')invalid();const end=u32(4)+8;need(0,end);
  let size:ReturnType<typeof checkImageSize>|undefined,frames=0;
  const chunks=(start:number,limit:number,nested=false)=>{
    for(let p=start;p<limit;){need(p,8,limit);const type=tag(p,4),length=u32(p+4),body=p+8,stop=body+length;need(body,length,limit);
      if(type==='VP8X'){if(nested)invalid();need(body,10,stop);size=checkImageSize(u24(body+4)+1,u24(body+7)+1);}
      else if(type==='VP8 '){need(body,10,stop);if(tag(body+3,3)!=='\x9d\x01\x2a')invalid();const dimensions=checkImageSize(u16(body+6)&0x3fff,u16(body+8)&0x3fff);size??=dimensions;frames++;}
      else if(type==='VP8L'){need(body,5,stop);if(data[body]!==0x2f)invalid();const bits=u32(body+1),dimensions=checkImageSize((bits&0x3fff)+1,((bits>>>14)&0x3fff)+1);size??=dimensions;frames++;}
      else if(type==='ANMF'){if(nested)invalid();need(body,16,stop);checkImageSize(u24(body+6)+1,u24(body+9)+1);chunks(body+16,stop,true);}
      p=stop+(length&1);need(p,0,limit);
    }
  };
  chunks(12,end);if(!size||!frames)invalid();return size!;
}
