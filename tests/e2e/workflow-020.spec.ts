import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {documentDate} from '../../src/shared/new-document';
let app:ElectronApplication,page:Page,root:string;
const sample=()=>fs.readFile('tests/fixtures/openeuler-next.md','utf8');
async function launch(file?:string){
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.TODOLINE_TEST_EXE;
  app=await _electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[path.resolve('.')]),...(file?['--open',file]:[])],env:env as Record<string,string>});
  page=await app.firstWindow();await expect(page.locator('.app')).toBeVisible();await expect(page.getByText('正在恢复工作区…',{exact:true})).toBeHidden();
  if(file)await expect(page.locator('.document-scroller[data-active] .ProseMirror')).toBeVisible();
}
async function newTab(){const count=await page.locator('.file-tab').count();await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await expect(page.locator('.file-tab')).toHaveCount(count+1);await expect(page.locator('.document-scroller[data-active] .todo-document')).toBeVisible();}
async function pasteSample(){await app.evaluate(({clipboard},text)=>clipboard.writeText(text),await sample());const body=page.locator('.document-scroller[data-active] .todo-document');await body.click();await page.keyboard.press('Control+v');await expect(page.locator('.document-scroller[data-active] .markdown-document')).toBeVisible();}
const activePath=()=>page.locator('.file-tab.active .tab-name').getAttribute('title');
async function chooseDirectory(directory:string){
  await fs.mkdir(directory,{recursive:true});await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},directory);
  await page.getByRole('button',{name:'外观与设置',exact:true}).click();await page.getByRole('button',{name:'选择文件夹',exact:true}).click();
  await expect(page.locator('.new-file-directory')).toContainText(directory);await page.keyboard.press('Escape');
}
test.beforeEach(async({},info)=>{root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png'),timeout:5000}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});

test('converted Markdown stays in global recents after closing, across tabs and after restart',async()=>{
  await launch();await newTab();await pasteSample();const converted=(await activePath())!;
  await expect.poll(()=>fs.readFile(converted,'utf8')).toContain('openEuler-24.03-LTS-Next');
  await page.locator('.file-tab.active .tab-close').click();await page.getByRole('button',{name:'最近打开的文档',exact:true}).click();
  const entry=page.locator('.recent-items button').filter({has:page.getByText(path.basename(converted),{exact:true})});await expect(entry).toBeVisible();await entry.click();
  await expect(page.locator('.markdown-document strong').first()).toContainText('开发/演进分支');
  await newTab();await page.getByRole('button',{name:'最近打开的文档',exact:true}).click();await expect(page.locator('.recent-items')).toContainText(path.basename(converted));await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await app.waitForEvent('close');await launch();
  await page.getByRole('button',{name:'最近打开的文档',exact:true}).click();await expect(page.locator('.recent-items')).toContainText(path.basename(converted));
});

test('new file directory applies to TDE and converted Markdown without moving existing files',async()=>{
  const original=path.join(root,'existing.md');await fs.writeFile(original,'# 原文件\n\n正文');await launch(original);
  const directory=path.join(root,'自动保存');await chooseDirectory(directory);
  await newTab();const tde=(await activePath())!;expect(path.dirname(tde)).toBe(directory);await page.locator('.document-scroller[data-active] .todo-document').click();await page.keyboard.type('saved content');
  await expect.poll(()=>{const db=new Database(tde,{readonly:true});try{return (db.prepare('select content_text from events').all() as {content_text:string}[]).map(r=>r.content_text).join('');}finally{db.close();}}).toContain('saved content');
  await newTab();await pasteSample();const markdown=(await activePath())!;expect(path.dirname(markdown)).toBe(directory);expect(markdown).toMatch(/\.md$/);
  await expect.poll(()=>fs.readFile(markdown,'utf8')).toContain('分支模型');
  await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>{throw new Error('Unexpected Save As');};});
  await page.locator('.file-tab.active').click({button:'right'});await page.getByRole('button',{name:'立即保存 Ctrl S',exact:true}).click();await expect(page.locator('.toast').filter({hasText:'Unexpected Save As'})).toHaveCount(0);
  await page.locator('.tab-name').filter({hasText:'existing.md'}).click();await page.locator('.markdown-document h1').first().click();await page.keyboard.press('End');await page.keyboard.type(' edited');
  await expect.poll(()=>fs.readFile(original,'utf8')).toContain('原文件 edited');expect(await activePath()).toBe(original);
  await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await app.waitForEvent('close');await launch();
  await newTab();expect(path.dirname((await activePath())!)).toBe(directory);
});

test('cancelling directory selection leaves settings unchanged and an occupied name is never replaced',async()=>{
  await launch();await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});
  await page.getByRole('button',{name:'外观与设置',exact:true}).click();await page.getByRole('button',{name:'选择文件夹',exact:true}).click();await page.keyboard.press('Escape');
  expect(await page.evaluate(async()=>(await window.desktop.session()).settings.newFileDirectory)).toBe('');
  const directory=path.join(root,'documents');await chooseDirectory(directory);const sequence=await page.evaluate(async()=>(await window.desktop.session()).newFileSequence),date=documentDate(),serial=sequence?.date===date?sequence.next:0,occupied=path.join(directory,`${date}_${serial}.tde`);
  await fs.writeFile(occupied,'keep this file');await newTab();expect(await activePath()).not.toBe(occupied);expect(await fs.readFile(occupied,'utf8')).toBe('keep this file');
});

