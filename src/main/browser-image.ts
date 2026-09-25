import {BrowserWindow,ipcMain,type IpcMainEvent} from 'electron';
import path from 'node:path';
import {imageInputLimit,imageOutputLimit,rasterDimensions,type BrowserImageMime} from '../shared/raster-image';
const active=new Set<BrowserWindow>();
let disposed=false;
export function disposeImageDecoders(){disposed=true;for(const win of active)if(!win.isDestroyed())win.destroy();}
export function decodeBrowserImage(data:Buffer,mime:BrowserImageMime):Promise<Buffer>{
  if(disposed)return Promise.reject(new Error('图片解码已取消'));
  if(!data.length||data.length>imageInputLimit)throw new Error('图片大小超出限制');
  rasterDimensions(data,mime);
  return new Promise((resolve,reject)=>{
    const win=new BrowserWindow({width:64,height:64,show:false,focusable:false,skipTaskbar:true,title:'TodoLine 图片解码',webPreferences:{preload:path.join(__dirname,'image-preload.cjs'),partition:'todoline-image-decoder',sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    active.add(win);let settled=false;
    const finish=(error?:Error,result?:Buffer)=>{if(settled)return;settled=true;clearTimeout(timer);ipcMain.removeListener('tl:image:decoded',response);active.delete(win);if(!win.isDestroyed())win.destroy();if(error)reject(error);else resolve(result!);};
    const response=(event:IpcMainEvent,value:{data?:Uint8Array;error?:string})=>{
      if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)return;
      if(value?.error){finish(new Error(value.error));return;}
      if(!(value?.data instanceof Uint8Array)||!value.data.length||value.data.length>imageOutputLimit){finish(new Error('无效图片预览'));return;}
      finish(undefined,Buffer.from(value.data));
    };
    const timer=setTimeout(()=>finish(new Error('图片解码超时')),30000);
    ipcMain.on('tl:image:decoded',response);
    win.once('closed',()=>finish(new Error('图片解码已取消')));
    win.webContents.once('render-process-gone',()=>finish(new Error('图片解码进程意外退出，请重试')));
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));win.webContents.session.setPermissionCheckHandler(()=>false);
    void win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>TodoLine 图片解码</title>')).then(()=>{if(!settled)win.webContents.send('tl:image:decode',{data:new Uint8Array(data),mime});}).catch(error=>finish(error));
  });
}
