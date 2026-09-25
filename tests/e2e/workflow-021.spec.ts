import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {documentDate} from '../../src/shared/new-document';
import {searchWindow} from './search-window';
let app:ElectronApplication,page:Page,root:string;
const activePath=()=>page.locator('.file-tab.active .tab-name').getAttribute('title');
const exists=(file:string)=>fs.stat(file).then(()=>true,()=>false);
async function launch(file?:string){
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.TODOLINE_TEST_EXE;
  app=await _electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[path.resolve('.')]),...(file?['--open',file]:[])],env:env as Record<string,string>});
  page=await app.firstWindow();await expect(page.locator('.app')).toBeVisible();await expect(page.getByText('正在恢复工作区…',{exact:true})).toBeHidden();
  if(file)await expect(page.locator('.document-scroller[data-active] .ProseMirror')).toBeVisible();
}
async function newTab(){const count=await page.locator('.file-tab').count();await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await expect(page.locator('.file-tab')).toHaveCount(count+1);await expect(page.locator('.document-scroller[data-active] .todo-document')).toBeVisible();return (await activePath())!;}
async function closeTab(){const count=await page.locator('.file-tab').count();await page.locator('.file-tab.active .tab-close').click();await expect(page.locator('.file-tab')).toHaveCount(count-1);}
async function searchCommand(){await app.evaluate(({Menu})=>{const item=Menu.getApplicationMenu()!.items.flatMap(item=>item.submenu?.items??[]).find(item=>item.accelerator==='CmdOrCtrl+F')!;(item.click as ()=>void)();});}
async function quit(){const closed=app.waitForEvent('close');await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await closed;}
async function addImage(width:number,height:number){
  const bytes=await app.evaluate(({nativeImage},{width,height})=>Array.from(nativeImage.createFromBitmap(Buffer.alloc(width*height*4,180),{width,height}).toPNG()),{width,height});
  const image=path.join(root,'image.png');await fs.writeFile(image,Buffer.from(bytes));await page.locator('input[type=file][accept="image/*"]').setInputFiles(image);
  const img=page.locator('.document-scroller[data-active] .ProseMirror img:not(.ProseMirror-separator)');await expect(img).toBeVisible();return img;
}
test.beforeEach(async({},info)=>{root=info.outputPath('workspace');await fs.mkdir(path.join(root,'profile'),{recursive:true});await fs.mkdir(path.join(root,'documents'),{recursive:true});await fs.writeFile(path.join(root,'profile/session.json'),JSON.stringify({settings:{newFileDirectory:path.join(root,'documents')}}));});
test.afterEach(async()=>{await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});

test('daily names skip occupied files and blank documents are removed on tab close and application exit',async()=>{
  const date=documentDate(),occupied=path.join(root,'documents',date+'_0.tde');await fs.writeFile(occupied,'untouched');await launch();
  const first=await newTab();expect(path.basename(first)).toBe(date+'_1.tde');await closeTab();await expect.poll(()=>exists(first)).toBe(false);
  const second=await newTab();expect(path.basename(second)).toBe(date+'_2.tde');
  await page.locator('.todo-document').click();await page.keyboard.type('temporary');await page.keyboard.press('Control+a');await page.keyboard.press('Backspace');
  await page.getByRole('button',{name:'外观与设置',exact:true}).click();await expect(page.locator('.new-file-directory')).not.toContainText('仅影响');await page.keyboard.press('Escape');
  await quit();expect(await exists(second)).toBe(false);expect(await fs.readFile(occupied,'utf8')).toBe('untouched');
  const session=JSON.parse(await fs.readFile(path.join(root,'profile/session.json'),'utf8'));expect(session.tabs).toHaveLength(0);expect(session.recent).not.toContain(first);expect(session.recent).not.toContain(second);
  await launch();expect(path.basename(await newTab())).toBe(date+'_3.tde');
});

test('renamed files and content survive exit; unrenamed content cleared after restart is removed',async()=>{
  test.setTimeout(90000);await launch();const original=await newTab();
  await page.locator('.file-tab.active').click({button:'right'});await page.getByRole('button',{name:'重命名…',exact:true}).click();await page.getByRole('textbox',{name:'新文件名'}).fill('保留空文件.tde');await page.getByRole('textbox',{name:'新文件名'}).press('Enter');
  await expect(page.locator('.file-tab.active .tab-name')).toHaveText('保留空文件');const renamed=(await activePath())!;
  const content=await newTab();await page.locator('.document-scroller[data-active] .todo-document').click();await page.keyboard.type('keep until cleared');
  await quit();expect(await exists(renamed)).toBe(true);expect(await exists(content)).toBe(true);expect(await exists(original)).toBe(false);
  await launch();await expect(page.locator('.document-scroller[data-active] .todo-document')).toContainText('keep until cleared');await page.locator('.document-scroller[data-active] .todo-document').click();await page.keyboard.press('Control+a');await page.keyboard.press('Backspace');await closeTab();await expect.poll(()=>exists(content)).toBe(false);
  await quit();expect(await exists(renamed)).toBe(true);
});

