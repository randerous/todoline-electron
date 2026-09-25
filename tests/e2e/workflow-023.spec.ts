import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DocumentStore} from '../../src/main/storage';
let app:ElectronApplication,page:Page,root:string,file:string;
const body=()=>page.locator('.document-scroller[data-active] .todo-document');
const clipboard=()=>app.evaluate(({clipboard})=>({text:clipboard.readText(),html:clipboard.readHTML(),formats:clipboard.availableFormats(),privateHtml:clipboard.readBuffer('application/x-todoline-html').toString('utf8'),events:clipboard.readBuffer('application/x-tde-events').toString('utf8')}));
test.beforeEach(async({},info)=>{
 root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});file=path.join(root,'外发测试.tde');
 const store=new DocumentStore(),doc=store.open(file,true);await store.save({...doc,events:Array.from({length:30},(_,i)=>({id:-i-1,pos:i*1024,created_at:1700000000+i,deadline_raw:i===2?'下周二':'',deadline_ts:null,done:0,top_divider:i===0?1:0,content_html:`<p><b>正文 ${i+1}</b></p>`,content_text:`正文 ${i+1}`}))});store.close(doc.handle);
 const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
 const executablePath=process.env.TODOLINE_TEST_EXE;app=await _electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[path.resolve('.')]),'--open',file],env:env as Record<string,string>});page=await app.firstWindow();await expect(body()).toBeVisible();await app.evaluate(({BrowserWindow})=>{const main=BrowserWindow.getAllWindows()[0];main.show();main.focus();});
});
test.afterEach(async()=>{await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
async function copyAll(selector=body()) {await selector.evaluate((el:any)=>{el.editor.commands.selectAll();el.editor.view.focus();});await page.keyboard.press('Control+c');}
test('rename has no blue frame; navigation has a straight marker and compact quick search',async({},info)=>{
 await page.locator('.tab-name').dblclick();const name=page.getByRole('textbox',{name:'新文件名'});await expect(name).toBeFocused();
 expect(await name.evaluate(el=>({outline:getComputedStyle(el).outlineStyle,border:getComputedStyle(el).borderColor}))).toEqual({outline:'none',border:'rgba(0, 0, 0, 0)'});
 await page.screenshot({path:info.outputPath('rename.png')});await name.press('Escape');
 const row=page.locator('.event-navigation .in-view').first();await expect(row).toBeVisible();
 expect(await row.evaluate(el=>({shadow:getComputedStyle(el).boxShadow,width:getComputedStyle(el,'::before').width,top:getComputedStyle(el,'::before').top}))).toEqual({shadow:'none',width:'2px',top:'5px'});
 const query=page.getByRole('textbox',{name:'快速搜索导航'});await query.fill('下周二');await expect(page.locator('.event-navigation-rows')).toHaveCSS('height','960px');await expect(page.locator('.event-navigation [data-match]')).toContainText('正文 3');await query.press('Enter');
 await expect(page.locator('.event-navigation [data-match][data-visible]')).toHaveCount(1);await page.screenshot({path:info.outputPath('sidebar-search.png')});
 const buttons=page.locator('.sidebar-bottom > button');await expect(buttons.nth(0)).toHaveAttribute('aria-label','打开所在文件夹');await expect(buttons.nth(1)).toHaveAttribute('aria-label','事件日历');
 await query.fill('没有这样的内容');await expect(page.locator('.event-navigation [data-match]')).toHaveCount(0);await expect(page.locator('.event-navigation-rows')).toHaveCSS('height','960px');await query.press('Escape');expect(await page.locator('.event-navigation .outline-item').count()).toBeGreaterThan(1);
});
test('TDE text copy exports Unicode only with divider dates, retaining internal event formatting',async()=>{
 await copyAll();await expect.poll(async()=> (await clipboard()).text).toContain('====');const copied=await clipboard();expect(copied.text).toContain('截止 下周二');expect(copied.text).toContain('2023-');expect(copied.html).toBe('');expect(copied.privateHtml).toContain('<b>');expect(JSON.parse(copied.events).events).toHaveLength(30);
 await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await expect(page.locator('.file-tab')).toHaveCount(2);await expect(page.locator('.file-tab.active')).not.toContainText('外发测试');await body().focus();await page.keyboard.press('Control+v');await expect(body().locator('.event-divider')).toHaveCount(30);await expect(body().locator('strong')).toHaveCount(30);
});
test('Markdown copy exports rendered text without syntax and retains private formatting',async()=>{
 const md=path.join(root,'复制.md');await fs.writeFile(md,'# 标题\n\n**加粗内容** 和 $x^2$\n\n```js\nrun()\n```');await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},md);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();const editor=page.locator('.markdown-document');await expect(editor).toBeVisible();await copyAll(editor);
 await expect.poll(async()=> (await clipboard()).text).toContain('run()');const copied=await clipboard();expect(copied.text).toBe('标题\n加粗内容 和 x^2\nrun()\n');expect(copied.html).toBe('');expect(copied.privateHtml).toContain('<strong>');
 const internal=await page.evaluate(()=>window.desktop.readClipboard());expect(internal.html).toContain('data-md-math-inline');const quick=page.getByRole('textbox',{name:'快速搜索导航'});await quick.fill('标题');await expect(page.locator('.markdown-outline-heading')).toHaveCount(1);await quick.fill('不存在');await expect(page.locator('.markdown-outline-heading')).toHaveCount(1);await expect(editor.locator('.md-search-match')).toHaveCount(0);await quick.press('Escape');await expect(page.locator('.markdown-outline-heading')).toHaveCount(1);
});
test('mixed TDE copy provides portable images and formatted HTML externally',async()=>{
 const png=await app.evaluate(({nativeImage})=>Array.from(nativeImage.createFromBitmap(Buffer.alloc(4*4*4,255),{width:4,height:4}).toPNG()));
 const asset=await page.evaluate(async({file,png})=>{const doc=await window.desktop.openRecent(file);return window.desktop.addAsset(doc.handle,new Uint8Array(png),4,4);},{file,png});
 await body().evaluate((el:any,asset)=>el.editor.commands.setContent({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'图片说明',marks:[{type:'bold'}]},{type:'image',attrs:{assetId:asset,width:4,height:4}}]}]}),asset);await copyAll();await expect.poll(async()=> (await clipboard()).html).toContain('data:image/png');const copied=await clipboard();expect(copied.html).toContain('<strong>图片说明</strong>');expect(copied.html).not.toContain('src="asset:');expect(copied.events).toContain('asset:');
});
test('PowerPoint pastes copied text at an existing text range without adding a shape',async({},info)=>{
 await body().evaluate((el:any)=>el.editor.commands.setContent('<p><strong>PasteText</strong></p>'));await copyAll();await expect.poll(async()=> (await clipboard()).text).toBe('PasteText');expect((await clipboard()).html).toBe('');
 const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tests/fixtures/powerpoint-text-paste.ps1')],{encoding:'utf8',windowsHide:true,timeout:30000}));expect(result).toEqual({text:'APasteTextB',shapes:1});await fs.writeFile(info.outputPath('powerpoint-result.json'),JSON.stringify(result));
});
