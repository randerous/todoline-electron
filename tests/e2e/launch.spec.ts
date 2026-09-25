import { _electron,expect,test,type ElectronApplication,type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { DocumentStore } from '../../src/main/storage';
const run=promisify(execFile),project=path.resolve('.');
let app:ElectronApplication,page:Page,root:string,files:string[],env:NodeJS.ProcessEnv;
test.beforeEach(async({},info)=>{
  root=info.outputPath('workspace');await fs.mkdir(path.join(root,'profile'),{recursive:true});files=[];
  for(const name of ['原会话','命令行 中文','第三份']){
    const file=path.join(root,name+'.tde'),store=new DocumentStore(),doc=store.open(file,true);files.push(file);
    await store.save({handle:doc.handle,revision:doc.revision,events:[{id:-1,pos:0,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:1,content_html:`<p>${name}内容</p>`,content_text:name+'内容'}]});store.close(doc.handle);
  }
  await fs.writeFile(path.join(root,'profile','session.json'),JSON.stringify({tabs:[{path:files[0],cursor:2,scroll:0}],active:0,recent:[files[0]]}));
  env={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
async function launch(args:string[]=[]){app=await _electron.launch({args:[project,...args],env:env as Record<string,string>});page=await app.firstWindow();await expect(page.locator('.document-scroller:visible .todo-document')).toBeVisible();}
async function secondary(args:string[]){const executable=await app.evaluate(()=>process.execPath);await run(executable,[project,...args],{cwd:root,env,windowsHide:true,timeout:15000});}
const editor=()=>page.locator('.document-scroller:visible .todo-document');

test('positional startup files preserve the old session and continue after an invalid document',async()=>{
  await launch([files[1],path.join(root,'不存在.tde'),'--open',files[2]]);
  await expect(page.locator('.file-tab')).toHaveCount(3);await expect(page.locator('.file-tab.active')).toContainText('第三份');await expect(page.locator('.toast')).toContainText('无法打开');
  await page.locator('.file-tab').first().locator('.tab-name').click();await expect(editor()).toContainText('原会话内容');
  await expect.poll(async()=>JSON.parse(await fs.readFile(path.join(root,'profile','session.json'),'utf8')).tabs.length).toBe(3);
});

test('a real second process opens a relative Unicode path and reuses existing editor and undo state',async()=>{
  await launch();await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 原来的编辑');const node=await editor().elementHandle(),pid=app.process().pid;
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].minimize());await secondary([path.basename(files[1])]);
  await expect(page.locator('.file-tab')).toHaveCount(2);await expect(page.locator('.file-tab.active')).toContainText('命令行 中文');expect(app.process().pid).toBe(pid);expect(await node!.evaluate(el=>el.isConnected)).toBe(true);expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
  await secondary([files[0]]);await expect(page.locator('.file-tab.active')).toContainText('原会话');await expect(page.locator('.file-tab')).toHaveCount(2);await expect(editor()).toContainText('原来的编辑');
  await editor().locator('p').click();await page.keyboard.press('Control+z');await expect(editor()).not.toContainText('原来的编辑');
});

test('remote --quit waits for pending text even when the window normally closes to the tray',async()=>{
  await launch();await page.evaluate(async()=>{const s=await window.desktop.session();await window.desktop.updateSession({settings:{...s.settings,closeToTray:true}});});
  const processHandle=app.process();await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 退出前保存');await secondary(['--quit']);await expect.poll(()=>processHandle.exitCode).toBe(0);
  const db=new Database(files[0],{readonly:true});try{expect((db.prepare('select content_text from events').get() as any).content_text).toContain('退出前保存');}finally{db.close();}
});

test('recent files remain accessible with open tabs and support filter and keyboard reopening',async({},info)=>{
  await launch([files[1]]);await expect(page.locator('.file-tab')).toHaveCount(2);await page.getByRole('button',{name:'关闭 原会话.tde',exact:true}).click();await expect(page.locator('.file-tab')).toHaveCount(1);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(820,660));await page.getByRole('button',{name:'最近打开的文档',exact:true}).click();await page.getByRole('textbox',{name:'筛选最近文档'}).fill('原会话');await expect(page.locator('.recent-items button')).toHaveCount(1);
  const bounds=await page.locator('.recent-menu').boundingBox();expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(820);expect(await page.locator('.recent-items').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await page.screenshot({path:info.outputPath('recent-menu.png')});
  await page.keyboard.press('ArrowDown');await expect(page.locator('.recent-items button')).toBeFocused();await page.keyboard.press('Enter');await expect(page.locator('.file-tab')).toHaveCount(2);await expect(page.locator('.file-tab.active')).toContainText('原会话');await expect(editor()).toContainText('原会话内容');
  await page.getByRole('button',{name:'最近打开的文档',exact:true}).click();await page.keyboard.press('Escape');await expect(page.locator('.recent-menu')).toHaveCount(0);
});
