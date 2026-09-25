import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {DocumentStore} from '../../src/main/storage';
let app:ElectronApplication,page:Page,root:string,profile:string,source:string,env:NodeJS.ProcessEnv;
test.beforeEach(async({},info)=>{
  root=info.outputPath('workspace');profile=path.join(root,'profile');await fs.mkdir(profile,{recursive:true});source=path.join(root,'Original.tde');
  const store=new DocumentStore(),doc=store.open(source,true);await store.save({...doc,events:Array.from({length:3},(_,i)=>({id:-(i+1),pos:i*1024,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:i===0?1:0,content_html:`<p>原文 ${i+1}</p>`,content_text:`原文 ${i+1}`}))});store.close(doc.handle);
  await fs.writeFile(path.join(profile,'session.json'),JSON.stringify({tabs:[{path:source,cursor:2,scroll:0}],active:0,recent:[source]}));
  env={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
async function launch(){const executablePath=process.env.TODOLINE_TEST_EXE;app=await _electron.launch({...(executablePath?{executablePath}:{}),args:executablePath?[]:[path.resolve('.')],env:env as Record<string,string>});page=await app.firstWindow();await expect(page.locator('.todo-document')).toBeVisible();}
async function begin(){await page.locator('.file-tab.active').click({button:'right'});await page.getByRole('button',{name:'重命名…',exact:true}).click();await expect(input()).toBeFocused();}
const input=()=>page.getByRole('textbox',{name:'新文件名'});
async function rename(name:string){await begin();await input().fill(/\.tde$/i.test(name)?name:name+'.tde');await input().press('Enter');}
const reminders=async()=>JSON.parse(await fs.readFile(path.join(profile,'reminders.json'),'utf8'));
async function dueNow(){const db=new Database(source);db.prepare('update events set deadline_ts=?').run(Math.floor(Date.now()/1000)-60);db.close();}
async function popup(){await expect.poll(()=>app.windows().some(p=>p.url().includes('reminder.html'))).toBe(true);const p=app.windows().find(p=>p.url().includes('reminder.html'))!;await expect(p.locator('.reminder-content')).toBeVisible();return p;}
async function prepareReminders(){const p=await popup();await p.getByRole('button',{name:'关闭提醒',exact:true}).click();await expect(p.locator('.reminder-content')).toContainText('原文 2');await p.getByRole('button',{name:'10分钟后提醒',exact:true}).click();await expect(p.locator('.reminder-content')).toContainText('原文 3');return p;}
async function saveAs(target:string){await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},target);await page.locator('.file-tab.active').click({button:'right'});await page.getByRole('button',{name:'另存为… Ctrl Shift S',exact:true}).click();}

test('double-click enters inline rename, IME Enter is ignored and Escape restores editor focus',async()=>{
  await launch();await page.locator('.tab-name').dblclick();await expect(input()).toBeFocused();await expect(input()).toHaveValue('Original.tde');
  await input().fill('组合输入');await input().dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});await expect(input()).toHaveValue('组合输入');expect(await fs.stat(source).then(()=>true,()=>false)).toBe(true);
  await input().press('Escape');await expect(input()).toHaveCount(0);await expect.poll(()=>page.locator('.todo-document').evaluate(el=>el.contains(document.activeElement))).toBe(true);await expect(page.locator('.file-tab.active')).toContainText('Original');
});
test('invalid and existing names remain editable; Enter retries and blur cancels',async({},info)=>{
  await launch();await begin();
  for(const name of ['../escape','CON','name.']){await input().fill(name);await input().press('Enter');await expect(page.locator('.tab-rename-error')).toBeVisible();await expect(input()).toBeFocused();}
  const existing=path.join(root,'已存在.tde');await fs.writeFile(existing,'不要覆盖');await input().fill('已存在.tde');await input().press('Enter');await expect(page.locator('.tab-rename-error')).toContainText('已有');await expect(input()).toBeFocused();expect(await fs.readFile(existing,'utf8')).toBe('不要覆盖');
  await page.screenshot({path:info.outputPath('inline-rename-error.png')});await input().fill('取消');await page.locator('.todo-document p').first().click();await expect(input()).toHaveCount(0);expect(await fs.stat(source).then(()=>true,()=>false)).toBe(true);
  await rename('会议纪要');await expect(input()).toHaveCount(0);await expect(page.locator('.file-tab.active')).toContainText('会议纪要');expect(await fs.stat(path.join(root,'会议纪要.tde')).then(()=>true,()=>false)).toBe(true);await expect.poll(()=>page.locator('.todo-document').evaluate(el=>el.contains(document.activeElement))).toBe(true);
});
test('case-only rename preserves the same editor and undo, including the physical filename',async()=>{
  await launch();await page.locator('.todo-document p').first().click();await page.keyboard.press('End');await page.keyboard.type(' 修改');const editor=await page.locator('.todo-document').elementHandle();
  await rename('original.TDE');await expect(input()).toHaveCount(0);await expect(page.locator('.file-tab.active')).toContainText('original');expect(await fs.readdir(root)).toContain('original.TDE');expect(await editor!.evaluate(el=>el.isConnected)).toBe(true);
  await page.locator('.todo-document p').first().click();await page.keyboard.press('Control+z');await expect(page.locator('.todo-document')).not.toContainText('修改');
  await expect.poll(()=>{const db=new Database(path.join(root,'original.TDE'),{readonly:true});try{return (db.prepare('select content_text from events order by pos').get() as any).content_text;}finally{db.close();}}).toBe('原文 1');
});
test('a failed source save blocks rename, keeps pending text and allows retry',async()=>{
  await launch();await app.evaluate(()=>{const fs=process.getBuiltinModule('fs').promises,open=fs.open;(globalThis as any).__renameFail=true;fs.open=async(file,...args)=>{if((globalThis as any).__renameFail&&String(file).includes('recovery'))throw new Error('simulated disk full');return open(file,...args);};});
  await page.locator('.todo-document p').first().click();await page.keyboard.press('End');await page.keyboard.type(' 不能丢');await rename('保存后改名');await expect(page.locator('.tab-rename-error')).toContainText('空间不足');await expect(page.locator('.todo-document')).toContainText('不能丢');expect(await fs.stat(source).then(()=>true,()=>false)).toBe(true);
  await app.evaluate(()=>{(globalThis as any).__renameFail=false;});await input().press('Enter');await expect(input()).toHaveCount(0);await expect(page.locator('.file-tab.active')).toContainText('保存后改名');
});
test('rename carries dismissed, snoozed and pending reminders into the new path across restart',async()=>{
  await dueNow();await launch();const p=await prepareReminders(),before=await reminders();await rename('迁移后的提醒');await expect(input()).toHaveCount(0);await expect(p.locator('.reminder-content')).toHaveAttribute('title',/迁移后的提醒/);await expect(p.locator('.reminder-content')).toContainText('原文 3');
  const saved=await reminders();expect(saved.snoozed).toHaveLength(1);expect(saved.snoozed[0][1]).toBe(before.snoozed[0][1]);expect(saved.pending).toHaveLength(1);expect(saved.pending[0].key).toContain('迁移后的提醒.tde');expect(saved.seen.every((key:string)=>!key.includes('original.tde'))).toBe(true);
  await app.evaluate(({app})=>app.exit(0));await launch();const reopened=await popup();await expect(reopened.locator('.reminder-content')).toContainText('原文 3');expect((await reminders()).pending).toHaveLength(1);
});
test('Save As inherits reminder history without consuming the original document queue',async()=>{
  await dueNow();await launch();await prepareReminders();const target=path.join(root,'副本.tde');await saveAs(target);await expect(page.locator('.file-tab.active')).toContainText('副本');const p=await popup();await expect(p.locator('.reminder-content')).toHaveAttribute('title',/副本/);await expect(p.locator('.reminder-content')).toContainText('原文 3');
  const saved=await reminders();expect(saved.pending).toHaveLength(2);expect(saved.pending[0].id).not.toBe(saved.pending[1].id);expect(saved.snoozed).toHaveLength(2);
  await p.getByRole('button',{name:'关闭提醒',exact:true}).click();await expect.poll(async()=>(await reminders()).pending.length).toBe(1);expect((await reminders()).pending[0].key).toContain('original.tde');
});
test('reminder migration failure leaves the source and editor usable for both rename and Save As',async()=>{
  await dueNow();await launch();await prepareReminders();await fs.mkdir(path.join(profile,'reminders.json.tmp'));await rename('失败保留');await expect(page.locator('.tab-rename-error')).toContainText('提醒记录未迁移');expect(await fs.stat(source).then(()=>true,()=>false)).toBe(true);expect(await fs.stat(path.join(root,'失败保留.tde')).then(()=>true,()=>false)).toBe(true);await expect(input()).toHaveValue('失败保留.tde');
  await input().press('Escape');await saveAs(path.join(root,'另存副本.tde'));await expect(page.locator('.toast')).toContainText('提醒记录未迁移');await expect(page.locator('.file-tab.active')).toContainText('Original');await expect(page.locator('.todo-document')).toHaveAttribute('contenteditable','true');
  await fs.rmdir(path.join(profile,'reminders.json.tmp'));await rename('重试成功');await expect(input()).toHaveCount(0);await expect(page.locator('.file-tab.active')).toContainText('重试成功');
});
