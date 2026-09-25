import {expect,it} from 'vitest';
import {rasterDimensions,checkImageSize,type BrowserImageMime} from '../src/shared/raster-image';
import samples from './fixtures/browser-images.json';
const images=samples.map(f=>({...f,buffer:Buffer.from(f.data,'base64'),mime:(f.name.endsWith('.gif')?'image/gif':'image/webp') as BrowserImageMime}));
it.each(images)('reads all bounded frame headers in $name',f=>expect(rasterDimensions(f.buffer,f.mime)).toEqual({width:f.width,height:f.height}));
it.each(images)('rejects truncation in $name before decoding',f=>expect(()=>rasterDimensions(f.buffer.subarray(0,f.buffer.length-10),f.mime)).toThrow('无法读取图片'));
it.each([[0,10],[1,32769],[10000,10000],[-1,24],[1.5,3]])('rejects invalid or excessive pixel sizes %i × %i',(w,h)=>expect(()=>checkImageSize(w,h)).toThrow('图片像素尺寸超出限制'));
it('checks both GIF canvas and image descriptors before decoding',()=>{
  const source=images[0].buffer,canvas=Buffer.from(source);canvas.writeUInt16LE(32769,6);expect(()=>rasterDimensions(canvas,'image/gif')).toThrow('图片像素尺寸超出限制');
  const frame=Buffer.from(source),offset=13+(frame[10]&128?3*2**((frame[10]&7)+1):0);expect(frame[offset]).toBe(0x2c);frame.writeUInt16LE(32769,offset+5);expect(()=>rasterDimensions(frame,'image/gif')).toThrow('图片像素尺寸超出限制');
});
it('checks extended WebP canvas sizes before decoding',()=>{const f=Buffer.from(images[5].buffer);expect(f.subarray(12,16).toString()).toBe('VP8X');f.writeUIntLE(32768,24,3);expect(()=>rasterDimensions(f,'image/webp')).toThrow('图片像素尺寸超出限制');});
it('checks animation frame dimensions even when the canvas is small',()=>{const f=Buffer.from(images[5].buffer),offset=f.indexOf('ANMF');expect(offset).toBeGreaterThan(0);f.writeUIntLE(32768,offset+8+6,3);expect(()=>rasterDimensions(f,'image/webp')).toThrow('图片像素尺寸超出限制');});
it('rejects an incomplete RIFF header and a zero-sized GIF without allocating',()=>{expect(()=>rasterDimensions(Buffer.from('RIFF'),'image/webp')).toThrow('无法读取图片');const f=Buffer.from(images[0].buffer);f.writeUInt16LE(0,6);expect(()=>rasterDimensions(f,'image/gif')).toThrow('图片像素尺寸超出限制');});
it('accepts bounded unknown WebP metadata chunks',()=>{const base=images[3].buffer,extra=Buffer.from([88,77,80,32,2,0,0,0,65,66]),f=Buffer.concat([base,extra]);f.writeUInt32LE(f.length-8,4);expect(rasterDimensions(f,'image/webp')).toEqual({width:32,height:24});});