test('converted Markdown keeps its dated name and is removed after its body is cleared',async()=>{
  await launch();const original=await newTab();await app.evaluate(({clipboard})=>clipboard.writeText('# 标题\n\n## 小节\n\n正文'));
  await page.locator('.todo-document').click();await page.keyboard.press('Control+v');const body=page.locator('.markdown-document');await expect(body).toBeVisible();const file=(await activePath())!;expect(path.basename(file)).toMatch(/^\d{8}_\d+\.md$/);
  await expect.poll(()=>fs.readFile(file,'utf8')).toContain('正文');await body.click();await page.keyboard.press('Control+a');await page.keyboard.press('Backspace');await closeTab();
  await expect.poll(()=>exists(file)).toBe(false);expect(await exists(original)).toBe(false);
});

for(const [width,height] of [[160,90],[60,300],[2000,200]])test(`fit image ${width}x${height} scales proportionally to viewport and follows window resize`,async()=>{
  await launch();const file=await newTab();await page.locator('.todo-document').click();const img=await addImage(width,height);await img.dblclick();
  const viewer=page.getByRole('dialog',{name:'原图查看器'});await expect(viewer).toBeVisible();await viewer.getByRole('button',{name:'原始大小',exact:true}).click();await viewer.getByRole('button',{name:'适应窗口',exact:true}).click();
  const measurements=()=>viewer.evaluate(el=>{const image=el.querySelector('img')!,canvas=el.querySelector('.image-viewer-canvas')! as HTMLElement;const r=image.getBoundingClientRect();return {w:r.width,h:r.height,vw:canvas.clientWidth-48,vh:canvas.clientHeight-48};});
  await expect.poll(async()=>{const m=await measurements();return Math.abs(Math.max(m.w/m.vw,m.h/m.vh)-1);}).toBeLessThan(.025);
  const m=await measurements();expect(m.w/m.h).toBeCloseTo(width/height,1);if(width<500&&height<500)expect(m.w).toBeGreaterThan(width);
  await expect(viewer).not.toContainText('滚轮缩放');await expect(viewer).not.toContainText('拖动查看');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!.setSize(900,600));
  await expect.poll(async()=>{const m=await measurements();return Math.abs(Math.max(m.w/m.vw,m.h/m.vh)-1);}).toBeLessThan(.025);
  await page.keyboard.press('Escape');await closeTab();expect(await exists(file)).toBe(true);
});

for(const close of ['button','escape'])test(`search automatically relocates after image ${close}, repeated queries and changing query`,async()=>{
  test.setTimeout(90000);await launch();await newTab();await page.locator('.todo-document').click();const img=await addImage(160,90);
  await page.locator('.todo-document').evaluate((el:any)=>{const editor=el.editor;editor.commands.setContent({type:'doc',content:[...editor.getJSON().content,{type:'paragraph',content:[{type:'text',text:'起点'}]}, {type:'divider',attrs:{id:-91,created_at:1700000000}},{type:'paragraph',content:[{type:'text',text:'第一搜索目标'}]}, {type:'divider',attrs:{id:-92,created_at:1700000000}},{type:'paragraph',content:[{type:'text',text:'第二搜索目标'}]}]});});
  const selection=()=>page.locator('.todo-document').evaluate((el:any)=>el.editor.state.selection.$from.parent.textContent);
  await searchCommand();let search=await searchWindow(app);await search.getByRole('textbox',{name:'搜索内容'}).fill('第一搜索目标');await expect.poll(selection).toBe('第一搜索目标');
  await search.getByRole('button',{name:'关闭搜索',exact:true}).click();await img.dblclick();await expect(page.getByRole('dialog',{name:'原图查看器'})).toBeVisible();
  if(close==='button')await page.getByRole('button',{name:'关闭原图',exact:true}).click();else await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog',{name:'原图查看器'})).toHaveCount(0);await searchCommand();search=await searchWindow(app);
  await search.getByRole('textbox',{name:'搜索内容'}).fill('第一搜索目标');await expect.poll(selection).toBe('第一搜索目标');
  await search.getByRole('textbox',{name:'搜索内容'}).fill('第二搜索目标');await expect.poll(selection).toBe('第二搜索目标');
  await page.locator('.todo-document p').filter({hasText:'起点'}).click();await searchCommand();await expect.poll(selection).toBe('第二搜索目标');
});