test('clicking Markdown links leaves a text caret without a blue paragraph selection',async()=>{
  const file=path.join(root,'link.md');await fs.writeFile(file,'一段 [链接](https://example.com) 和后文\n\n第二段');await launch(file);
  await app.evaluate(({shell})=>{shell.openExternal=async url=>{(globalThis as any).openedLink=url;};});
  const link=page.locator('.markdown-document a');await link.click();
  await expect(page.locator('.markdown-document p.ProseMirror-selectednode')).toHaveCount(0);
  await expect(page.locator('.markdown-document p').first()).toHaveCSS('outline-style','none');
  await page.keyboard.down('Control');await link.click();await page.keyboard.up('Control');await expect.poll(()=>app.evaluate(()=>(globalThis as any).openedLink)).toBe('https://example.com');
  await expect(page.locator('.markdown-document p.ProseMirror-selectednode')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');await page.keyboard.type('X');await expect.poll(()=>fs.readFile(file,'utf8')).toContain('后文');
});

for(const format of ['tde','md'])test(`double-click ${format} image opens original pixels with copy, zoom and no document edit`,async()=>{
  if(format==='md'){const file=path.join(root,'images.md');await fs.writeFile(file,'# 图片\n\n正文');await launch(file);}else{await launch();await newTab();}
  const data=await app.evaluate(({nativeImage})=>Array.from(nativeImage.createFromBitmap(Buffer.alloc(1200*800*4,180),{width:1200,height:800}).toPNG()));const file=path.join(root,'original.png');await fs.writeFile(file,Buffer.from(data));
  await page.locator('.document-scroller[data-active] .ProseMirror').click();await page.locator('input[type=file][accept="image/*"]').setInputFiles(file);
  const img=page.locator('.document-scroller[data-active] .ProseMirror img:not(.ProseMirror-separator)');await expect(img).toBeVisible();
  await img.dblclick();const viewer=page.getByRole('dialog',{name:'原图查看器'});await expect(viewer).toBeVisible();await expect(viewer).toContainText('1200 × 800');
  await viewer.getByRole('button',{name:'原始大小',exact:true}).click();await expect(viewer.getByLabel('图片缩放比例')).toHaveText('100%');
  await viewer.getByRole('button',{name:'放大原图',exact:true}).click();await expect(viewer.getByLabel('图片缩放比例')).toHaveText('125%');
  await expect(viewer.locator('img')).toHaveCSS('width','1500px');
  const canvas=viewer.locator('.image-viewer-canvas');await canvas.hover();await page.mouse.wheel(0,-100);await expect(viewer.getByLabel('图片缩放比例')).toHaveText('144%');
  const before=await canvas.evaluate(el=>el.scrollLeft),box=(await canvas.boundingBox())!;await page.mouse.move(box.x+box.width/2,box.y+100);await page.mouse.down();await page.mouse.move(box.x+box.width/2-80,box.y+100,{steps:5});await page.mouse.up();await expect.poll(()=>canvas.evaluate(el=>el.scrollLeft)).toBeGreaterThan(before);
  await viewer.getByRole('button',{name:'复制原图',exact:true}).click();await expect(viewer.getByRole('button',{name:'已复制',exact:true})).toBeVisible();
  expect(await app.evaluate(({clipboard})=>clipboard.readImage().getSize())).toEqual({width:1200,height:800});
  
  await page.keyboard.press('Escape');await expect(viewer).toHaveCount(0);await expect(page.locator('.document-scroller[data-active] .ProseMirror img:not(.ProseMirror-separator)')).toHaveCount(1);
});


test('closing a TDE tab moves it to the top of both recent lists and persists after restart',async()=>{
  await launch();await newTab();
  await page.locator('.file-tab.active .tab-name').dblclick();await page.getByRole('textbox',{name:'新文件名'}).fill('近期事项.tde');await page.getByRole('textbox',{name:'新文件名'}).press('Enter');
  await expect(page.locator('.file-tab.active')).toContainText('近期事项');const first=(await activePath())!;
  await newTab();const second=(await activePath())!;
  await page.locator('.document-scroller[data-active] .todo-document').click();await page.keyboard.insertText('保留另一份文件');
  await expect.poll(()=>page.evaluate(async()=>(await window.desktop.session()).recent[0])).toBe(second);
  await page.getByRole('button',{name:'关闭 近期事项.tde',exact:true}).click();
  await page.getByRole('button',{name:'最近打开的文档',exact:true}).click();await expect(page.locator('.recent-items button').first()).toContainText('近期事项.tde');await page.keyboard.press('Escape');
  await page.locator('.file-tab.active .tab-close').click();await expect(page.locator('.welcome .recent button').first()).toContainText(path.basename(second));
  await page.locator('.welcome .recent button').filter({hasText:'近期事项.tde'}).click();await expect(page.locator('.todo-document')).toBeVisible();await page.locator('.file-tab.active .tab-close').click();
  await expect(page.locator('.welcome .recent button').first()).toContainText('近期事项.tde');await expect.poll(()=>page.evaluate(async()=>(await window.desktop.session()).recent[0])).toBe(first);
  // Closing an unused, unnamed tab still removes it instead of adding a dead recent entry.
  await newTab();const empty=(await activePath())!;await page.locator('.file-tab.active .tab-close').click();await expect(page.locator('.welcome .recent button').first()).toContainText('近期事项.tde');
  expect(await page.evaluate(async file=>(await window.desktop.session()).recent.includes(file),empty)).toBe(false);
  await app.evaluate(({app})=>app.exit(0));await launch();await expect(page.locator('.welcome .recent button').first()).toContainText('近期事项.tde');
  await page.getByRole('button',{name:'最近打开的文档',exact:true}).click();await expect(page.locator('.recent-items button').first()).toContainText('近期事项.tde');
});
