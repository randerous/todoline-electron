import { contextBridge,ipcRenderer } from 'electron';
import type { ReminderAPI } from '../shared/types';
const api:ReminderAPI={
  ready:()=>ipcRenderer.invoke('tl:reminder:ready'),
  action:(id,action,snoozeText)=>ipcRenderer.invoke('tl:reminder:action',id,action,snoozeText),
  pause:value=>ipcRenderer.invoke('tl:reminder:pause',value),
  onState:callback=>{const listener=(_event:unknown,state:any)=>callback(state);ipcRenderer.on('tl:reminder:state',listener);return()=>ipcRenderer.removeListener('tl:reminder:state',listener);},
};
contextBridge.exposeInMainWorld('reminder',api);
