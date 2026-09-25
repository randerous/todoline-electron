import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DocumentStore } from '../../src/main/storage';

let app:ElectronApplication,page:Page,root:string,source:string;
test.beforeEach(async({},info)=>{
  root=info.outputPath('workspace');const profile=path.join(root,'profile');await fs.mkdir(profile,{recursive:true});
  const paths:string[]=[];
  for(const name of ['甲','乙','丙']){
    const file=path.join(root,name+'.tde'),store=new DocumentStore(),doc=store.open(file,true);paths.push(file);
    await store.save({handle:doc.handle,revision:doc.revision,events:[{id:-1,pos:0,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:1,content_html:`<p>${name}文档正文</p>`,content_text:`${name}文档正文`}]});store.close(doc.handle);
  }
  source=paths[1];await fs.writeFile(path.join(profile,'session.json'),JSON.stringify({tabs:paths.map(file=>({path:file,cursor:2,scroll:0})),active:1,recent:paths}));
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({args:[path.resolve('.')],env:env as Record<string,string>});page=await app.firstWindow();page.on('pageerror',e=>console.error(e));await expect(page.locator('.file-tab')).toHaveCount(3);await expect(page.locator('.file-tab.active')).toContainText('乙');
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
const editor=()=>page.locator('.document-scroller:visible .todo-document');
function diskText(file:string){const db=new Database(file,{readonly:true});try{return (db.prepare('select content_text from events').get() as {content_text:string}).content_text;}finally{db.close();}}
async function setDestination(destination:string|null){await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>file?{canceled:false,filePath:file}:{canceled:true,filePath:''};},destination);}
async function saveAs(){await page.locator('.file-tab.active').click({button:'right'});await page.getByRole('button',{name:'另存为… Ctrl Shift S',exact:true}).click();}

