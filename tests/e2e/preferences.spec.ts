import {documentDate} from '../../src/shared/new-document';
import { _electron,expect,test,type ElectronApplication,type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DocumentStore } from '../../src/main/storage';
let app:ElectronApplication,page:Page,root:string,profile:string,file:string,env:NodeJS.ProcessEnv;
test.beforeEach(async({},info)=>{
  root=info.outputPath('workspace');profile=path.join(root,'profile');await fs.mkdir(profile,{recursive:true});file=path.join(root,'偏好测试.tde');
  const store=new DocumentStore(),doc=store.open(file,true);await store.save({handle:doc.handle,revision:doc.revision,events:[{id:-1,pos:0,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:1,content_html:'<p>原文内容</p>',content_text:'原文内容'}]});store.close(doc.handle);
  await fs.writeFile(path.join(profile,'session.json'),JSON.stringify({tabs:[{path:file,cursor:2,scroll:0}],active:0,recent:[file]}));
  env={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
async function launch(){app=await _electron.launch({args:[path.resolve('.')],env:env as Record<string,string>});page=await app.firstWindow();await expect(page.locator('.document-scroller:visible .todo-document')).toBeVisible();}
const session=async()=>JSON.parse(await fs.readFile(path.join(profile,'session.json'),'utf8'));
const editor=()=>page.locator('.document-scroller:visible .todo-document');

test('corrupt configuration restores the backup session and preserves the damaged bytes',async()=>{
  const saved=await session();saved.settings={theme:'green'};await fs.writeFile(path.join(profile,'session.json.bak'),JSON.stringify(saved));await fs.writeFile(path.join(profile,'session.json'),'{truncated');
  await launch();await expect(editor()).toContainText('原文内容');await expect(page.locator('html')).toHaveAttribute('data-theme','green');await expect(page.locator('.toast')).toContainText('上一份有效会话');
  const preserved=(await fs.readdir(profile)).find(file=>file.startsWith('session.corrupt-'))!;expect(await fs.readFile(path.join(profile,preserved),'utf8')).toBe('{truncated');
});

test('invalid setting types cannot prevent opening or editing the document',async()=>{
  const saved=await session();saved.settings={theme:{},fontSize:[],sidebarWidth:'wide',lineNumbers:'false',advanceMinutes:'tomorrow'};saved.recent=null;saved.maximized='true';await fs.writeFile(path.join(profile,'session.json'),JSON.stringify(saved));
  await launch();await expect(editor()).toContainText('原文内容');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 可以编辑');await expect(editor()).toContainText('可以编辑');
});

test('normal bounds and maximized state survive restart without replacing the normal rectangle',async()=>{
  await launch();const normal=await app.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0],a=screen.getPrimaryDisplay().workArea;w.show();w.setBounds({x:a.x+30,y:a.y+25,width:850,height:600});return w.getBounds();});
  await expect.poll(async()=>(await session()).bounds).toEqual(normal);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].maximize());await expect.poll(async()=>(await session()).maximized).toBe(true);expect((await session()).bounds).toEqual(normal);
  await app.evaluate(({app})=>app.exit(0));await launch();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].unmaximize());await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds())).toEqual(normal);
});

test('a window saved on a disconnected monitor opens inside the current work area',async()=>{
  const saved=await session();saved.bounds={x:900000,y:-900000,width:20000,height:20000};await fs.writeFile(path.join(profile,'session.json'),JSON.stringify(saved));await launch();
  const result=await app.evaluate(({BrowserWindow,screen})=>({b:BrowserWindow.getAllWindows()[0].getBounds(),a:screen.getPrimaryDisplay().workArea}));expect(result.b.x).toBeGreaterThanOrEqual(result.a.x);expect(result.b.y).toBeGreaterThanOrEqual(result.a.y);expect(result.b.x+result.b.width).toBeLessThanOrEqual(result.a.x+result.a.width);expect(result.b.y+result.b.height).toBeLessThanOrEqual(result.a.y+result.a.height);
});

