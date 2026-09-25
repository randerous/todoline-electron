import {searchWindow} from './search-window';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DocumentStore } from '../../src/main/storage';

const project=path.resolve('.');
let app:ElectronApplication,page:Page,file:string,root:string;
async function createFixture(dir:string,count=2){
  await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'兼容样本.tde');const store=new DocumentStore();const doc=store.open(file,true);
  await store.save({handle:doc.handle,revision:doc.revision,events:Array.from({length:count},(_,i)=>({id:-(i+1),pos:i*1024,created_at:1750000000+i*60,deadline_raw:'',deadline_ts:null,done:i===1?1:0,top_divider:i===0?1:0,content_html:`<p>${i===0?'你好，TodoLine。':i===1?'第二件事情。':'性能测试事件 '+i}</p>`,content_text:i===0?'你好，TodoLine。':i===1?'第二件事情。':'性能测试事件 '+i}))});store.close(doc.handle);return file;
}
async function launch(dir:string,fixture?:string){
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(dir,'profile')};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[project,...(fixture?['--open',fixture]:[])],env:env as Record<string,string>});
  const page=await app.firstWindow();page.on('pageerror',e=>console.error('RENDERER',e));await expect(page.locator('.app')).toBeVisible();return {app,page};
}
test.beforeEach(async({},info)=>{root=info.outputPath('workspace');file=await createFixture(root);({app,page}=await launch(root,file));await expect(page.locator('.todo-document')).toBeVisible();});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus&&page){console.log(await page.locator('.document-warning').allTextContents());console.log(await page.locator('.todo-document').first().evaluate((el:any)=>({doc:el.editor.getJSON(),selection:el.editor.state.selection.toJSON(),active:document.activeElement?.outerHTML.slice(0,150)})).catch(()=>{}));await page.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});}await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
async function saved(){await expect(page.locator('.statusbar')).toContainText('已保存到本地');}
async function focusBody(){await page.locator('.todo-document p').first().click();}
test('first divider, undo, backspace and persistence',async()=>{
  await focusBody();await page.keyboard.press('Control+a');await page.keyboard.press('ArrowLeft');await expect(page.locator('.ProseMirror-gapcursor')).toHaveCount(1);await page.keyboard.press('Delete');await expect(page.locator('.event-divider')).toHaveCount(1);await expect(page.locator('.todo-document')).toContainText('你好，TodoLine。');await page.keyboard.press('Control+z');await expect(page.locator('.event-divider')).toHaveCount(2);
  await focusBody();await page.keyboard.press('Home');await page.keyboard.press('Backspace');await expect(page.locator('.event-divider')).toHaveCount(1);await saved();
  await expect.poll(()=>{const db=new Database(file,{readonly:true});const row=db.prepare('select top_divider from events order by pos limit 1').get() as {top_divider:number};db.close();return row.top_divider;}).toBe(0);
});
test('typing, formatting, split and tab switching retain one editor',async()=>{
  await focusBody();await page.keyboard.press('Control+End');await page.keyboard.press('Enter');await page.keyboard.type('saved text');await page.keyboard.press('Control+h');await page.keyboard.type('third event');await expect(page.locator('.event-divider')).toHaveCount(3);await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await expect(page.locator('.file-tab')).toHaveCount(2);await page.locator('.tab-name').first().click();await expect(page.locator('.document-scroller:visible')).toContainText('third event');await saved();await page.screenshot({path:path.join(root,'workbench.png')});
});
test('save conflict leaves edits pending and close waits',async()=>{
  const db=new Database(file);db.prepare('update events set content_text=?,content_html=? where id=(select id from events order by pos limit 1)').run('旧版修改','<p>旧版修改</p>');db.close();await focusBody();await page.keyboard.press('End');await page.keyboard.type(' new edit');await expect(page.locator('.document-warning')).toBeVisible();await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await expect(page.locator('.todo-document')).toBeVisible();await expect(page.locator('.todo-document')).toContainText('new edit');const check=new Database(file,{readonly:true});expect((check.prepare('select content_text from events order by pos limit 1').get() as any).content_text).toBe('旧版修改');check.close();
});
test('search, themes, completion and deadline parsing',async()=>{
  await page.getByRole('button',{name:'搜索 · Ctrl+F',exact:true}).click();await (await searchWindow(app)).getByRole('textbox',{name:'搜索内容'}).fill('第二');await expect((await searchWindow(app)).locator('.search-bar')).toContainText('1 个事件');await (await searchWindow(app)).getByRole('button',{name:'关闭搜索',exact:true}).click();await page.locator('.event-deadline').first().fill('明天下午3点');await page.locator('.event-deadline').first().press('Enter');await expect(page.locator('.countdown').first()).not.toBeEmpty();await page.locator('.event-check').first().click();await saved();await page.getByRole('button',{name:'外观与设置',exact:true}).click();await page.getByRole('button',{name:'浅色',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');
});
test('exports all formats and offers to reveal the file from a themed card',async()=>{
  await app.evaluate(({shell})=>{(globalThis as any).revealed='';shell.showItemInFolder=(file:string)=>{(globalThis as any).revealed=file;};});
  for(const format of ['md','txt','pdf']){
    const out=path.join(root,'导出.'+format);
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});(globalThis as any).revealed='';},out);
    await page.getByRole('button',{name:'导出',exact:true}).click();await page.getByRole('button',{name:format==='md'?'Markdown .md':format==='txt'?'纯文本 .txt':'PDF 文档 .pdf',exact:true}).click();
    await expect.poll(async()=>{try{return (await fs.stat(out)).size;}catch{return 0;}}).toBeGreaterThan(format==='pdf'?1000:10);
    const card=page.getByRole('dialog',{name:'导出完成'});await expect(card).toContainText('导出.'+format);await expect(card).toContainText(out);
    await card.getByRole('button',{name:'打开所在文件夹'}).click();await expect(card).toBeHidden();
    await expect.poll(()=>app.evaluate(()=>(globalThis as any).revealed)).toBe(out);
    if(format!=='pdf')expect(await fs.readFile(out,'utf8')).toContain('你好，TodoLine。');
  }
});
test('session restores cursor, document and theme after restart',async()=>{
  await focusBody();await page.keyboard.press('Control+End');await page.keyboard.type(' 恢复内容');await saved();await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await app.waitForEvent('close');({app,page}=await launch(root));await expect(page.locator('.todo-document')).toContainText('恢复内容');
});
test('image dimensions, original clipboard, cross-file assets and resize undo',async()=>{
  const bytes=await app.evaluate(({nativeImage})=>nativeImage.createFromBitmap(Buffer.alloc(800*600*4,220),{width:800,height:600}).toPNG().toString('base64'));
  const input=path.join(root,'原图.png');await fs.writeFile(input,Buffer.from(bytes,'base64'));
  await focusBody();await page.keyboard.press('End');await page.locator('.todo-document').evaluate((el,bytes)=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(bytes)],'原图.png',{type:'image/png'}));const r=el.getBoundingClientRect();el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+20,clientY:r.top+50}));},Array.from(Buffer.from(bytes,'base64')));const image=page.locator('.document-scroller:visible .image-view img');await expect(image).toBeVisible();await image.click();const before=await image.evaluate((img:HTMLImageElement)=>({width:img.style.width,height:img.style.height}));const grip=page.locator('.document-scroller:visible .grip-4');const box=await grip.boundingBox();await page.mouse.move(box!.x+3,box!.y+3);await page.mouse.down();await page.mouse.move(box!.x-50,box!.y-35,{steps:8});await page.mouse.up();await expect.poll(()=>image.evaluate((img:HTMLImageElement)=>img.style.width)).not.toBe(before.width);await page.keyboard.press('Control+z');await expect.poll(()=>image.evaluate((img:HTMLImageElement)=>img.style.width)).toBe(before.width);
  await app.evaluate(({clipboard})=>clipboard.clear());await image.click();await page.keyboard.press('Control+c');await expect.poll(()=>app.evaluate(({clipboard})=>({width:clipboard.readImage().getSize().width,text:clipboard.readText(),custom:clipboard.readBuffer('application/x-tde-events').length>0}))).toEqual({width:800,text:'[图片]',custom:true});
  await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await expect(page.locator('.file-tab.active')).toContainText(/\d{8}_\d+/);await page.locator('.document-scroller').last().locator('.todo-document').click();await page.keyboard.press('Control+v');await expect(page.locator('.document-scroller:visible .image-view img')).toBeVisible();await saved();
  const source=await page.locator('.document-scroller:visible .image-view img').getAttribute('src');const [,handle,id]=new URL(source!).pathname.split('/');const data=await page.evaluate(async({handle,id})=>Array.from((await window.desktop.asset(handle,Number(id)))!.data),{handle,id});expect(createHash('sha256').update(Buffer.from(data)).digest('hex')).toBe(createHash('sha256').update(Buffer.from(bytes,'base64')).digest('hex'));
});
test('Chinese composition retains the same editor DOM',async()=>{
  await focusBody();await page.keyboard.press('End');await page.locator('.todo-document').evaluate(el=>(window as any).compositionNode=el);const cdp=await page.context().newCDPSession(page);await cdp.send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});await cdp.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});await cdp.send('Input.insertText',{text:'中文'});expect(await page.locator('.todo-document').evaluate(el=>el===(window as any).compositionNode)).toBe(true);await expect(page.locator('.todo-document')).toContainText('中文');await saved();
});
test('Qt create → Electron edit → Qt edit → Electron reopen',async()=>{
  const harness=path.join(project,'.cache/qt-compat/qt-compat.exe');
  const env={...process.env,PATH:'E:\\Qt\\6.8.3\\mingw_64\\bin;E:\\Qt\\Tools\\mingw1310_64\\bin;'+process.env.PATH,QT_QPA_PLATFORM:'offscreen'};
  const roundtrip=path.join(root,'Qt-roundtrip.tde');execFileSync(harness,['create',roundtrip],{env,windowsHide:true});
  const read=()=>{const db=new Database(roundtrip,{readonly:true});const events=db.prepare('select * from events order by pos').all() as any[],assets=db.prepare('select * from assets order by id').all() as any[];db.close();return {events,assets};};const original=read();
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},roundtrip);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();const doc=page.locator('.document-scroller:visible .todo-document');await expect(doc).toContainText('旧版创建');await doc.locator('p').first().click();await page.keyboard.press('End');await page.keyboard.type(' Electron edit');await saved();await expect.poll(()=>read().events[0].content_html).toContain('Electron edit');await page.locator('.file-tab.active .tab-close').click();
  const beforeQt=read();for(const key of ['id','pos','created_at','deadline_raw','deadline_ts','done','top_divider'])expect(beforeQt.events[0][key]).toEqual(original.events[0][key]);expect(beforeQt.assets).toEqual(original.assets);expect(beforeQt.events[0].content_html).toMatch(/<strong>|font-weight:700/);expect(beforeQt.events[0].content_html).toMatch(/cc5577|rgb\(204, 85, 119\)/);
  execFileSync(harness,['edit',roundtrip],{env,windowsHide:true});await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();await expect(doc).toContainText('旧版再次编辑');await expect(doc).toContainText('Electron edit');const final=read();expect(final.assets).toEqual(original.assets);expect(final.events[0].content_html).toContain('width="240"');expect(final.events[0].content_html).toContain('height="180"');expect(final.events[0].content_html).toContain('font-weight:700');
});
test('cross-event cut can be undone after the deletion was saved',async()=>{
  await focusBody();await page.keyboard.press('Control+a');await page.keyboard.press('Control+x');await expect(page.locator('.todo-document')).not.toContainText('第二件事情');await saved();await page.keyboard.press('Control+z');await expect(page.locator('.todo-document')).toContainText('第二件事情');await expect(page.locator('.event-divider')).toHaveCount(2);await saved();
});
test('failed-save journal restores after process termination without overwriting external edits',async()=>{
  const db=new Database(file);db.prepare('update events set content_text=?,content_html=? where id=1').run('external','<p>external</p>');db.close();await focusBody();await page.keyboard.press('End');await page.keyboard.type(' crash recovery');await expect(page.locator('.document-warning')).toBeVisible();await app.evaluate(({app})=>app.exit(0));({app,page}=await launch(root));await expect(page.locator('.todo-document')).toContainText('crash recovery');await expect(page.locator('.document-warning')).toContainText('磁盘版本也有变化');const check=new Database(file,{readonly:true});expect((check.prepare('select content_text from events where id=1').get() as any).content_text).toBe('external');check.close();
});
test('Ctrl+line-number selection deletes multiple rows in one undo transaction',async()=>{
  await page.getByRole('button',{name:'第 2 行',exact:true}).click();await page.getByRole('button',{name:'第 4 行',exact:true}).click({modifiers:['Control']});await expect(page.locator('.row-selection')).toHaveCount(2);await page.keyboard.press('Delete');await expect(page.locator('.todo-document')).not.toContainText('你好');await page.keyboard.press('Control+z');await expect(page.locator('.todo-document')).toContainText('你好');await expect(page.locator('.todo-document')).toContainText('第二件事情');
});
test('Alt+drag column selection inserts text across selected rows and undoes once',async()=>{
  await focusBody();await page.keyboard.press('Control+a');await page.keyboard.type('abcdef');await page.keyboard.press('Enter');await page.keyboard.type('ghijkl');await page.keyboard.press('Enter');await page.keyboard.type('mnopqr');const a=await page.locator('.todo-document p').nth(0).boundingBox(),b=await page.locator('.todo-document p').nth(2).boundingBox();await page.keyboard.down('Alt');await page.mouse.move(a!.x+8,a!.y+10);await page.mouse.down();await page.mouse.move(b!.x+28,b!.y+10,{steps:8});await page.mouse.up();await page.keyboard.up('Alt');await expect(page.locator('.column-selection')).toHaveCount(3);await page.keyboard.type('Z');await expect.poll(()=>page.locator('.todo-document').innerText()).toMatch(/Z[\s\S]*Z[\s\S]*Z/);await page.keyboard.press('Control+z');await expect(page.locator('.todo-document')).toContainText('abcdef');await expect(page.locator('.todo-document')).toContainText('mnopqr');
});
test('PDF print page waits for Chinese text, pagination and image decoding',async()=>{
  await focusBody();await page.keyboard.press('Control+End');const bytes=await app.evaluate(({nativeImage})=>{const pixels=Buffer.alloc(800*600*4);for(let i=0;i<pixels.length;i+=4){pixels[i]=190;pixels[i+1]=115;pixels[i+2]=55;pixels[i+3]=255;}return nativeImage.createFromBitmap(pixels,{width:800,height:600}).toPNG().toString('base64');});const img=path.join(root,'pdf-image.png');await fs.writeFile(img,Buffer.from(bytes,'base64'));await page.locator('input[type=file]').setInputFiles(img);await expect(page.locator('.image-view img')).toBeVisible();await page.locator('.todo-document').evaluate((el:any)=>el.editor.commands.insertContentAt(el.editor.state.doc.content.size,Array.from({length:85},(_,i)=>({type:'paragraph',content:[{type:'text',text:`分页测试第 ${i+1} 行：中文、English、标点与完整图片。`}]}))));await saved();const out=path.join(root,'中文分页图片.pdf');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});dialog.showMessageBox=(async()=>({response:1,checkboxChecked:false})) as typeof dialog.showMessageBox;},out);await page.getByRole('button',{name:'导出',exact:true}).click();await page.getByRole('button',{name:'PDF 文档 .pdf',exact:true}).click();await expect.poll(async()=>{try{return (await fs.stat(out)).size;}catch{return 0;}},{timeout:20000}).toBeGreaterThan(10000);
});

