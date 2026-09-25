import {searchWindow} from './search-window';
import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {DocumentStore} from '../../src/main/storage';

let app:ElectronApplication,page:Page,profile:string,files:string[];
test.beforeEach(async({},info)=>{
  const root=info.outputPath('workspace');profile=path.join(root,'profile');await fs.mkdir(profile,{recursive:true});files=[];
  for(let i=0;i<3;i++){
    const file=path.join(root,`启动 ${i}.tde`),store=new DocumentStore(),doc=store.open(file,true);files.push(file);
    await store.save({...doc,events:Array.from({length:80},(_,j)=>({id:-j-1,pos:j*1024,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:j===0?1:0,content_html:`<p>文件 ${i} 的事件 ${j}</p>`,content_text:`文件 ${i} 的事件 ${j}`}))});store.close(doc.handle);
  }
  await fs.writeFile(path.join(profile,'session.json'),JSON.stringify({tabs:files.map(path=>({path,cursor:6,scroll:300})),active:1,recent:files}));
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
async function launch(selector='.todo-document'){
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.TODOLINE_TEST_EXE;
  app=await _electron.launch({...(executablePath?{executablePath}:{}),args:executablePath?[]:[path.resolve('.')],env:env as Record<string,string>});page=await app.firstWindow();await expect(page.locator(selector)).toBeVisible();
}
const editor=()=>page.locator('.document-scroller[data-active] .todo-document');

test('restores only the active editor, then retains visited editors, cursor, scroll and undo',async()=>{
  await launch();await expect(page.locator('.file-tab')).toHaveCount(3);await expect(page.locator('.file-tab.active')).toContainText('启动 1');
  await expect(page.locator('.todo-document')).toHaveCount(1);
  expect(await editor().evaluate((el:any)=>el.editor.state.selection.from)).toBe(6);
  expect(await page.locator('.document-scroller[data-active]').evaluate(el=>el.scrollTop)).toBe(300);
  const original=await editor().elementHandle();
  await editor().evaluate((el:any)=>{el.editor.commands.setTextSelection(6);el.editor.commands.insertContent('保留编辑');});
  await page.locator('.tab-name').first().click();await expect(page.locator('.todo-document')).toHaveCount(2);
  expect(await editor().evaluate((el:any)=>el.editor.state.selection.from)).toBe(6);
  expect(await page.locator('.document-scroller[data-active]').evaluate(el=>el.scrollTop)).toBe(300);
  await page.locator('.tab-name').nth(1).click();expect(await original!.evaluate(el=>el.isConnected)).toBe(true);
  await expect(editor()).toContainText('保留编辑');await editor().evaluate((el:any)=>el.editor.commands.undo());await expect(editor()).not.toContainText('保留编辑');
  await page.getByRole('button',{name:'关闭 启动 2.tde',exact:true}).click();await expect(page.locator('.file-tab')).toHaveCount(2);await expect(page.locator('.todo-document')).toHaveCount(2);
});

test('a missing preceding file does not change the restored active file',async()=>{
  await fs.unlink(files[0]);await launch();await expect(page.locator('.file-tab')).toHaveCount(2);await expect(page.locator('.file-tab.active')).toContainText('启动 1');await expect(page.locator('.todo-document')).toHaveCount(1);await expect(page.locator('.toast')).toContainText('无法打开文件');
});

test('search locates and highlights an event in a never-visited tab',async()=>{
  await launch();await page.getByRole('button',{name:'搜索 · Ctrl+F',exact:true}).click();
  await (await searchWindow(app)).getByRole('button',{name:'所有打开文件',exact:true}).click();await (await searchWindow(app)).getByRole('textbox',{name:'搜索内容'}).fill('文件 2 的事件 17');
  await expect(page.locator('.file-tab.active')).toContainText('启动 2');await expect(editor().locator('.search-match')).toHaveCount(1);await expect(page.locator('.todo-document')).toHaveCount(2);
});

test('a reminder completes and saves an unvisited background tab without activating it',async()=>{
  const db=new Database(files[0]);db.prepare('update events set deadline_ts=? where pos=0').run(Math.floor(Date.now()/1000)-60);db.close();
  await launch();await expect(page.locator('.todo-document')).toHaveCount(1);
  await expect.poll(()=>app.windows().some(p=>p.url().includes('reminder.html'))).toBe(true);
  const popup=app.windows().find(p=>p.url().includes('reminder.html'))!;
  await popup.getByRole('button',{name:'已完成',exact:true}).click();
  await expect.poll(()=>{const saved=new Database(files[0],{readonly:true});try{return (saved.prepare('select done from events where pos=0').get() as {done:number}).done;}finally{saved.close();}}).toBe(1);
  await expect(page.locator('.file-tab.active')).toContainText('启动 1');await expect(page.locator('.todo-document')).toHaveCount(2);
  await page.locator('.tab-name').first().click();await editor().evaluate((el:any)=>el.editor.commands.undo());
  await expect.poll(()=>{const saved=new Database(files[0],{readonly:true});try{return (saved.prepare('select done from events where pos=0').get() as {done:number}).done;}finally{saved.close();}}).toBe(0);
});


test('restoring tabs preserves the global recent order without rewriting it for each open',async()=>{
  const before=JSON.parse(await fs.readFile(path.join(profile,'session.json'),'utf8'));before.recent=[files[2],files[0],files[1]];
  await fs.writeFile(path.join(profile,'session.json'),JSON.stringify(before));await launch();
  expect(await page.evaluate(()=>window.desktop.session().then(s=>s.recent))).toEqual(before.recent);
});

test('empty startup avoids SQLite and starts it on first new TDE document',async()=>{
  await fs.writeFile(path.join(profile,'session.json'),JSON.stringify({tabs:[],recent:[],settings:{advanceMinutes:-1}}));await launch('.welcome');
  const workers=()=>app.evaluate(({app})=>app.getAppMetrics().filter(m=>m.name==='TodoLine 数据库').length);
  expect(await workers()).toBe(0);await page.locator('.welcome-actions .primary').click();await expect(editor()).toBeVisible();await expect.poll(workers).toBe(1);
  await editor().evaluate((el:any)=>el.editor.commands.insertContent('按需启动后可以保存'));
  await expect.poll(async()=>{const session=await page.evaluate(()=>window.desktop.session());const file=session.recent[0];if(!file)return '';const db=new Database(file,{readonly:true});try{return (db.prepare('select content_text from events limit 1').get() as any)?.content_text??'';}finally{db.close();}}).toContain('可以保存');
});

test('Markdown-only startup avoids SQLite and unused formula/highlight resources',async()=>{
  const file=path.join(profile,'说明.md');await fs.writeFile(file,'# 标题\n\n**正文** 和链接 [测试](https://example.com)');
  await fs.writeFile(path.join(profile,'session.json'),JSON.stringify({tabs:[{path:file,cursor:3,scroll:0}],active:0,recent:[file],settings:{advanceMinutes:-1}}));await launch('.markdown-document');
  expect(await app.evaluate(({app})=>app.getAppMetrics().filter(m=>m.name==='TodoLine 数据库'))).toHaveLength(0);
  const resources=await page.evaluate(()=>performance.getEntriesByType('resource').map(e=>e.name));expect(resources.some(r=>/\/(?:katex-|markdown-highlight-)/.test(r))).toBe(false);
  await page.locator('.markdown-document').evaluate((el:any)=>el.editor.commands.insertContent('已修改'));
  await expect.poll(()=>fs.readFile(file,'utf8')).toContain('已修改');
});