test('window state write failure reports an error without crashing or blocking document saves',async()=>{
  await launch();await app.evaluate(()=>{const fs=process.getBuiltinModule('fs'),rename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(to).endsWith('session.json'))throw new Error('simulated settings write failure');return rename(from,to);};});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(850,620));await expect(page.locator('.toast')).toContainText('窗口位置未保存');
  await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 文档继续保存');await expect.poll(()=>{const db=new Database(file,{readonly:true});try{return (db.prepare('select content_text from events').get() as any).content_text;}finally{db.close();}}).toContain('文档继续保存');
});

test('system theme follows native changes while a chosen canvas stays fixed',async({},info)=>{
  await launch();await app.evaluate(({nativeTheme})=>{nativeTheme.themeSource='light';});await page.getByRole('button',{name:'外观与设置',exact:true}).click();await page.getByRole('button',{name:'系统',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect.poll(async()=>(await session()).settings.theme).toBe('system');
  await app.evaluate(({nativeTheme})=>{nativeTheme.themeSource='dark';});await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.screenshot({path:info.outputPath('system-theme.png')});
  await page.getByRole('button',{name:'绿色',exact:true}).click();await app.evaluate(({nativeTheme})=>{nativeTheme.themeSource='light';});await expect(page.locator('html')).toHaveAttribute('data-theme','green');
});

test('concurrent draft creation uses readable unique names and continues numbering after restart',async()=>{
  await launch();const drafts=await page.evaluate(()=>Promise.all([window.desktop.create(),window.desktop.create()]));expect(drafts.map(d=>d.name).sort()).toEqual([`${documentDate()}_0.tde`,`${documentDate()}_1.tde`]);expect(new Set(drafts.map(d=>d.path)).size).toBe(2);for(const d of drafts)expect((await fs.stat(d.path)).size).toBeGreaterThan(0);
  await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await expect(page.locator('.file-tab.active')).toContainText(`${documentDate()}_2`);await app.evaluate(({app})=>app.exit(0));await launch();await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await expect(page.locator('.file-tab.active')).toContainText(`${documentDate()}_3`);
});

test('the toolbar can hide itself and comes back on hover without moving the document',async({},info)=>{
  await launch();const before=await editor().boundingBox();
  await page.getByRole('button',{name:'外观与设置',exact:true}).click();await page.getByRole('checkbox',{name:'工具栏自动隐藏',exact:true}).check();
  await expect.poll(async()=>(await session()).settings.autoHideToolbar).toBe(true);
  await page.keyboard.press('Escape');await expect(page.locator('.toolbar')).toHaveCSS('opacity','0');
  const collapsed=(await editor().boundingBox())!.y;expect(collapsed).toBeLessThan(before!.y);
  await page.locator('.tabs').hover();await expect(page.locator('.toolbar')).toHaveCSS('opacity','1');
  expect((await editor().boundingBox())!.y).toBe(collapsed);
  await page.screenshot({path:info.outputPath('auto-hide-toolbar.png')});
  await app.evaluate(({app})=>app.exit(0));await launch();await expect(page.locator('.toolbar')).toHaveCSS('opacity','0');
});
test('reminders can be switched off from the appearance panel and stay off after restart',async()=>{
  await launch();
  await expect(page.locator('.reminder-status')).toContainText('提醒已开启');
  await page.getByRole('button',{name:'外观与设置',exact:true}).click();
  await page.getByRole('combobox').selectOption('-1');
  await page.keyboard.press('Escape');
  await expect(page.locator('.reminder-status')).toContainText('提醒已关闭');
  await expect.poll(async()=>(await session()).settings.advanceMinutes).toBe(-1);
  await app.evaluate(({app})=>app.exit(0));await launch();
  await expect(page.locator('.reminder-status')).toContainText('提醒已关闭');
  expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('reminder.html')))).toBe(false);
});
