import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopAPI } from '../shared/types';
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(`tl:${channel}`, ...args);
const listen = (name: string, fn: (...args: any[]) => void) => {
  const handler = (_event: unknown, value: unknown) => fn(value);
  ipcRenderer.on(`tl:${name}`, handler);
  return () => ipcRenderer.removeListener(`tl:${name}`, handler);
};
const api: DesktopAPI = {
  chooseNewFileDirectory:()=>invoke('chooseNewFileDirectory'),onRecentChanged:callback=>listen('recentChanged',callback),
  restoreSession:()=>invoke('restoreSession'),
  open: () => invoke('open'), openRecent: path => invoke('openRecent', path), create: () => invoke('create'),
  openDroppedFiles: files => invoke('openDroppedFiles',files.map(file=>webUtils.getPathForFile(file)).filter(Boolean)),
  renameFormat:request=>invoke('renameFormat',request),
  markdown: {
    create: source => invoke('mdCreate',source), save: request => invoke('mdSave',request),
    saveAs: request => invoke('mdSaveAs',request), reload: request => invoke('mdReload',request),
    rename: (handle,name) => invoke('mdRename',handle,name), addAsset: (handle,data,name) => invoke('mdAddAsset',handle,data,name),
    readAsset: (handle,reference) => invoke('mdReadAsset',handle,reference),
  },
  reload: request => invoke('reload', request), revealRecovery: handle => invoke('revealRecovery',handle), save: request => invoke('save', request),
  saveAs: request => invoke('saveAs', request), close: (handle, rememberRecent) => invoke('close', handle, rememberRecent),
  search: (handle, query) => invoke('search', handle, query), asset: (handle,id) => invoke('asset',handle,id),
  addAsset: (handle,data,w,h) => invoke('addAsset',handle,data,w,h),
  addAssets:(handle,assets)=>invoke('addAssets',handle,assets),
  imageInfo:data=>invoke('imageInfo',data),
  assetPreview:(handle,id)=>invoke('assetPreview',handle,id),
  exportFile: (handle,format,html,text) => invoke('export',handle,format,html,text),
  revealExport: () => invoke('revealExport'),
  saveDiagnostics: text => invoke('saveDiagnostics', text),
  reveal: handle => invoke('reveal',handle), revealRecent: file => invoke('revealRecent',file), rename: (handle,name) => invoke('rename',handle,name),
  openLink: url => invoke('openLink',url), copy: data => invoke('copy',data), readClipboard: () => invoke('readClipboard'),
  session: () => invoke('session'), updateSession: data => invoke('updateSession',data),
  ready: () => invoke('ready'), onOpened: fn => listen('opened',fn), onError: fn => listen('error',fn),
  showSearch:()=>invoke('showSearch'),
  onSearchFocus:fn=>listen('searchFocus',fn),
  onTheme: fn => listen('theme',fn),
  onWindowInactive: fn => listen('windowInactive',fn),
  minimize: () => { void invoke('window','minimize'); }, maximize: () => { void invoke('window','maximize'); },
  requestClose: () => { void invoke('window','close'); }, confirmClose: ok => { void invoke('confirmClose',ok); },
  onClose: fn => listen('close',fn), onCommand: fn => listen('command',fn), onNotices: fn => listen('notices',fn),
  showReminders:()=>invoke('showReminders'),onReminderEdit:fn=>listen('reminderEdit',fn),reminderEdited:(id,error)=>invoke('reminderEdited',id,error),
  onReveal: fn => listen('reveal',fn), snooze: key => invoke('snooze',key),
  snoozedEvents: handle => invoke('snoozedEvents',handle),
};
contextBridge.exposeInMainWorld('desktop',api);