test('the deadline field is centered, keeps no focus ring and commits when the caret leaves',async()=>{
  const deadline=page.locator('.event-deadline').first();
  await expect(deadline).toHaveAttribute('title',/输入截止时间/);
  const resting=await deadline.evaluate(el=>getComputedStyle(el).color);
  await deadline.click();
  expect(await deadline.evaluate(el=>getComputedStyle(el).textAlign)).toBe('center');
  expect(await deadline.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('none');
  // editing tints the text instead of underlining or filling the field, and drops the hint
  expect(await deadline.evaluate(el=>getComputedStyle(el).borderBottomWidth)).toBe('0px');
  expect(await deadline.evaluate(el=>getComputedStyle(el,'::placeholder').color)).toBe('rgba(0, 0, 0, 0)');
  await expect(deadline).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await expect(deadline).not.toHaveCSS('color',resting);
  await page.keyboard.type('明天下午3点');await expect(page.locator('.countdown').first()).toBeEmpty();
  await focusBody();await expect(page.locator('.countdown').first()).not.toBeEmpty();await saved();
  await expect.poll(()=>{const db=new Database(file,{readonly:true});try{return (db.prepare('select deadline_raw from events order by pos limit 1').get() as {deadline_raw:string}).deadline_raw;}finally{db.close();}}).toBe('明天下午3点');
  await expect(deadline).toHaveAttribute('title',/已识别截止时间/);
});
const deadlineRow=()=>{const db=new Database(file,{readonly:true});try{return db.prepare('select deadline_ts,deadline_raw from events order by pos limit 1').get() as {deadline_ts:number|null;deadline_raw:string};}finally{db.close();}};
async function settle(match:(row:{deadline_ts:number|null;deadline_raw:string})=>unknown){await expect.poll(()=>!!match(deadlineRow()),{timeout:15000}).toBe(true);return deadlineRow();}
test('a relative deadline restarts from the moment the caret leaves while a fixed date stays put',async()=>{
  const deadline=page.locator('.event-deadline').first();
  await deadline.click();await page.keyboard.type('1分钟后');await focusBody();
  const first=await settle(row=>row.deadline_raw==='1分钟后'&&row.deadline_ts);
  await page.waitForTimeout(3000);
  await deadline.click();await focusBody();
  const again=await settle(row=>row.deadline_ts!==first.deadline_ts);
  expect(again.deadline_raw).toBe('1分钟后');
  expect(again.deadline_ts!-first.deadline_ts!).toBeGreaterThanOrEqual(2);
  expect(Math.abs(again.deadline_ts!-Math.floor(Date.now()/1000)-60)).toBeLessThanOrEqual(3);
  await deadline.click();await page.keyboard.press('Control+a');await page.keyboard.type('2026-12-31 08:00');await focusBody();
  const fixed=await settle(row=>row.deadline_raw==='2026-12-31 08:00'&&row.deadline_ts);
  await page.waitForTimeout(2000);
  await deadline.click();await focusBody();await page.waitForTimeout(1200);
  expect(deadlineRow().deadline_ts).toBe(fixed.deadline_ts);
});
test('a long document offers one click back to the top without moving the caret',async()=>{
  await focusBody();await page.keyboard.press('Control+End');
  await page.locator('.todo-document').evaluate((el:any)=>el.editor.commands.insertContentAt(el.editor.state.doc.content.size,Array.from({length:60},(_,i)=>({type:'paragraph',content:[{type:'text',text:`滚动测试第 ${i+1} 行`}]}))));
  await expect(page.locator('.scroll-top')).toHaveCount(0);
  const scroller=page.locator('.document-scroller[data-active]');
  await scroller.evaluate(el=>el.scrollTo(0,800));
  await expect(page.locator('.scroll-top')).toBeVisible();
  const caret=await page.locator('.todo-document').evaluate((el:any)=>el.editor.state.selection.from);
  await page.locator('.scroll-top').click();
  await expect.poll(()=>scroller.evaluate(el=>el.scrollTop)).toBe(0);
  await expect(page.locator('.scroll-top')).toHaveCount(0);
  expect(await page.locator('.todo-document').evaluate((el:any)=>el.editor.state.selection.from)).toBe(caret);
});
