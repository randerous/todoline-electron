import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {DocumentStore} from '../../src/main/storage';
import {imageFixtures} from '../fixtures/image-formats';
let app:ElectronApplication,page:Page,root:string,file:string;
const editor=()=>page.locator('.document-scroller:visible .todo-document');
function saved(target=file){const db=new Database(target,{readonly:true});try{return {events:db.prepare('select * from events order by pos').all() as any[],assets:db.prepare('select * from assets order by id').all() as any[]};}finally{db.close();}}
async function importAll(){await editor().evaluate((el:any)=>{el.editor.commands.setTextSelection(1);el.editor.view.focus();});await page.locator('input[type=file]').setInputFiles(imageFixtures.map(f=>({name:f.name,mimeType:'',buffer:f.buffer})));await expect(editor().locator('.image-view')).toHaveCount(imageFixtures.length);await expect.poll(()=>saved().assets.length).toBe(imageFixtures.length);await expect.poll(()=>saved().events[0].content_html).toContain('asset:');}
async function rendered(){
  const images=await editor().locator('.image-view img').evaluateAll(async (images:any[])=>Promise.all(images.map(async im=>{await im.decode();return {src:im.src,size:[im.naturalWidth,im.naturalHeight]};})));
  return app.evaluate(async({net,nativeImage},images)=>Promise.all(images.map(async im=>{const response=await net.fetch(im.src),image=nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer())),pixel=image.toBitmap();return {size:im.size,pixel:[pixel[2],pixel[1],pixel[0],pixel[3]]};})),images);
}
test.beforeEach(async({},info)=>{
  root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});file=path.join(root,'图片兼容.tde');const store=new DocumentStore(),doc=store.open(file,true);await store.save({...doc,events:[{id:-1,pos:0,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:0,content_html:'<p>中文图片兼容测试</p>',content_text:'中文图片兼容测试'}]});store.close(doc.handle);
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;app=await _electron.launch({args:[path.resolve('.'),'--open',file],env:env as Record<string,string>});page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].show();BrowserWindow.getAllWindows()[0].focus();});await expect(editor()).toBeVisible();
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
test('TIFF, BMP and ICO import, render accurate pixels and preserve original bytes through Qt edits',async({},info)=>{
  await importAll();const images=await rendered();expect(images.map(i=>i.size)).toEqual(imageFixtures.map(f=>[f.width,f.height]));
  expect(images[0].pixel).toEqual([180,80,30,255]);expect(images[1].pixel).toEqual(images[0].pixel);expect(images[2].pixel).toEqual([40,160,220,255]);expect(images[3].pixel).toEqual(images[0].pixel);expect(images[4].pixel[3]).toBe(128);expect(images[5].pixel).toEqual(images[0].pixel);
  saved().assets.forEach((a,i)=>{expect(Buffer.from(a.data)).toEqual(imageFixtures[i].buffer);expect([a.w,a.h]).toEqual(images[i].size);});await page.screenshot({path:info.outputPath('image-formats.png')});
  for(const [i,fixture] of imageFixtures.entries()){
    const input=path.join(root,fixture.name);await fs.writeFile(input,fixture.buffer);
    const qt=JSON.parse(execFileSync(path.resolve('.cache/qt-compat/qt-compat.exe'),['inspect-image',input],{encoding:'utf8',windowsHide:true,env:{...process.env,QT_QPA_PLATFORM:'offscreen',PATH:'E:\\Qt\\6.8.3\\mingw_64\\bin;E:\\Qt\\Tools\\mingw1310_64\\bin;'+process.env.PATH}}));
    expect([qt.width,qt.height]).toEqual(images[i].size);if(i!==4)expect(qt.pixel).toEqual(images[i].pixel);else expect(qt.pixel[3]).toBe(128);
  }
  await page.locator('.file-tab.active .tab-close').click();await expect(page.locator('.file-tab')).toHaveCount(0);
  execFileSync(path.resolve('.cache/qt-compat/qt-compat.exe'),['edit',file],{windowsHide:true,env:{...process.env,QT_QPA_PLATFORM:'offscreen',PATH:'E:\\Qt\\6.8.3\\mingw_64\\bin;E:\\Qt\\Tools\\mingw1310_64\\bin;'+process.env.PATH}});
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();await expect(editor()).toContainText('旧版再次编辑');expect(await rendered()).toEqual(images);saved().assets.forEach((a,i)=>expect(Buffer.from(a.data)).toEqual(imageFixtures[i].buffer));
});
test('resized TIFF copies at full resolution externally and retains TIFF bytes across documents',async()=>{
  await importAll();await app.evaluate(({clipboard})=>clipboard.clear());await editor().evaluate((el:any)=>{const ed=el.editor;let pos=-1;ed.state.doc.descendants((n:any,p:number)=>{if(pos<0&&n.type.name==='image')pos=p;});ed.view.dispatch(ed.state.tr.setNodeMarkup(pos,undefined,{...ed.state.doc.nodeAt(pos).attrs,width:16,height:12}));ed.commands.setNodeSelection(pos);ed.view.focus();});await page.keyboard.press('Control+c');
  await expect.poll(()=>app.evaluate(({clipboard})=>clipboard.readImage().getSize())).toEqual({width:32,height:24});
  const original=saved().assets[0];await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await expect(page.locator('.file-tab.active')).toContainText(/\d{8}_\d+/);await editor().click();await page.keyboard.press('Control+v');await expect(editor().locator('.image-view')).toHaveCount(1);await expect(editor().locator('.image-view img')).toHaveCSS('width','16px');expect((await rendered())[0].size).toEqual([32,24]);
  await expect.poll(()=>page.evaluate(async()=>{const session=await window.desktop.session();const doc=await window.desktop.openRecent(session.tabs[session.active].path);if(!('events' in doc))throw new Error('Expected TDE');const match=doc.events[0]?.content_html.match(/asset:(\d+)/);if(!match)return null;const a=await window.desktop.asset(doc.handle,Number(match[1]));return a?Array.from(a.data):null;})).toEqual(Array.from(original.data));
  await page.keyboard.press('Control+z');await expect(editor().locator('.image-view')).toHaveCount(0);
});
test('PDF waits for converted images and retains the open-folder completion dialog',async()=>{
  await importAll();const out=path.join(root,'中文兼容图片.pdf');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},out);
  await page.getByRole('button',{name:'导出',exact:true}).click();await page.getByRole('button',{name:'PDF 文档 .pdf',exact:true}).click();await expect.poll(()=>fs.stat(out).then(s=>s.size,()=>0)).toBeGreaterThan(1000);await expect(page.getByRole('dialog',{name:'导出完成'})).toContainText('中文兼容图片.pdf');
  const pdf=await fs.readFile(out);expect(pdf.subarray(0,5).toString()).toBe('%PDF-');expect(pdf.toString('latin1').match(/\/Subtype \/Image/g)!.length).toBeGreaterThanOrEqual(3);
});
test('a corrupt TIFF cancels the entire batch and a valid retry works',async()=>{
  await page.locator('input[type=file]').setInputFiles([{name:'ok.bmp',mimeType:'',buffer:imageFixtures[1].buffer},{name:'broken.tiff',mimeType:'',buffer:imageFixtures[0].buffer.subarray(0,16)}]);await expect(page.locator('.toast')).toContainText('broken.tiff');expect(saved().assets).toHaveLength(0);await expect(editor().locator('.image-view')).toHaveCount(0);await importAll();
});
test('Qt-created TIFF assets display without rewriting the file, then survive edits in both apps',async()=>{
  await page.locator('.file-tab.active .tab-close').click();await expect(page.locator('.file-tab')).toHaveCount(0);
  const legacy=path.join(root,'Qt原图.tde'),input=path.join(root,'original.tif'),fixture=imageFixtures[3];await fs.writeFile(input,fixture.buffer);
  const qt=(mode:string)=>execFileSync(path.resolve('.cache/qt-compat/qt-compat.exe'),[mode,legacy,...(mode==='create-image'?[input]:[])],{windowsHide:true,env:{...process.env,QT_QPA_PLATFORM:'offscreen',PATH:'E:\\Qt\\6.8.3\\mingw_64\\bin;E:\\Qt\\Tools\\mingw1310_64\\bin;'+process.env.PATH}});
  qt('create-image');const before=await fs.readFile(legacy);
  const open=async()=>{await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},legacy);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();await expect(editor().locator('.image-view')).toHaveCount(1);};
  await open();expect((await rendered())[0].size).toEqual([32,24]);await expect(editor().locator('.image-view img')).toHaveCSS('width','16px');await page.waitForTimeout(800);expect(await fs.readFile(legacy)).toEqual(before);
  await editor().evaluate((el:any)=>{el.editor.commands.focus('end');});await page.keyboard.type(' Electron edited');await expect.poll(()=>saved(legacy).events[0].content_text).toContain('Electron edited');await page.locator('.file-tab.active .tab-close').click();await expect(page.locator('.file-tab')).toHaveCount(0);qt('edit');await open();await expect(editor()).toContainText('旧版再次编辑');await expect(editor()).toContainText('Electron edited');expect((await rendered())[0].size).toEqual([32,24]);expect(Buffer.from(saved(legacy).assets[0].data)).toEqual(fixture.buffer);
});
