import {installSearchWindow} from './search-window';
import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, protocol, Menu, Tray, powerMonitor, screen, nativeTheme } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseClient } from './rpc';
import { SessionStore } from './session';
import { ReminderSchedule,reminderTime } from './reminders';
import { RecoveryJournal } from './recovery';
import { launchRequest } from './launch';
import { fitWindow } from './window-state';
import { writeClipboard,readClipboard } from './clipboard';
import {imageInfo,imagePreview} from './image-codec';
import {disposeImageDecoders} from './browser-image';
import { ReminderWindow } from './reminder-window';
import { documentFileName } from '../shared/file-name';
import {documentDate} from '../shared/new-document';
import {fileIdentity} from './file-identity';
import type { DocumentSnapshot, SaveRequest, SaveResult, AssetRecord, SessionData, Notice } from '../shared/types';
import {isMarkdownPath,isDocumentPath,isTdePath,type TextFileSnapshot,type MarkdownSaveRequest,type NativeDocumentSnapshot} from '../shared/native-document';
import type {MarkdownStore} from './markdown-store';

protocol.registerSchemesAsPrivileged(['tde-asset','md-asset'].map(scheme=>({scheme,privileges:{standard:true,secure:true,supportFetchAPI:true}})));
const testing=process.env.TODOLINE_TEST==='1';
if(process.env.TODOLINE_DATA_DIR) app.setPath('userData',process.env.TODOLINE_DATA_DIR);
else app.setPath('userData',path.join(app.getPath('appData'),'TodoLine-Electron'));
let showSearch=()=>{};
let window:BrowserWindow, db:DatabaseClient, session:SessionStore, tray:Tray|undefined;
let closing=false, quitting=false;
const initialRequest=launchRequest(process.argv,process.cwd(),!!process.defaultApp);
const pendingFiles=[...initialRequest.files];
let rendererReady=false,openingFiles=false;
// The renderer asks to reveal what it just exported; the path stays here.
let lastExport='';
let journal:RecoveryJournal;
const recoveryConflicts=new Set<string>();
const docs=new Map<string,DocumentSnapshot>();
let markdown:MarkdownStore|undefined,markdownLoading:Promise<MarkdownStore>|undefined;
function markdownStore(){return markdownLoading??=import('./markdown-store').then(({MarkdownStore})=>markdown=new MarkdownStore(path.join(app.getPath('userData'),'recovery','markdown')));}
function rememberMarkdown(doc:TextFileSnapshot,remember=true){try{if(remember)session.recent(doc.path);}catch{doc.warning='文档已打开，最近文件记录暂未保存。';}return doc;}
async function newDocumentPath(extension:'md'|'tde'){
  const configured=session.data.settings.newFileDirectory;
  const root=configured||path.join(app.getPath('userData'),'drafts');await fs.mkdir(root,{recursive:true});
  const directory=configured?root:await fs.mkdtemp(path.join(root,'draft-'));
  for(;;){
    const date=documentDate(),serial=session.data.newFileSequence?.date===date?session.data.newFileSequence.next:0;
    session.update({newFileSequence:{date,next:serial+1}});
    const file=path.join(directory,`${date}_${serial}.${extension}`);
    const occupied=await Promise.all(['tde','md','markdown'].map(ext=>fs.lstat(path.join(directory,`${date}_${serial}.${ext}`)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;})));
    if(!occupied.some(Boolean))return file;
  }
}
async function trackNewDocument(doc:NativeDocumentSnapshot){
  session.update({autoNamedDocuments:[...(session.data.autoNamedDocuments??[]),{path:doc.path,identity:fileIdentity(await fs.stat(doc.path))}]});
}
function keepNamedDocument(file:string){session.update({autoNamedDocuments:(session.data.autoNamedDocuments??[]).filter(d=>d.path.toLowerCase()!==file.toLowerCase())});}
function forgetEmptyDocument(file:string){
  const activePath=session.data.tabs[session.data.active]?.path;
  const tabs=session.data.tabs.filter(t=>t.path.toLowerCase()!==file.toLowerCase());
  session.update({tabs,active:Math.max(0,tabs.findIndex(t=>t.path===activePath)),recent:session.data.recent.filter(p=>p.toLowerCase()!==file.toLowerCase()),autoNamedDocuments:(session.data.autoNamedDocuments??[]).filter(d=>d.path.toLowerCase()!==file.toLowerCase())});
}
async function closeDocument(handle:string,rememberRecent=false){
  const doc=getAnyDoc(handle),md=markdown?.has(handle),tracked=session.data.autoNamedDocuments?.find(d=>d.path.toLowerCase()===doc.path.toLowerCase());
  let removed=false;
  if(tracked&&!doc.readOnly&&!doc.recovered&&!recoveryConflicts.has(handle))try{
    removed=md?await markdown!.discardEmpty(handle,tracked.identity):await db.call<boolean>('discardEmpty',handle,tracked.identity);
  }catch(error){send('error','空白文档未清理，已保留文件：'+errorMessage(error));}
  if(!removed){if(md)await markdown!.close(handle);else await db.call('close',handle);}
  docs.delete(handle);recoveryConflicts.delete(handle);
  if(removed){forgetEmptyDocument(doc.path);await journal.clear(doc.path).catch(()=>{});reminders.forgetDocument(doc.path);}
  // Only an explicit tab close is a recent visit; internal handle cleanup is not.
  if(!removed&&rememberRecent===true)try{session.recent(doc.path);}catch(error){send('error','文档已关闭，但最近文件记录未保存：'+errorMessage(error));}
  void checkReminders();
}
async function openFile(file:string,remember=true):Promise<NativeDocumentSnapshot>{
  if(!isTdePath(file)){const relative=path.relative(path.join(app.getPath('userData'),'drafts'),path.resolve(file));const draft=!!relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);return rememberMarkdown(await (await markdownStore()).open(file,draft),remember);}
  if(!isDocumentPath(file))throw new Error('请选择有效文件。');
  const doc=await db.call<DocumentSnapshot>('open',file);
  return docs.has(doc.handle)?snapshot(getDoc(doc.handle),remember):opened(doc,remember);
}
function getAnyDoc(handle:string){return markdown?.has(handle)?markdown.snapshot(handle):getDoc(handle);}
const relocating=new Set<string>();
const reminderDocuments=()=>[...docs.values()].filter(d=>!relocating.has(d.handle));
async function duringRelocation<T>(handle:string,operation:()=>Promise<T>){
  getAnyDoc(handle);if(relocating.has(handle))throw new Error('该文件正在处理，请稍后重试。');
  relocating.add(handle);void checkReminders();
  try{return await operation();}finally{relocating.delete(handle);void checkReminders();}
}
let reminders:ReminderSchedule,reminderWindow:ReminderWindow|undefined;
let reminderError='',checkingReminders=false,reminderAgain=false,reminderMutations=0;
const reminderCompletions=new Map<string,(error?:string)=>void>();
const htmlEscape=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function snapshot(d:DocumentSnapshot,remember=true) {
  docs.set(d.handle,d);
  try{if(remember)session.recent(d.path);}catch(error){d.warning=[d.warning,'文档已打开，但最近文件记录未保存：'+errorMessage(error)].filter(Boolean).join('\n');}
  return d;
}
async function opened(d:DocumentSnapshot,remember=true){snapshot(d,remember);const recovered=await journal.recover(d);if(!recovered)return d;if(recovered.conflict)recoveryConflicts.add(d.handle);return {...d,events:recovered.events,recovered:true,warning:recovered.conflict?'已恢复上次未保存的内容；磁盘版本也有变化，请另存为。':'已恢复上次未确认保存的内容，请检查后重试保存。'};}
function getDoc(handle:string) { const d=docs.get(handle); if(!d) throw new Error('文件已关闭，请重新打开。'); return d; }
function validateSave(r:SaveRequest) {
  getDoc(r.handle); if(!Number.isInteger(r.revision)||!Array.isArray(r.events)||!r.events.length) throw new Error('无效文档请求');
  for(const e of r.events) if(!Number.isSafeInteger(e.id)||typeof e.content_html!=='string'||typeof e.content_text!=='string'||!Number.isFinite(e.created_at)) throw new Error('无效事件数据');
}
const send=(channel:string,value?:unknown)=>{ if(!window.isDestroyed()) window.webContents.send(`tl:${channel}`,value); };
function command(c:string) { window.show(); send('command',c); }
function errorMessage(error:unknown) { return error instanceof Error?error.message:String(error); }
function showWindow(){if(!window||window.isDestroyed())return;if(window.isMinimized())window.restore();window.show();window.focus();}
async function openPendingFiles(){
  if(!rendererReady||openingFiles||quitting)return;openingFiles=true;
  try{while(pendingFiles.length&&!quitting){
    const file=pendingFiles.shift()!;
    try{
      send('opened',await openFile(file));
    }catch(error){send('error',`无法打开 ${file}：${errorMessage(error)}`);}
  }}finally{openingFiles=false;}
}
function traySetup() {
  const icon=nativeImage.createFromPath(path.join(__dirname,'../../resources/icon.png'));
  tray=new Tray(icon.resize({width:16,height:16,quality:'best'}));
  tray.setToolTip('TodoLine · 待办线'); tray.on('double-click',()=>window.show());
  tray.on('balloon-click',()=>{showWindow();});
  tray.setContextMenu(Menu.buildFromTemplate([{label:'显示 TodoLine',click:()=>window.show()},{type:'separator'},{label:'退出',click:()=>{quitting=true;window.close();}}]));
}
function registerIPC() {
  const handle=(name:string,fn:(...args:any[])=>any)=>ipcMain.handle(`tl:${name}`,async(event,...args)=>{
    if(event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame) throw new Error('无效调用来源');
    return fn(...args);
  });
  handle('session',()=>({...session.data,defaultNewFileDirectory:path.join(app.getPath('userData'),'drafts'),warning:session.warning||undefined,systemDark:nativeTheme.shouldUseDarkColors}));
  handle('chooseNewFileDirectory',async()=>{
    const result=await dialog.showOpenDialog(window,{title:'新建文档自动保存目录',defaultPath:session.data.settings.newFileDirectory||app.getPath('documents'),properties:['openDirectory','createDirectory']});
    if(result.canceled||!result.filePaths[0])return null;
    const directory=path.resolve(result.filePaths[0]);await fs.access(directory,fs.constants.W_OK);
    session.update({settings:{...session.data.settings,newFileDirectory:directory}});return directory;
  });
  handle('ready',()=>{rendererReady=true;send('theme',nativeTheme.shouldUseDarkColors);if(reminders.warning)send('error',reminders.warning);if(quitting)window.close();else void openPendingFiles().finally(checkReminders);});
  handle('updateSession',(update:Partial<SessionData>)=>{
    if(update.settings) {
      if(!['dark','light','green','system'].includes(update.settings.theme)) throw new Error('无效主题');
      update.settings.fontSize=Math.max(10,Math.min(30,update.settings.fontSize));
    }
    session.update(update);
    void checkReminders();
  });
  handle('open',async()=>{
    const result=await dialog.showOpenDialog(window,{filters:[{name:'所有文件',extensions:['*']},{name:'TodoLine 与 Markdown 文档',extensions:['tde','md','markdown']},{name:'文本文件',extensions:['txt','log','cfg','conf','ini','json','yaml','yml','csv']}],properties:['openFile']});
    if(result.canceled) return null; return openFile(result.filePaths[0]);
  });
  // Restoring already-authorized tabs is not a new recent-file visit. Keep the
  // saved order and avoid two synchronous durable config writes per document.
  handle('restoreSession',()=>Promise.all(session.data.tabs.map(async tab=>{
    try{return {status:'fulfilled' as const,value:await openFile(tab.path,false)};}
    catch(error){return {status:'rejected' as const,reason:errorMessage(error)};}
  })));
  handle('openRecent',async(file:string)=>{
    if(!session.data.recent.includes(file)&&!session.data.tabs.some(t=>t.path===file)) throw new Error('该路径未由用户授权打开');
    return openFile(file);
  });
  handle('openDroppedFiles',async(files:string[])=>{
    if(!Array.isArray(files)||files.length>100||files.some(file=>typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0')))throw new Error('无效拖入文件。');
    const opened:NativeDocumentSnapshot[]=[];
    for(const file of [...new Set(files)].filter(isDocumentPath))try{opened.push(await openFile(file));}catch(error){send('error',`无法打开 ${file}：${errorMessage(error)}`);}
    return opened;
  });
  handle('mdCreate',async(source='')=>{
    if(typeof source!=='string')throw new Error('无效 Markdown 内容');
    const configured=!!session.data.settings.newFileDirectory;
    const doc=await (await markdownStore()).create(await newDocumentPath('md'),source,!configured);
    await trackNewDocument(doc);
    return rememberMarkdown(doc);
  });
  handle('mdSave',async(request:MarkdownSaveRequest)=>{
    if(!markdown)throw new Error('Markdown 文件未打开');
    const file=markdown.snapshot(request.handle).path,tracked=session.data.autoNamedDocuments?.find(d=>d.path===file);
    const owned=tracked&&tracked.identity===fileIdentity(await fs.stat(file));
    const result=await markdown.save(request);
    if(owned){const identity=fileIdentity(await fs.stat(file));session.update({autoNamedDocuments:session.data.autoNamedDocuments?.map(d=>d.path===file?{...d,identity}:d)});}
    return result;
  });
  handle('mdReload',async(request:MarkdownSaveRequest)=>{if(!markdown)throw new Error('Markdown 文件未打开');return rememberMarkdown(await markdown.reload(request));});
  handle('mdSaveAs',async(request:MarkdownSaveRequest)=>{
    if(!markdown)throw new Error('Markdown 文件未打开');const doc=markdown.snapshot(request.handle);
    const target=await dialog.showSaveDialog(window,{defaultPath:path.join(app.getPath('documents'),doc.name),filters:doc.kind==='text'?[{name:'所有文件',extensions:['*']}]:[{name:'Markdown 文档',extensions:['md','markdown']}]});
    if(target.canceled||!target.filePath)return null;
    return rememberMarkdown(await markdown.saveAs(request,doc.kind==='text'||isMarkdownPath(target.filePath)?target.filePath:target.filePath+'.md'));
  });
  handle('renameFormat',(request:import('../shared/native-document').FormatRenameRequest)=>duringRelocation(request.handle,async()=>{
    const original=getAnyDoc(request.handle);
    if(recoveryConflicts.has(request.handle))throw new Error('恢复内容与磁盘冲突，请先处理冲突。');
    const store=await markdownStore(),{renameFormat}=await import('./rename-format');
    const result=await renameFormat(request,original,db,store,path.join(app.getPath('userData'),'recovery','format-renames'));
    docs.delete(original.handle);recoveryConflicts.delete(original.handle);
    try{keepNamedDocument(original.path);reminders.forgetDocument(original.path);await journal.clear(original.path);session.update({recent:session.data.recent.filter(p=>p!==original.path)});}catch(error){result.warning=[result.warning,'旧路径记录暂未清理：'+errorMessage(error)].filter(Boolean).join('\n');}
    return 'kind' in result?rememberMarkdown(result):snapshot(result);
  }));
  handle('mdRename',async(handle:string,name:string)=>{
    if(!markdown)throw new Error('Markdown 文件未打开');const doc=markdown.snapshot(handle);
    // Reuse Windows name validation without imposing the TDE extension.
    const clean=documentFileName(name,'');
    const result=await markdown.rename(handle,path.join(path.dirname(doc.path),clean));
    if(result.path!==doc.path)try{keepNamedDocument(doc.path);session.update({recent:session.data.recent.filter(p=>p.toLowerCase()!==doc.path.toLowerCase())});}catch(error){result.warning='文件名已更新，旧路径记录暂未清理：'+errorMessage(error);}
    return rememberMarkdown(result);
  });
  handle('mdAddAsset',async(handle:string,data:Uint8Array)=>{
    if(!markdown?.has(handle))throw new Error('Markdown 文件未打开');await imageInfo(data);
    const preview=await imagePreview(data),extension=({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'} as Record<string,string>)[preview.mime];
    if(!extension)throw new Error('暂不支持该图片格式');return markdown.addAsset(handle,preview.data,extension);
  });
  handle('mdReadAsset',async(handle:string,reference:string)=>{
    if(!markdown?.has(handle))throw new Error('Markdown 文件未打开');
    const file=await markdown.assetPath(handle,reference),preview=await imagePreview(await fs.readFile(file));
    return `data:${preview.mime};base64,${Buffer.from(preview.data).toString('base64')}`;
  });
  handle('create',async()=>{
    const doc={...await db.call<DocumentSnapshot>('open',await newDocumentPath('tde'),true),draft:true};await trackNewDocument(doc);return snapshot(doc);
  });
  handle('reload',async(request:SaveRequest)=>{
    validateSave(request);const source=getDoc(request.handle);
    const dir=path.join(app.getPath('userData'),'recovery','documents');await fs.mkdir(dir,{recursive:true});
    const backup=path.join(dir,`${path.basename(source.path,'.tde')}-${randomUUID()}.tde`);
    const copy=await db.call<DocumentSnapshot>('saveAs',request,backup);await db.call('close',copy.handle);
    try{
      // Retire the replay record only after a complete, independently openable
      // copy exists. A failed reload leaves both the current editor and this copy.
      await journal.retire(source.path);
      const result=await db.call<DocumentSnapshot>('reload',source.handle);
      recoveryConflicts.delete(source.handle);
      result.recoveryBackup=backup;result.warning='已加载磁盘版本，之前的编辑已保留为恢复文档。';
      return snapshot(result);
    }catch(error){throw new Error(`重新加载未完成，当前编辑仍保留；恢复文档：${backup}。${errorMessage(error)}`);}
  });
  handle('revealRecovery',(handle:string)=>{const backup=getAnyDoc(handle).recoveryBackup;if(backup)shell.showItemInFolder(backup);});
  handle('save',async(r:SaveRequest)=>{
    validateSave(r);if(recoveryConflicts.has(r.handle))throw new Error('恢复内容与磁盘版本冲突，请另存为以保留两份内容。');await journal.stage(getDoc(r.handle),r);const result=await db.call<SaveResult>('save',r);
    const d=getDoc(r.handle); d.revision=result.revision; d.events=r.events.map(e=>({...e,id:result.idMap[String(e.id)]??e.id}));
    try{await journal.clear(d.path);}catch(error){result.warning='正文已保存，恢复日志暂未清理：'+errorMessage(error);}
    void checkReminders();
    return result;
  });
  handle('saveAs',(r:SaveRequest)=>duringRelocation(r.handle,async()=>{
    validateSave(r); const d=getDoc(r.handle);
    const target=await dialog.showSaveDialog(window,{defaultPath:path.join(app.getPath('documents'),path.basename(d.path)),filters:[{name:'TodoLine 文档',extensions:['tde']}]});
    if(target.canceled||!target.filePath) return null;
    const out=target.filePath.toLowerCase().endsWith('.tde')?target.filePath:target.filePath+'.tde';
    const result=await db.call<DocumentSnapshot>('saveAs',r,out);
    try{reminders.copyDocument({...d,events:r.events},result);}
    catch(error){await db.call('close',result.handle);throw new Error(`副本已保留在 ${out}，提醒记录未迁移，当前文档保持原样。${errorMessage(error)}`);}
    try{await journal.clear(d.path);}catch(error){result.warning='新文件已保存，原文件的恢复日志暂未清理：'+errorMessage(error);}
    return snapshot(result);
  }));
  handle('close',closeDocument);
  handle('search',(handle:string,query:string)=>{getDoc(handle);return db.call('search',handle,String(query).slice(0,1000));});
  handle('asset',(handle:string,id:number)=>{getDoc(handle);return db.call('asset',handle,id);});
  handle('addAsset',async(handle:string,data:Uint8Array,w:number,h:number)=>{
    getDoc(handle);const size=await imageInfo(data);return db.call('addAsset',handle,data,size.width,size.height);
  });
  handle('imageInfo',imageInfo);
  handle('assetPreview',async(handle:string,id:number)=>{getDoc(handle);const asset=await db.call<AssetRecord|null>('asset',handle,id);if(!asset)throw new Error('图片不存在，原文件未修改。');const preview=await imagePreview(asset.data);return `data:${preview.mime};base64,${Buffer.from(preview.data).toString('base64')}`;});
  handle('addAssets',async(handle:string,assets:import('../shared/types').AssetInput[])=>{
    getDoc(handle);let total=0;
    if(!Array.isArray(assets))throw new Error('无效图片批次');
    for(const asset of assets){
      if(!asset||!(asset.data instanceof Uint8Array)||asset.data.byteLength>100*1024*1024||(total+=asset.data.byteLength)>512*1024*1024)throw new Error('图片批次过大，请分批导入');
    }
    const verified=[];
    for(const asset of assets){const size=await imageInfo(asset.data);verified.push({data:asset.data,w:size.width,h:size.height});}
    return db.call('addAssets',handle,verified);
  });
  handle('reveal',(handle:string)=>shell.showItemInFolder(getAnyDoc(handle).path));
  handle('rename',(handle:string,name?:string)=>duringRelocation(handle,async()=>{
    const d=getDoc(handle);
    let to:string;
    if(name!==undefined)to=path.join(path.dirname(d.path),documentFileName(name,''));
    else{
      const target=await dialog.showSaveDialog(window,{title:'重命名文档',defaultPath:d.path,filters:[{name:'TodoLine 文档',extensions:['tde']}]});
      if(target.canceled||!target.filePath)return null;
      to=target.filePath.toLowerCase().endsWith('.tde')?target.filePath:target.filePath+'.tde';
    }
    if(!isTdePath(to))throw new Error('请通过格式转换重命名此文件。');
    if(to===d.path) return d;
    if(to.toLowerCase()===d.path.toLowerCase()){
      const result=await db.call<DocumentSnapshot>('renameCase',handle,to);
      keepNamedDocument(d.path);
      try{session.update({recent:session.data.recent.filter(file=>file.toLowerCase()!==d.path.toLowerCase())});}catch(error){result.warning='文件名已更新，最近文件记录未保存：'+errorMessage(error);}
      return snapshot(result);
    }
    // Inline rename never overwrites another document or interprets input as a path.
    if(name!==undefined&&await fs.lstat(to).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw new Error('同一文件夹中已有该名称，请换一个文件名。');
    // Save As permits exporting a conflicted memory snapshot. Rename additionally
    // removes the source, so it must validate the live source before and after copying.
    const unchanged=()=>db.call('save',{handle,revision:d.revision,events:d.events});
    await unchanged();
    const result=await db.call<DocumentSnapshot>('saveAs',{handle,revision:d.revision,events:d.events},to,name===undefined);
    try{await unchanged();}catch(error){await db.call('close',result.handle);throw new Error(`原文件有外部变化，未删除原文件。副本已保留在 ${to}。${errorMessage(error)}`);}
    try{reminders.copyDocument(d,result);}
    catch(error){await db.call('close',result.handle);throw new Error(`副本已保留在 ${to}，提醒记录未迁移，原文件未删除。${errorMessage(error)}`);}
    await db.call('close',handle); docs.delete(handle);recoveryConflicts.delete(handle);
    keepNamedDocument(d.path);
    // Rename only after both the new SQLite copy and its open have succeeded.
    let removed=false;
    try{await fs.unlink(d.path);removed=true;}
    catch(error){result.warning=`新文件已保存，原文件无法移除，已保留两份文件。原路径：${d.path}。${errorMessage(error)}`;}
    if(removed)try{session.update({recent:session.data.recent.filter(file=>file!==d.path)});}
    catch(error){result.warning='重命名已完成，但最近文件记录未保存：'+errorMessage(error);}
    if(removed)try{reminders.forgetDocument(d.path);}catch(error){result.warning=[result.warning,'新文件提醒已迁移，旧路径记录暂未清理：'+errorMessage(error)].filter(Boolean).join('\n');}
    return snapshot(result);
  }));
  handle('revealRecent',async(file:string)=>{
    if(typeof file!=='string'||!session.data.recent.some(p=>p.toLowerCase()===file.toLowerCase()))throw new Error('该文件不在最近打开列表中');
    shell.showItemInFolder(file);
  });
  handle('showSearch',()=>showSearch());
  handle('openLink',async(url:string)=>{ const parsed=new URL(url); if(!['http:','https:','mailto:'].includes(parsed.protocol)) throw new Error('不支持的链接'); await shell.openExternal(url); });
  handle('revealExport',()=>{ if(lastExport) shell.showItemInFolder(lastExport); });
  // An input trace from a machine where editing misbehaves, saved in the profile and shown in Explorer.
  handle('saveDiagnostics',async(text:string)=>{
    if(typeof text!=='string') throw new Error('无效诊断记录');
    const dir=path.join(app.getPath('userData'),'diagnostics'); await fs.mkdir(dir,{recursive:true});
    const file=path.join(dir,`input-trace-${new Date().toISOString().replace(/[:.]/g,'-')}.txt`);
    const displays=screen.getAllDisplays().map(d=>`${d.size.width}x${d.size.height}@${d.scaleFactor}`).join(', ');
    const header=[`TodoLine ${app.getVersion()}`,`Windows ${process.getSystemVersion()}`,`Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,`Displays: ${displays}`];
    await fs.writeFile(file,header.join('\n')+'\n'+text.slice(0,4_000_000),'utf8');
    if(!testing) shell.showItemInFolder(file);
    return file;
  });
  handle('copy',writeClipboard);
  handle('readClipboard',readClipboard);
  handle('export',async(handle:string,format:string,html:string,text:string)=>{
    const d=getAnyDoc(handle); if(!['md','txt','pdf'].includes(format)) throw new Error('无效导出格式');
    const target=await dialog.showSaveDialog(window,{title:'导出文档',defaultPath:path.join(path.dirname(d.path),path.basename(d.path,path.extname(d.path))+`.${format}`),filters:[{name:format.toUpperCase(),extensions:[format]}]});
    if(target.canceled||!target.filePath) return '';
    const file=target.filePath.toLowerCase().endsWith(`.${format}`)?target.filePath:target.filePath+`.${format}`;
    const temp=file+'.tmp-'+randomUUID();
    try {
      if(format!=='pdf') await fs.writeFile(temp,text,'utf8');
      else {
        const print=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
        try {
          // Only the bounded print fragment is loaded, never the document's original HTML.
          const title=path.basename(file).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
          const markdownCss=isMarkdownPath(d.path)?await (await import('./markdown-print')).markdownPrintStyles(path.join(__dirname,'../renderer/assets')):'';
          const page=`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: tde-asset: md-asset:; font-src data:; style-src 'unsafe-inline'"><style>body{font:11pt 'Microsoft YaHei',sans-serif;color:#24272b;line-height:1.6}h2{font-size:11pt;text-align:center;color:#377dc0;border-top:1px solid #377dc0;padding-top:6px}p{margin:0 0 6px}img{max-width:100%;height:auto}li{break-inside:avoid}@counter-style tl-paren{system:extends decimal;prefix:"(";suffix:") "}@counter-style tl-circled{system:fixed;symbols:"①" "②" "③" "④" "⑤" "⑥" "⑦" "⑧" "⑨" "⑩" "⑪" "⑫" "⑬" "⑭" "⑮" "⑯" "⑰" "⑱" "⑲" "⑳";suffix:" ";fallback:decimal}ul{list-style-type:disc}[data-list-style=paren]{list-style-type:tl-paren}[data-list-style=circled]{list-style-type:tl-circled}[data-list-style=lower-alpha]{list-style-type:lower-alpha}[data-list-style=upper-alpha]{list-style-type:upper-alpha}[data-list-style=lower-roman]{list-style-type:lower-roman}[data-list-style=upper-roman]{list-style-type:upper-roman}[data-list-style=square]{list-style-type:square}[data-list-indent="1"]{margin-left:40px}[data-list-indent="2"]{margin-left:80px}[data-list-indent="3"]{margin-left:120px}[data-list-indent="4"]{margin-left:160px}:is(ol,ul)+:is(ol,ul){margin-top:0}:is(ol,ul):has(+:is(ol,ul)){margin-bottom:0}ul[data-list-style=square]{list-style-type:none}ul[data-list-style=square]>li{position:relative}ul[data-list-style=square]>li::before{content:'';position:absolute;left:-13px;top:calc(0.8em - 3.5px);width:7px;height:7px;background:currentColor}[data-list-style=circle]{list-style-type:circle}blockquote{border-left:2px solid #377dc0;padding-left:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;background:#f3f5f7;padding:10px;border-radius:4px}code{font-family:Consolas,monospace}pre code{font:inherit}sup,sub{font-size:75%;line-height:0}h2{break-after:avoid}${markdownCss}</style></head><body>${html}</body></html>`;
          await print.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(page));
          await print.webContents.executeJavaScript(`(async()=>{for(const img of document.images){const url=new URL(img.src);if(url.protocol==='tde-asset:'){url.searchParams.set('still','1');img.src=url.href;}}await document.fonts.ready;await Promise.all(Array.from(document.images).map(img=>img.decode().catch(()=>{throw new Error('导出图片加载失败')})));})()`);
          const pdf=await print.webContents.printToPDF({printBackground:true,pageSize:'A4',margins:{top:.5,bottom:.5,left:.55,right:.55},preferCSSPageSize:false});
          await fs.writeFile(temp,pdf);
        } finally { print.destroy(); }
      }
      await fs.rename(temp,file);
    } catch(error) { await fs.rm(temp,{force:true}).catch(()=>{}); throw error; }
    lastExport=file; return file;
  });
  handle('window',(action:string)=>{ if(action==='minimize')window.minimize();else if(action==='maximize')window.isMaximized()?window.unmaximize():window.maximize();else if(action==='close')window.close(); });
  handle('confirmClose',async(ok:boolean)=>{if(ok){
    for(const doc of [...docs.values(),...(markdown?.snapshots()??[])])try{await closeDocument(doc.handle);}catch(error){send('error','退出清理未完成，文件已保留：'+errorMessage(error));}
    closing=true;window.close();
  }else{quitting=false;void openPendingFiles();}});
  handle('snooze',(key:string)=>{const notice=reminders.active(reminderDocuments()).find(n=>n.key===key);if(!notice)throw new Error('这条提醒已失效。');reminders.snooze(key,Date.now(),notice.id);void checkReminders();});
  handle('snoozedEvents',(handle:string)=>reminders.pendingSnoozes(getDoc(handle)));
  handle('showReminders',()=>reminderWindow?.show());
  handle('reminderEdited',(id:string,error?:string)=>{reminderCompletions.get(id)?.(error);});
}
async function checkReminders() {
  if(!rendererReady||closing||window.isDestroyed())return;
  if(checkingReminders||reminderMutations){reminderAgain=true;return;}checkingReminders=true;
  try{
    do{
      reminderAgain=false;const snapshots=[...docs.values()];
      let persistenceError:unknown;
      const advance=session.data.settings.advanceMinutes,muted=advance<0;
      if(!muted)try{reminders.collect(snapshots,advance);}catch(error){persistenceError=error;}
      const notices=muted?[]:reminders.active(reminderDocuments());send('notices',notices);
      const theme=session.data.settings.theme==='system'?(nativeTheme.shouldUseDarkColors?'dark':'light'):session.data.settings.theme;
      await reminderWindow?.update(notices,theme);
      if(persistenceError)throw persistenceError;
      reminderError='';
    }while(reminderAgain&&!closing&&!reminderMutations);
  }catch(error){const message='提醒暂未更新，将自动重试：'+errorMessage(error);if(message!==reminderError){reminderError=message;send('error',message);}}
  finally{checkingReminders=false;}
}
async function ready() {
  session=new SessionStore(app.getPath('userData'),paths=>{if(window&&!window.isDestroyed())send('recentChanged',paths);}); db=new DatabaseClient();
  if([...session.data.tabs.map(tab=>tab.path),...pendingFiles].some(file=>isTdePath(file)))db.warmup();
  journal=new RecoveryJournal(path.join(app.getPath('userData'),'recovery'));
  reminders=new ReminderSchedule(path.join(app.getPath('userData'),'reminders.json'));
  if(session.firstRun&&!testing){
    try{
      const legacy=path.join(app.getPath('appData'),'TodoLine','TodoLine','session.db');
      await fs.access(legacy); // A clean install must not start SQLite for a missing migration.
      const old=await db.call<Record<string,string>>('readLegacySettings',legacy);
      const settings={...session.data.settings};
      if(['dark','light'].includes(old.theme))settings.theme=old.theme as 'dark'|'light';
      if(Number(old.fontSize)>0)settings.fontSize=Math.max(10,Math.min(30,Math.round(Number(old.fontSize)*4/3)));
      if(old.showLineNumbers)settings.lineNumbers=old.showLineNumbers!=='0';
      if(old.closeBehavior)settings.closeToTray=old.closeBehavior!=='quit';
      if(Number.isFinite(Number(old.advanceMinutes)))settings.advanceMinutes=Math.max(0,Math.min(1440,Number(old.advanceMinutes)));
      session.update({settings});
    }catch{/* The original settings file may not exist. Its session is never opened for writing. */}
  }
  protocol.handle('tde-asset',async request=>{
    try {
      const url=new URL(request.url); const [handle,id]=url.pathname.slice(1).split('/'); getDoc(handle);
      const asset=await db.call<AssetRecord|null>('asset',handle,Number(id));
      if(!asset) return new Response(null,{status:404});
      const preview=await imagePreview(asset.data,url.searchParams.get('still')==='1');
      return new Response(new Uint8Array(preview.data),{headers:{'Content-Type':preview.mime,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'}});
    } catch { return new Response(null,{status:404}); }
  });
  protocol.handle('md-asset',async request=>{
    try{
      const url=new URL(request.url),parts=url.pathname.slice(1).split('/'),handle=parts.shift()!,reference=decodeURIComponent(parts.join('/'));
      if(!markdown?.has(handle))return new Response(null,{status:404});
      const file=await markdown.assetPath(handle,reference),bytes=await fs.readFile(file),preview=await imagePreview(bytes);
      if(!preview.mime.startsWith('image/'))return new Response(null,{status:415});
      return new Response(new Uint8Array(preview.data),{headers:{'Content-Type':preview.mime,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'}});
    }catch{return new Response(null,{status:404});}
  });
  const areas=()=>{const primary=screen.getPrimaryDisplay();return [primary,...screen.getAllDisplays().filter(d=>d.id!==primary.id)].map(d=>d.workArea);};
  const bounds=fitWindow(session.data.bounds,areas());
  window=new BrowserWindow({...bounds,minWidth:Math.min(760,bounds.width),minHeight:Math.min(520,bounds.height),backgroundColor:'#171a20',title:'TodoLine',icon:path.join(__dirname,'../../resources/icon.png'),frame:false,show:!testing,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false,backgroundThrottling:!testing}});
  if(session.data.maximized)window.maximize();
  let boundsTimer:ReturnType<typeof setTimeout>|undefined,windowError='',lastMaximized=!!session.data.maximized;
  const saveBounds=()=>{
    clearTimeout(boundsTimer);if(window.isDestroyed())return;
    if(!window.isMinimized())lastMaximized=window.isMaximized();
    try{session.update({bounds:window.getNormalBounds(),maximized:lastMaximized});windowError='';}
    catch(error){const message='窗口位置未保存：'+errorMessage(error);if(message!==windowError){windowError=message;if(rendererReady)send('error',message);}}
  };
  const scheduleBounds=()=>{clearTimeout(boundsTimer);boundsTimer=setTimeout(saveBounds,200);};
  const fitVisible=()=>{if(window.isDestroyed()||window.isMaximized()||window.isMinimized())return;const current=window.getBounds(),next=fitWindow(current,areas());if(JSON.stringify(current)!==JSON.stringify(next))window.setBounds(next);};
  showSearch=installSearchWindow(window);
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.on('blur',()=>send('windowInactive'));window.on('hide',()=>send('windowInactive'));window.on('minimize',()=>send('windowInactive'));
  window.on('close',event=>{
    saveBounds();
    if(closing)return;
    event.preventDefault();
    if(session.data.settings.closeToTray&&!quitting){window.hide();return;}
    send('close');
  });
  window.on('move',scheduleBounds);window.on('resize',scheduleBounds);window.on('maximize',()=>{lastMaximized=true;scheduleBounds();});window.on('unmaximize',()=>{lastMaximized=false;fitVisible();scheduleBounds();});
  screen.on('display-removed',fitVisible);screen.on('display-metrics-changed',fitVisible);
  const themeChanged=()=>{if(rendererReady){send('theme',nativeTheme.shouldUseDarkColors);void checkReminders();}};nativeTheme.on('updated',themeChanged);
  window.on('closed',()=>{clearTimeout(boundsTimer);screen.removeListener('display-removed',fitVisible);screen.removeListener('display-metrics-changed',fitVisible);nativeTheme.removeListener('updated',themeChanged);});
  app.on('before-quit',event=>{if(!closing){event.preventDefault();quitting=true;window.close();}});
  registerIPC(); traySetup();
  reminderWindow=new ReminderWindow(async(notice,action,snoozeText)=>{
    const current=reminders.active(reminderDocuments()).find(n=>n.id===notice.id);
    if(!current){await checkReminders();return;}
    const deadline=action==='snooze'?reminderTime(snoozeText):undefined;
    reminderMutations++;
    try{
      if(deadline)reminders.preparePostpone(current,deadline.ts);
      if(action==='done'||deadline)await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{reminderCompletions.delete(current.id);reject(new Error('编辑器尚未确认保存，请重试。'));},15000);
        reminderCompletions.set(current.id,error=>{clearTimeout(timer);reminderCompletions.delete(current.id);error?reject(new Error(error)):resolve();});send('reminderEdit',{...current,deadline});
      });
      if(action==='open'){showWindow();send('reveal',{handle:current.handle,eventId:current.eventId});}
      reminders.dismiss(current.id);
    }finally{reminderMutations--;await checkReminders();}
  },message=>send('error',message));
  window.on('closed',()=>{reminderWindow?.destroy();disposeImageDecoders();});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'文件',submenu:[{label:'新建',accelerator:'CmdOrCtrl+N',click:()=>command('new')},{label:'打开',accelerator:'CmdOrCtrl+O',click:()=>command('open')},{label:'保存',accelerator:'CmdOrCtrl+S',click:()=>command('save')},{label:'另存为',accelerator:'CmdOrCtrl+Shift+S',click:()=>command('saveAs')},{label:'关闭标签',accelerator:'CmdOrCtrl+W',click:()=>command('closeTab')}]},
    {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{role:'cut'},{role:'copy'},{role:'paste'},{label:'置顶事件',accelerator:'CmdOrCtrl+T',click:()=>command('pinEvent')},{label:'搜索',accelerator:'CmdOrCtrl+F',click:()=>command('search')},{label:'下一个匹配',accelerator:'F3',click:()=>command('nextMatch')},{label:'上一个匹配',accelerator:'Shift+F3',click:()=>command('previousMatch')}]},
    {label:'视图',submenu:[{label:'放大',accelerator:'CmdOrCtrl+=',click:()=>command('zoomIn')},{label:'缩小',accelerator:'CmdOrCtrl+-',click:()=>command('zoomOut')},{label:'恢复默认字号',accelerator:'CmdOrCtrl+0',click:()=>command('zoomReset')},{label:'导出输入诊断记录',accelerator:'CmdOrCtrl+Shift+F12',click:()=>command('inputTrace')},{label:'退出',accelerator:'CmdOrCtrl+Q',click:()=>{quitting=true;window.close();}}]},
  ]));
  await window.loadFile(path.join(__dirname,'../renderer/index.html'));
  let suspended=false,locked=false;
  const refreshPower=()=>{reminderWindow?.block(suspended||locked);if(!suspended&&!locked)void checkReminders();};
  powerMonitor.on('suspend',()=>{suspended=true;refreshPower();});powerMonitor.on('resume',()=>{suspended=false;refreshPower();});
  powerMonitor.on('lock-screen',()=>{locked=true;refreshPower();});powerMonitor.on('unlock-screen',()=>{locked=false;refreshPower();});
  setInterval(checkReminders,15000).unref();
}
if(!app.requestSingleInstanceLock(initialRequest)) app.exit(0);
else if(initialRequest.quit)app.exit(0);
else {
  app.on('second-instance',(_event,argv,cwd,data)=>{
    const forwarded=data as {files?:unknown;quit?:unknown}|undefined;
    const request=forwarded&&Array.isArray(forwarded.files)&&typeof forwarded.quit==='boolean'?{files:forwarded.files as unknown[],quit:forwarded.quit}:launchRequest(argv,cwd,!!process.defaultApp);
    if(request.quit){quitting=true;if(rendererReady)window.close();return;}
    pendingFiles.push(...request.files.filter((file:unknown):file is string=>typeof file==='string'&&path.isAbsolute(file)&&isDocumentPath(file)));
    showWindow();void openPendingFiles();
  });
  app.whenReady().then(ready).catch(error=>{console.error(error);app.exit(1);});
  app.on('window-all-closed',()=>{db?.shutdown();app.quit();});
}