test('Save As preserves tab position, editor identity, image loading and undo history',async()=>{
  const png=await app.evaluate(({nativeImage})=>nativeImage.createFromBitmap(Buffer.from([55,115,190,255]),{width:1,height:1}).toPNG().toString('base64'));
  const image=path.join(root,'原图.png');await fs.writeFile(image,Buffer.from(png,'base64'));await editor().locator('p').click();await page.locator('input[type=file]').setInputFiles(image);await expect(editor().locator('.image-view img')).toBeVisible();await expect(page.locator('.statusbar')).toContainText('已保存到本地');
  await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 新写入');await expect(page.locator('.statusbar')).toContainText('已保存到本地');
  const node=await editor().elementHandle(),oldImage=await editor().locator('.image-view img').getAttribute('src');const destination=path.join(root,'乙另存.tde');await setDestination(destination);await saveAs();
  await expect(page.locator('.file-tab.active')).toContainText('乙另存');expect(await node!.evaluate(el=>el.isConnected)).toBe(true);await expect(page.locator('.file-tab').nth(1)).toHaveClass(/active/);await expect(page.locator('.file-tab')).toHaveCount(3);
  await expect.poll(()=>editor().locator('.image-view img').getAttribute('src')).not.toBe(oldImage);await expect.poll(()=>editor().locator('.image-view img').evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBe(1);
  await editor().locator('p').click();await page.keyboard.press('Control+z');await expect(editor()).not.toContainText('新写入');await expect(editor().locator('.image-view img')).toBeVisible();await expect(page.locator('.statusbar')).toContainText('已保存到本地');
  await expect.poll(()=>diskText(destination)).not.toContain('新写入');expect(diskText(source)).toContain('新写入');
  const old=new Database(source,{readonly:true}),copy=new Database(destination,{readonly:true});expect(old.prepare('select data from assets').get()).toEqual(copy.prepare('select data from assets').get());old.close();copy.close();
});

test('canceling and failing Save As restore the same editable source tab',async()=>{
  const node=await editor().elementHandle();await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 待保存');
  await setDestination(null);await saveAs();await expect(editor()).toHaveAttribute('contenteditable','true');await expect(editor()).toContainText('待保存');expect(await node!.evaluate(el=>el.isConnected)).toBe(true);
  await setDestination(path.join(root,'不存在的目录','目标.tde'));await saveAs();await expect(page.locator('.toast')).toBeVisible();await expect(editor()).toHaveAttribute('contenteditable','true');await expect(page.locator('.file-tab.active')).toContainText('乙');await expect(editor()).toContainText('待保存');
});

test('rename keeps the active middle tab and its existing undo history',async()=>{
  await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 修改');await expect(page.locator('.statusbar')).toContainText('已保存到本地');const node=await editor().elementHandle();const destination=path.join(root,'已改名.tde');await setDestination(destination);
  await page.locator('.file-tab.active').click({button:'right'});await page.getByRole('button',{name:'重命名…',exact:true}).click();await page.getByRole('textbox',{name:'新文件名'}).fill('已改名');await page.getByRole('textbox',{name:'新文件名'}).press('Enter');await expect(page.locator('.file-tab').nth(1)).toContainText('已改名');await expect(page.locator('.file-tab').nth(1)).toHaveClass(/active/);expect(await node!.evaluate(el=>el.isConnected)).toBe(true);expect(await fs.stat(source).then(()=>true,()=>false)).toBe(false);
  await editor().locator('p').click();await page.keyboard.press('Control+z');await expect(editor()).not.toContainText('修改');await expect(page.locator('.statusbar')).toContainText('已保存到本地');
});

test('a source removal failure keeps both files and a usable destination tab',async()=>{
  const destination=path.join(root,'保留副本.tde');await setDestination(destination);
  await app.evaluate((_,source)=>{const fs=process.getBuiltinModule('fs').promises;const original=fs.unlink;fs.unlink=async(file)=>{if(file===source){const error:any=new Error('simulated delete denial');error.code='EACCES';throw error;}return original(file);};},source);
  await page.locator('.file-tab.active').click({button:'right'});await page.getByRole('button',{name:'重命名…',exact:true}).click();await page.getByRole('textbox',{name:'新文件名'}).fill('保留副本');await page.getByRole('textbox',{name:'新文件名'}).press('Enter');await expect(page.locator('.file-tab.active')).toContainText('保留副本');await expect(page.locator('.document-warning')).toContainText('保留两份文件');expect(await fs.stat(source).then(()=>true,()=>false)).toBe(true);expect(await fs.stat(destination).then(()=>true,()=>false)).toBe(true);
  await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 可以继续编辑');await expect(page.locator('.statusbar')).toContainText('已保存到本地');
});

test('recovery cleanup failure acknowledges committed data and permits subsequent saves',async()=>{
  await app.evaluate(()=>{const fs=process.getBuiltinModule('fs').promises,original=fs.rm;fs.rm=async(file,options)=>{if(String(file).includes('recovery'))throw new Error('simulated journal cleanup failure');return original(file,options);};});
  await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 已提交');
  await expect.poll(()=>diskText(source)).toContain('已提交');await expect(page.locator('.document-warning')).toContainText('正文已保存');
  await page.keyboard.type(' 第二次保存');await expect.poll(()=>diskText(source)).toContain('第二次保存');
  const destination=path.join(root,'清理失败仍可另存.tde');await setDestination(destination);await saveAs();await expect(page.locator('.file-tab.active')).toContainText('清理失败仍可另存');await expect(editor()).toHaveAttribute('contenteditable','true');expect(diskText(destination)).toContain('第二次保存');
});

test('closing with a failed save keeps the window open and restores editing',async()=>{
  await page.evaluate(async()=>{const session=await window.desktop.session();await window.desktop.updateSession({settings:{...session.settings,closeToTray:false}});});
  await app.evaluate(()=>{const fs=process.getBuiltinModule('fs').promises,original=fs.open;fs.open=async(file,...args)=>{if(String(file).includes('recovery'))throw new Error('simulated disk full');return original(file,...args);};});
  await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 不能丢失');
  await page.evaluate(()=>window.desktop.requestClose());await expect(page.locator('.toast')).toContainText('窗口已保持打开');await expect(page.locator('main.app')).not.toHaveAttribute('inert');await expect(editor()).toHaveAttribute('contenteditable','true');await expect(editor()).toContainText('不能丢失');
  await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 仍可编辑');await expect(editor()).toContainText('仍可编辑');expect(diskText(source)).not.toContain('不能丢失');
});

test('reload after crash recovery preserves a tde copy, clears conflict and does not replay stale edits',async()=>{
  const external=new Database(source);external.prepare('update events set content_html=?,content_text=?').run('<p>磁盘外部修改</p>','磁盘外部修改');external.close();
  await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 内存待恢复');await expect(page.locator('.document-warning')).toBeVisible();
  await app.evaluate(({app})=>app.exit(0));const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({args:[path.resolve('.')],env:env as Record<string,string>});page=await app.firstWindow();await expect(page.locator('.document-warning')).toContainText('磁盘版本也有变化');
  await page.getByRole('button',{name:'重新加载',exact:true}).click();await expect(editor()).toContainText('磁盘外部修改');await expect(editor()).not.toContainText('内存待恢复');await expect(page.getByRole('button',{name:'查看恢复文档'})).toBeVisible();await expect(page.locator('.file-tab').nth(1)).toHaveClass(/active/);
  const dir=path.join(root,'profile','recovery','documents'),files=await fs.readdir(dir);expect(files).toHaveLength(1);expect(diskText(path.join(dir,files[0]))).toContain('内存待恢复');
  await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 继续保存');await expect.poll(()=>diskText(source)).toContain('继续保存');
  await app.evaluate(({app})=>app.exit(0));app=await _electron.launch({args:[path.resolve('.')],env:env as Record<string,string>});page=await app.firstWindow();await expect(editor()).toContainText('继续保存');await expect(editor()).not.toContainText('内存待恢复');await expect(page.locator('.document-warning')).toHaveCount(0);
});

test('reload archive failure retains the current editor and leaves a complete recovery copy',async()=>{
  const external=new Database(source);external.prepare('update events set content_html=?,content_text=?').run('<p>磁盘</p>','磁盘');external.close();
  await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 编辑仍在');await expect(page.locator('.document-warning')).toBeVisible();const dom=await editor().elementHandle();
  await app.evaluate(()=>{const fs=process.getBuiltinModule('fs').promises,original=fs.rename;fs.rename=async(from,to)=>{if(String(to).includes('archived'))throw new Error('simulated archive failure');return original(from,to);};});
  await page.getByRole('button',{name:'重新加载',exact:true}).click();await expect(page.locator('.toast')).toContainText('重新加载未完成');expect(await dom!.evaluate(el=>el.isConnected)).toBe(true);await expect(editor()).toContainText('编辑仍在');await expect(editor()).toHaveAttribute('contenteditable','true');expect(diskText(source)).toBe('磁盘');
  const dir=path.join(root,'profile','recovery','documents'),files=await fs.readdir(dir);expect(diskText(path.join(dir,files[0]))).toContain('编辑仍在');
});
