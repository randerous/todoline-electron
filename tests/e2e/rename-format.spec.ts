import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DocumentStore} from '../../src/main/storage';
let app:ElectronApplication,page:Page,root:string;
const body=()=>page.locator('.document-scroller[data-active] .ProseMirror');
const input=()=>page.getByRole('textbox',{name:'新文件名'});
async function launch(file?:string){
 const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
 const executablePath=process.env.TODOLINE_TEST_EXE;
 app=await _electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[path.resolve('.')]),...(file?[file]:[])],env:env as Record<string,string>});page=await app.firstWindow();await expect(page.locator('.file-tab.active')).toBeVisible();await expect(body()).toBeVisible();
}
async function rename(name:string){await page.locator('.file-tab.active .tab-name').dblclick();await input().fill(name);await input().press('Enter');await expect(input()).toHaveCount(0);await expect(body()).toBeVisible();}
test.beforeEach(async({},info)=>{root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});});
test.afterEach(async()=>{await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});

test('full filename editing changes text modes immediately, preserving source bytes and recent/session paths',async()=>{
 const source='# 标题\r\n\r\n**正文**\r\n',file=path.join(root,'original.txt');await fs.writeFile(file,source);await launch(file);
 const width=(await page.locator('.file-tab.active').boundingBox())!.width;await page.locator('.file-tab.active .tab-name').dblclick();await expect(input()).toHaveValue('original.txt');expect(await input().evaluate((el:HTMLInputElement)=>[el.selectionStart,el.selectionEnd])).toEqual([0,8]);expect((await page.locator('.file-tab.active').boundingBox())!.width).toBe(width);await input().press('Escape');
 await rename('笔记.md');await expect(body()).toHaveClass(/markdown-document/);await expect(body().locator('h1')).toHaveText('标题');await expect(page.getByRole('navigation',{name:'目录导航'})).toBeVisible();expect(await fs.readFile(path.join(root,'笔记.md'),'utf8')).toBe(source);expect(await fs.stat(file).then(()=>true,()=>false)).toBe(false);
 await rename('日志.log');await expect(body()).toHaveClass(/plain-text-document/);await expect(body()).toContainText('**正文**');expect(await fs.readFile(path.join(root,'日志.log'),'utf8')).toBe(source);
 await rename('README');await expect(body()).toHaveClass(/plain-text-document/);expect(await fs.readFile(path.join(root,'README'),'utf8')).toBe(source);
 await expect.poll(async()=>JSON.parse(await fs.readFile(path.join(root,'profile','session.json'),'utf8')).tabs[0].path).toBe(path.join(root,'README'));
 await app.evaluate(({app})=>app.exit(0));await launch();await expect(page.locator('.file-tab.active')).toContainText('README');await expect(body()).toHaveClass(/plain-text-document/);
});

