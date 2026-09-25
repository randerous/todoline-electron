import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {DocumentStore} from '../../src/main/storage';
import encoded from '../fixtures/browser-images.json';
const samples=encoded.map(f=>({...f,buffer:Buffer.from(f.data,'base64'),mimeType:f.name.endsWith('.gif')?'image/gif':'image/webp'}));
let app:ElectronApplication,page:Page,root:string,file:string;
const editor=()=>page.locator('.document-scroller:visible .todo-document');
function saved(target=file){const db=new Database(target,{readonly:true});try{return {events:db.prepare('select * from events order by pos').all() as any[],assets:db.prepare('select * from assets order by id').all() as any[]};}finally{db.close();}}
async function insert(files=samples){await editor().evaluate((el:any)=>{el.editor.commands.setTextSelection(1);el.editor.view.focus();});await page.locator('input[type=file]').setInputFiles(files);await expect(editor().locator('.image-view')).toHaveCount(files.length);await editor().locator('.image-view img').evaluateAll(async(images:any[])=>Promise.all(images.map(im=>im.decode())));await expect.poll(()=>saved().events[0].content_html).toContain('asset:');}
async function holdDecoder(){await app.evaluate(({BrowserWindow})=>{const original=BrowserWindow.prototype.loadURL;(globalThis as any).restoreDecoder=()=>{BrowserWindow.prototype.loadURL=original;};BrowserWindow.prototype.loadURL=async function(url,...args){await original.call(this,url,...args);if(url.startsWith('data:')&&decodeURIComponent(url).includes('TodoLine 图片解码'))await new Promise<void>(resolve=>{(globalThis as any).releaseDecoder=resolve;});};});}
async function releaseDecoder(){await app.evaluate(()=>{(globalThis as any).restoreDecoder();(globalThis as any).releaseDecoder();});}
test.beforeEach(async({},info)=>{
  root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});file=path.join(root,'动图兼容.tde');const store=new DocumentStore(),doc=store.open(file,true);await store.save({...doc,events:[{id:-1,pos:0,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:0,content_html:'<p>中文动图</p>',content_text:'中文动图'}]});store.close(doc.handle);
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;app=await _electron.launch({args:[path.resolve('.'),'--open',file],env:env as Record<string,string>});page=await app.firstWindow();await (await app.browserWindow(page)).evaluate(win=>{win.show();win.focus();});await expect(editor()).toBeVisible();
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png'),timeout:5000}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
test('GIF and WebP retain original encoding and match Qt first-frame decoding through a file roundtrip',async({},info)=>{
  await insert();expect(saved().assets).toHaveLength(6);saved().assets.forEach((a,i)=>{expect(Buffer.from(a.data)).toEqual(samples[i].buffer);expect([a.w,a.h]).toEqual([32,24]);});
  const urls=await editor().locator('.image-view img').evaluateAll((images:any[])=>images.map(im=>im.src));
  const previews=await app.evaluate(async({net,nativeImage},urls)=>Promise.all(urls.map(async url=>{const raw=await net.fetch(url),still=await net.fetch(url+'?still=1'),image=nativeImage.createFromBuffer(Buffer.from(await still.arrayBuffer())),p=image.toBitmap();return {rawType:raw.headers.get('Content-Type'),stillType:still.headers.get('Content-Type'),size:image.getSize(),pixel:[p[2],p[1],p[0],p[3]]};})),urls);
  for(const [i,sample] of samples.entries()){
    expect(previews[i]).toMatchObject({rawType:sample.mimeType,stillType:'image/png',size:{width:32,height:24}});const input=path.join(root,sample.name);await fs.writeFile(input,sample.buffer);
    const options={encoding:'utf8' as const,windowsHide:true,env:{...process.env,QT_QPA_PLATFORM:'offscreen',PATH:'E:\\Qt\\6.8.3\\mingw_64\\bin;E:\\Qt\\Tools\\mingw1310_64\\bin;'+process.env.PATH}};
    let qtInput=input;
    if(sample.name==='lossless-alpha.webp'){
      // This Qt build refuses the valid 38-byte file, but decodes the same RIFF payload padded to 40 bytes.
      expect(spawnSync(path.resolve('.cache/qt-compat/qt-compat.exe'),['inspect-image',input],options).status).toBe(10);
      qtInput=input+'.padded.webp';await fs.writeFile(qtInput,Buffer.concat([sample.buffer,Buffer.alloc(2)]));
    }
    const qt=JSON.parse(execFileSync(path.resolve('.cache/qt-compat/qt-compat.exe'),['inspect-image',qtInput],options));expect(previews[i].pixel[3]).toBe(qt.pixel[3]);for(let c=0;c<3;c++)expect(Math.abs(previews[i].pixel[c]-Math.round(qt.pixel[c]*qt.pixel[3]/255))).toBeLessThanOrEqual(2);
  }
  await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)).toBe(1);await page.screenshot({path:info.outputPath('browser-images.png')});await page.locator('.file-tab.active .tab-close').click();await expect(page.locator('.file-tab')).toHaveCount(0);
  execFileSync(path.resolve('.cache/qt-compat/qt-compat.exe'),['edit',file],{windowsHide:true,env:{...process.env,QT_QPA_PLATFORM:'offscreen',PATH:'E:\\Qt\\6.8.3\\mingw_64\\bin;E:\\Qt\\Tools\\mingw1310_64\\bin;'+process.env.PATH}});
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();await expect(editor()).toContainText('旧版再次编辑');await expect(editor().locator('.image-view')).toHaveCount(6);saved().assets.forEach((a,i)=>expect(Buffer.from(a.data)).toEqual(samples[i].buffer));
});
for(const name of ['animated.gif','animated.webp'])test(`${name} plays both frames in the real editor`,async()=>{
  await insert([samples.find(f=>f.name===name)!]);const rect=await editor().locator('.image-view img').boundingBox(),win=await app.browserWindow(page),colors=new Set<string>();
  for(let i=0;i<20&&colors.size<2;i++){
    const p=await win.evaluate(async(win,r)=>{const image=await win.capturePage({x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)},{stayAwake:true}),size=image.getSize(),pixels=image.toBitmap(),offset=(Math.floor(size.height/2)*size.width+Math.floor(size.width/2))*4;return [pixels[offset+2],pixels[offset],pixels[offset+3]];},rect!);
    if(p[0]>p[1]+50)colors.add('red');if(p[1]>p[0]+50)colors.add('blue');await page.waitForTimeout(80);
  }expect([...colors].sort()).toEqual(['blue','red']);
});
test('cross-file image copy remaps assets, preserves animation and display size, and exports the first frame externally',async()=>{
  const sample=samples[5];await insert([sample]);await app.evaluate(({clipboard})=>clipboard.clear());await editor().evaluate((el:any)=>{const ed=el.editor;let pos=0;ed.state.doc.descendants((n:any,p:number)=>{if(n.type.name==='image')pos=p;});ed.view.dispatch(ed.state.tr.setNodeMarkup(pos,undefined,{...ed.state.doc.nodeAt(pos).attrs,width:16,height:12}));ed.commands.setNodeSelection(pos);ed.view.focus();});await page.keyboard.press('Control+c');
  await expect.poll(()=>app.evaluate(({clipboard})=>clipboard.readImage().getSize())).toEqual({width:32,height:24});const pixel=await app.evaluate(({clipboard})=>Array.from(clipboard.readImage().toBitmap().subarray(0,4)));expect(pixel).toEqual([30,80,180,255]);
  await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await expect(page.locator('.file-tab.active')).toContainText(/\d{8}_\d+/);const target=await page.evaluate(async data=>{const session=await window.desktop.session(),doc=await window.desktop.openRecent(session.tabs[session.active].path);await window.desktop.addAsset(doc.handle,new Uint8Array(data),1,1);return doc.path;},Array.from(samples[0].buffer));
  await editor().click();await page.keyboard.press('Control+v');await expect(editor().locator('.image-view')).toHaveCount(1);await expect(editor().locator('.image-view img')).toHaveCSS('width','16px');await expect.poll(()=>saved(target).events[0]?.content_html).toContain('asset:2');expect(Buffer.from(saved(target).assets[1].data)).toEqual(sample.buffer);
  await page.keyboard.press('Control+z');await expect(editor().locator('.image-view')).toHaveCount(0);await page.keyboard.press('Control+y');await expect(editor().locator('.image-view')).toHaveCount(1);
});
test('a decoder process crash leaves no partial batch or window and a subsequent import succeeds',async()=>{
  await holdDecoder();await page.locator('input[type=file]').setInputFiles([samples[0],samples[5]]);await expect.poll(()=>app.evaluate(()=>!!(globalThis as any).releaseDecoder)).toBe(true);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='TodoLine 图片解码')!.webContents.forcefullyCrashRenderer());await expect(page.locator('.toast')).toContainText('图片解码');await expect(editor().locator('.image-view')).toHaveCount(0);expect(saved().assets).toHaveLength(0);await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)).toBe(1);await releaseDecoder();await insert([samples[0],samples[5]]);
});
test('invalid compressed GIF data cancels the entire batch and the decoder remains usable',async()=>{
  const data=Buffer.from(samples[0].buffer),descriptor=13+(data[10]&128?3*2**((data[10]&7)+1):0);expect(data[descriptor]).toBe(0x2c);data[descriptor+10]=255;
  await page.locator('input[type=file]').setInputFiles([samples[3],{name:'broken.gif',mimeType:'image/gif',buffer:data}]);await expect(page.locator('.toast')).toContainText('broken.gif');expect(saved().assets).toHaveLength(0);await expect(editor().locator('.image-view')).toHaveCount(0);await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)).toBe(1);await insert([samples[0],samples[3]]);
});
test('decoder replies from the main editor are ignored and normal quit waits for a pending image',async()=>{
  await holdDecoder();await page.locator('input[type=file]').setInputFiles(samples[5]);await expect.poll(()=>app.evaluate(()=>!!(globalThis as any).releaseDecoder)).toBe(true);
  await app.evaluate(({BrowserWindow,ipcMain})=>{const main=BrowserWindow.getAllWindows().find(w=>w.getTitle()!=='TodoLine 图片解码')!;ipcMain.emit('tl:image:decoded',{sender:main.webContents,senderFrame:main.webContents.mainFrame},{error:'forged reply'});});await expect(page.locator('.statusbar')).toContainText('正在导入');expect(saved().assets).toHaveLength(0);
  const stopped=new Promise(resolve=>app.process().once('exit',resolve));await app.evaluate(({app})=>app.quit());await expect(editor()).toBeVisible();await releaseDecoder();await stopped;expect(Buffer.from(saved().assets[0].data)).toEqual(samples[5].buffer);expect(saved().events[0].content_html).toContain('asset:1');
});
test('PDF freezes animated assets on the first frame and keeps the completion dialog',async()=>{
  await insert([samples[1],samples[5]]);const output=path.join(root,'动图.pdf');await app.evaluate(({dialog,BrowserWindow},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});const original=BrowserWindow.prototype.loadURL;BrowserWindow.prototype.loadURL=async function(url,...args){await original.call(this,url,...args);if(url.startsWith('data:')&&decodeURIComponent(url).includes('<body>')){const originalPrint=this.webContents.printToPDF.bind(this.webContents);this.webContents.printToPDF=async options=>{(globalThis as any).printImages=await this.webContents.executeJavaScript('Array.from(document.images).map(i=>({src:i.src,width:i.naturalWidth,height:i.naturalHeight}))');return originalPrint(options);};}};},output);
  await page.getByRole('button',{name:'导出',exact:true}).click();await page.getByRole('button',{name:'PDF 文档 .pdf',exact:true}).click();await expect.poll(()=>fs.stat(output).then(s=>s.size,()=>0)).toBeGreaterThan(1000);const frames=await app.evaluate(()=>(globalThis as any).printImages);expect(frames).toHaveLength(2);for(const f of frames)expect(f).toMatchObject({src:expect.stringContaining('?still=1'),width:32,height:24});await expect(page.getByRole('dialog',{name:'导出完成'})).toContainText('动图.pdf');
});
