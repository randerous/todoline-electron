import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
let app:ElectronApplication,page:Page,root:string,file:string;
const original='# 配置标题\r\n\tkey = **literal**  \r\n\r\n';
const body=()=>page.locator('.document-scroller[data-active] .plain-text-document');
async function launch(files:string[]=[]){const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;const executablePath=process.env.TODOLINE_TEST_EXE;app=await _electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[path.resolve('.')]),...files],env:env as Record<string,string>});page=await app.firstWindow();await expect(body()).toBeVisible();}
async function open(file:string){await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();}
test.beforeEach(async({},info)=>{root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});file=path.join(root,'启动配置.conf');await fs.writeFile(file,original);await launch([file]);});
test.afterEach(async()=>{await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});

test('opens unknown suffix through the command line, edits literally, saves original format and restores it',async()=>{
 await expect(page.locator('.file-tab.active')).toContainText('启动配置.conf');await expect(body().locator('h1,strong,.event-divider')).toHaveCount(0);await expect(page.getByRole('button',{name:'加粗 · Ctrl+B',exact:true})).toBeDisabled();await expect(page.getByRole('navigation',{name:'文本文件信息'})).toBeVisible();
 expect(await fs.readFile(file,'utf8')).toBe(original);await body().click();await page.keyboard.press('Control+End');await page.keyboard.insertText('尾行');await page.keyboard.press('Enter');await page.keyboard.press('Tab');await page.keyboard.insertText('x = 1');
 await expect.poll(()=>fs.readFile(file,'utf8')).toBe(original+'尾行\r\n\tx = 1');
 await app.evaluate(({app})=>app.exit(0));await launch();await expect(body()).toContainText('x = 1');expect(await fs.readFile(file,'utf8')).toBe(original+'尾行\r\n\tx = 1');
 const loaded=await page.evaluate(()=>performance.getEntriesByType('resource').map(x=>x.name));expect(loaded.some(x=>/markdown-editor-|katex-|markdown-search-/.test(x))).toBe(false);
});

test('autosave persists undo back to the original content and subsequent redo',async()=>{
 await body().click();await page.keyboard.press('Control+End');await page.keyboard.insertText('新增内容');
 await expect.poll(()=>fs.readFile(file,'utf8')).toBe(original+'新增内容');
 await page.keyboard.press('Control+z');await expect.poll(()=>fs.readFile(file,'utf8')).toBe(original);
 await page.keyboard.press('Control+y');await expect.poll(()=>fs.readFile(file,'utf8')).toBe(original+'新增内容');
});

test('opens arbitrary extensions and extensionless files from the dialog and drag-drop',async()=>{
 for(const name of ['示例.txt','运行.log','应用.cfg','任意.weird','README','.env']){const next=path.join(root,name);await fs.writeFile(next,'# raw **text**\n');await open(next);await expect(page.locator('.file-tab.active')).toContainText(name);await expect(body()).toContainText('# raw **text**');}
 const dropped=path.join(root,'拖入.custom');await fs.writeFile(dropped,'<b>literal tag</b>');
 await page.evaluate(()=>{const input=document.createElement('input');input.type='file';input.id='drop-source';input.hidden=true;document.body.append(input);});await page.locator('#drop-source').setInputFiles(dropped);
 await page.evaluate(()=>{const input=document.querySelector<HTMLInputElement>('#drop-source')!,dataTransfer=new DataTransfer();for(const file of Array.from(input.files!))dataTransfer.items.add(file);document.querySelector('.app')!.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));});
 await expect(page.locator('.file-tab.active')).toContainText('拖入.custom');await expect(body()).toContainText('<b>literal tag</b>');await expect(body().locator('b')).toHaveCount(0);
 await page.locator('.file-tab.active .tab-close').click();await page.getByRole('button',{name:'最近打开的文档',exact:true}).click();await page.locator('.recent-items button').filter({hasText:'拖入.custom'}).click();await expect(body()).toContainText('<b>literal tag</b>');
});

test('pastes plain text, supports quick search and keeps the extension on rename and Save As',async()=>{
 await app.evaluate(({clipboard})=>clipboard.write({text:'**not bold**\n\tline',html:'<b>not bold</b>'}));await body().click();await page.keyboard.press('Control+End');await page.keyboard.press('Control+v');await expect(body()).toContainText('**not bold**');await expect(body().locator('strong')).toHaveCount(0);
 const quick=page.getByRole('textbox',{name:'快速搜索导航'});await quick.fill('not bold');await expect(body().locator('.text-search-match')).toHaveCount(1);await quick.press('Tab');await expect(body().locator('.text-search-match')).toHaveCount(0);
 await page.locator('.file-tab.active .tab-name').dblclick();const rename=page.getByRole('textbox',{name:'新文件名'});await rename.fill('改名.conf');await rename.press('Enter');await expect(page.locator('.file-tab.active')).toContainText('改名.conf');const renamed=path.join(root,'改名.conf');await expect.poll(()=>fs.readFile(renamed,'utf8')).toContain('**not bold**');
 const target=path.join(root,'副本.cfg');await app.evaluate(({dialog,Menu},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});Menu.getApplicationMenu()!.items.flatMap(group=>group.submenu?.items??[]).find(item=>item.accelerator==='CmdOrCtrl+Shift+S')!.click();},target);
 await expect(page.locator('.file-tab.active')).toContainText('副本.cfg');await expect(body()).toContainText('**not bold**');expect(await fs.readFile(target,'utf8')).toBe(await fs.readFile(renamed,'utf8'));
});

test('binary files fail without changing them or the current tab; Markdown still renders normally',async()=>{
 const binary=path.join(root,'binary.bin'),bytes=Buffer.from([0,1,2,3,4,5]);await fs.writeFile(binary,bytes);await open(binary);await expect(page.locator('.toast')).toContainText('二进制');await expect(page.locator('.file-tab.active')).toContainText('启动配置.conf');expect(await fs.readFile(binary)).toEqual(bytes);
 const md=path.join(root,'正常.md');await fs.writeFile(md,'# 标题\n\n**加粗**');await open(md);await expect(page.locator('.markdown-document h1')).toHaveText('标题');await expect(page.locator('.markdown-document strong')).toHaveText('加粗');
});

test('UTF-16 configuration files retain their encoding after editing and report it correctly',async()=>{
 for(const endian of ['LE','BE']){
  const target=path.join(root,`utf16-${endian}.cfg`),encode=(text:string)=>{const bytes=Buffer.from('\ufeff'+text,'utf16le');return endian==='BE'?bytes.swap16():bytes;};await fs.writeFile(target,encode('配置=中文\r\n'));await open(target);
  await expect(page.locator('.encoding')).toHaveText(`UTF-16 ${endian}`);await body().click();await page.keyboard.press('Control+End');await page.keyboard.insertText('新增=内容');
  await expect.poll(async()=>Array.from(await fs.readFile(target))).toEqual(Array.from(encode('配置=中文\r\n新增=内容')));
 }
});