test('TDE and Markdown conversion preserves rendered images and text with usable recovery copies',async()=>{
 const file=path.join(root,'事件.tde'),store=new DocumentStore(),doc=store.open(file,true),data=await fs.readFile(path.resolve('resources/icon.png')),id=await store.addAsset(doc.handle,data,512,512);
 await store.save({...doc,events:[{id:-1,pos:0,created_at:1700000000,deadline_raw:'明天',deadline_ts:1700086400,done:1,top_divider:1,content_text:'正文',content_html:`<p><strong>正文</strong><img src="asset:${id}" /></p>`}]});store.close(doc.handle);await launch(file);
 await rename('转换.md');await expect(body()).toHaveClass(/markdown-document/);await expect(body().locator('strong')).toHaveText('正文');await expect(body()).toContainText('截止 明天');await expect.poll(()=>body().locator('img[src]').evaluate((el:HTMLImageElement)=>el.naturalWidth)).toBeGreaterThan(0);
 expect(await fs.readFile(path.join(root,'转换.md'),'utf8')).toContain('data:image/');await expect(page.locator('.document-warning')).toHaveCount(0);
 const recovery=path.join(root,'profile','recovery','format-renames'),copies=await fs.readdir(recovery,{recursive:true}),backup=copies.find(file=>file.endsWith('.tde'));expect(backup).toBeTruthy();expect((await fs.readFile(path.join(recovery,backup!))).subarray(0,15).toString()).toBe('SQLite format 3');
 await rename('转回.tde');await expect(body()).toHaveClass(/todo-document/);await expect(page.locator('.document-warning')).toHaveCount(0);await expect(body()).toContainText('正文');await expect.poll(()=>body().locator('img[src]').evaluate((el:HTMLImageElement)=>el.naturalWidth)).toBeGreaterThan(0);expect((await fs.readFile(path.join(root,'转回.tde'))).subarray(0,15).toString()).toBe('SQLite format 3');
 await app.evaluate(({app})=>app.exit(0));await launch(path.join(root,'转回.tde'));await expect(body()).toContainText('截止 明天');await expect.poll(()=>body().locator('img[src]').evaluate((el:HTMLImageElement)=>el.naturalWidth)).toBeGreaterThan(0);
});

test('new empty tab can change suffix and a plain file converts to a real TDE',async()=>{
 const file=path.join(root,'plain.cfg');await fs.writeFile(file,'# literal\n\tdata=1\n');await launch(file);await rename('配置.tde');await expect(body()).toHaveClass(/todo-document/);await expect(body()).toContainText('# literal');await expect(body().locator('h1')).toHaveCount(0);
 await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await rename('空白.md');await expect(body()).toHaveClass(/markdown-document/);await body().click();await page.keyboard.insertText('新内容');await expect(body()).toContainText('新内容');
});

test('rename conversion refuses collisions and external edits without changing the originals',async()=>{
 const file=path.join(root,'source.txt'),target=path.join(root,'existing.tde');await fs.writeFile(file,'原内容');await fs.writeFile(target,'已有文件');await launch(file);
 await page.locator('.file-tab.active .tab-name').dblclick();await input().fill('existing.tde');await input().press('Enter');await expect(page.locator('.tab-rename-error')).toContainText('已有');expect(await fs.readFile(target,'utf8')).toBe('已有文件');expect(await fs.readFile(file,'utf8')).toBe('原内容');
 await input().press('Escape');await fs.writeFile(file,'外部修改');await page.locator('.file-tab.active .tab-name').dblclick();await input().fill('new.tde');await input().press('Enter');await expect(page.locator('.tab-rename-error')).toContainText('其他程序修改');expect(await fs.readFile(file,'utf8')).toBe('外部修改');expect(await fs.stat(path.join(root,'new.tde')).then(()=>true,()=>false)).toBe(false);
});

test('Ctrl+1 through Ctrl+6 toggle Markdown headings and pressing again restores paragraphs',async()=>{
 const file=path.join(root,'快捷键.md');await fs.writeFile(file,'标题正文\n');await launch(file);
 for(let level=1;level<=6;level++){
  await body().locator('p').first().click();await page.keyboard.press('Control+'+level);await expect(body().locator('h'+level)).toHaveText('标题正文');
  await expect(page.locator('.markdown-outline')).toContainText('标题正文');
  await page.keyboard.press('Control+'+level);await expect(body().locator('h1,h2,h3,h4,h5,h6')).toHaveCount(0);await expect(body().locator('p').first()).toHaveText('标题正文');
 }
 await page.keyboard.press('Control+1');await page.keyboard.press('Control+3');await expect(body().locator('h3')).toHaveText('标题正文');await expect.poll(()=>fs.readFile(file,'utf8')).toContain('### 标题正文');
 await page.getByRole('textbox',{name:'快速搜索导航'}).fill('标题');await page.keyboard.press('Control+2');await expect(body().locator('h3')).toHaveCount(1);
});
