import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {DocumentStore} from '../../src/main/storage';
let app:ElectronApplication,page:Page,root:string,file:string,other:string;
const editor=()=>page.locator('.document-scroller:visible .todo-document');
function rows(file:string){const db=new Database(file,{readonly:true});try{return db.prepare('select * from events order by pos').all() as any[];}finally{db.close();}}
async function caret(pos:number){await editor().evaluate((el:any,pos)=>{el.editor.view.focus();el.editor.commands.setTextSelection(pos);},pos);await expect(editor()).toBeFocused();}
test.beforeEach(async({},info)=>{
  root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});file=path.join(root,'来源.tde');other=path.join(root,'目标.tde');const store=new DocumentStore();
  for(const file of [path.join(root,'来源.tde'),other]){const doc=store.open(file,true);await store.save({...doc,events:[{id:-1,pos:0,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:0,content_html:'<p>abcdef</p>',content_text:'abcdef'}]});store.close(doc.handle);}
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({args:[path.resolve('.'),'--open',file],env:env as Record<string,string>});page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].show();BrowserWindow.getAllWindows()[0].focus();});await expect(editor()).toBeVisible();
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
async function delayedRead(text:string){await app.evaluate(({ipcMain},text)=>{ipcMain.removeHandler('tl:readClipboard');ipcMain.handle('tl:readClipboard',async()=>{(globalThis as any).readStarted=true;await new Promise<void>(resolve=>{(globalThis as any).releaseRead=resolve;});return {text,html:'',events:''};});},text);}
test('native paste keeps its original location while later typing and caret are preserved',async()=>{
  await delayedRead('粘贴');await caret(3);await page.keyboard.press('Control+v');await expect.poll(()=>app.evaluate(()=>(globalThis as any).readStarted)).toBe(true);await page.keyboard.press('Control+End');await page.keyboard.type('later');await app.evaluate(()=>(globalThis as any).releaseRead());
  await expect(editor().locator('p')).toHaveText('ab粘贴cdeflater');expect(await editor().evaluate((el:any)=>el.editor.state.selection.$from.parentOffset)).toBe(13);await expect.poll(()=>rows(file)[0].content_text).toBe('ab粘贴cdeflater');await page.keyboard.press('Control+z');await expect(editor()).toHaveText('abcdeflater');await page.keyboard.press('Control+z');await expect(editor()).toHaveText('abcdef');
});
test('a pending paste does not overwrite a replacement typed into its selected range',async()=>{
  await delayedRead('粘贴');await caret(2);await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('Control+v');await expect.poll(()=>app.evaluate(()=>(globalThis as any).readStarted)).toBe(true);await page.keyboard.type('NEW');await app.evaluate(()=>(globalThis as any).releaseRead());await expect(page.getByText('等待期间目标内容已被修改，未覆盖新内容。请重新选择后重试。',{exact:false})).toBeVisible();await expect(editor().locator('p')).toHaveText('aNEWdef');await expect.poll(()=>rows(file)[0].content_text).toBe('aNEWdef');
});
test('clipboard completion waits while Chinese composition is active in the same editor',async()=>{
  await delayedRead('粘贴');await caret(3);await page.keyboard.press('Control+v');await expect.poll(()=>app.evaluate(()=>(globalThis as any).readStarted)).toBe(true);await page.keyboard.press('Control+End');const dom=await editor().elementHandle(),cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});await app.evaluate(()=>(globalThis as any).releaseRead());await page.waitForTimeout(80);await expect(editor()).not.toContainText('粘贴');await cdp.send('Input.insertText',{text:'中文'});await expect(editor().locator('p')).toHaveText('ab粘贴cdef中文');expect(await dom!.evaluate(el=>el.isConnected)).toBe(true);await expect.poll(()=>rows(file)[0].content_text).toBe('ab粘贴cdef中文');
});
test('cross-file paste queued during image copy receives original pixels and keeps target focus',async()=>{
  const png=await app.evaluate(({nativeImage})=>Array.from(nativeImage.createFromBitmap(Buffer.alloc(800*600*4,255),{width:800,height:600}).toPNG()));
  const asset=await page.evaluate(async png=>{const doc=await window.desktop.openRecent((await window.desktop.session()).tabs[0].path);const id=await window.desktop.addAsset(doc.handle,new Uint8Array(png),800,600);return {id,handle:doc.handle};},png);
  await editor().evaluate((el:any,id)=>{el.editor.commands.insertContentAt(3,{type:'image',attrs:{assetId:id,width:80,height:60}});el.editor.view.focus();},asset.id);await expect.poll(()=>rows(file)[0].content_html).toContain('asset:');
  await app.evaluate(({ipcMain,clipboard},data)=>{clipboard.writeText('stale');ipcMain.removeHandler('tl:asset');ipcMain.handle('tl:asset',async()=>{(globalThis as any).copyStarted=true;await new Promise<void>(resolve=>{(globalThis as any).releaseCopy=resolve;});return {id:data.id,data:new Uint8Array(data.png),w:800,h:600};});},{id:asset.id,png});
  await page.keyboard.press('Control+a');await page.keyboard.press('Control+c');await expect.poll(()=>app.evaluate(()=>(globalThis as any).copyStarted)).toBe(true);
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},other);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();await expect(page.locator('.file-tab.active')).toContainText('目标');await caret(1);await page.keyboard.press('Control+a');await page.keyboard.press('Control+v');await page.keyboard.press('ArrowRight');await app.evaluate(()=>(globalThis as any).releaseCopy());
  await expect(editor().locator('.image-view img')).toHaveCount(1);await expect(editor()).not.toContainText('stale');await expect(editor()).toBeFocused();await expect.poll(()=>rows(other)[0].content_html).toContain('asset:');
  const db=new Database(other,{readonly:true});try{const a=db.prepare('select * from assets').get() as any;expect(Buffer.from(a.data)).toEqual(Buffer.from(png));expect(a.w).toBe(800);expect(a.h).toBe(600);}finally{db.close();}
  await expect(editor().locator('.image-view img')).toHaveCSS('width','80px');await page.keyboard.press('Control+z');await expect(editor().locator('.image-view img')).toHaveCount(0);
});
