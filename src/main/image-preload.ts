import {ipcRenderer} from 'electron';
import {checkImageSize,imageInputLimit,imageOutputLimit,type RasterDecodeRequest} from '../shared/raster-image';

// This isolated preload has no API exposed to the page and accepts one bounded raster job.
ipcRenderer.once('tl:image:decode',async(_event,request:RasterDecodeRequest)=>{
  let bitmap:ImageBitmap|undefined;
  try{
    if(!(request.data instanceof Uint8Array)||request.data.length>imageInputLimit||!['image/gif','image/webp'].includes(request.mime))throw new Error('无效图片');
    bitmap=await createImageBitmap(new Blob([request.data as BlobPart],{type:request.mime}));
    const {width,height}=checkImageSize(bitmap.width,bitmap.height),canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)throw new Error('无法读取图片');context.drawImage(bitmap,0,0);
    const png=await canvas.convertToBlob({type:'image/png'});if(png.size>imageOutputLimit)throw new Error('图片像素尺寸超出限制');
    ipcRenderer.send('tl:image:decoded',{data:new Uint8Array(await png.arrayBuffer())});
  }catch(error){ipcRenderer.send('tl:image:decoded',{error:String(error)});}
  finally{bitmap?.close();}
});
