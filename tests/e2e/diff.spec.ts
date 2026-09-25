import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DocumentStore} from '../../src/main/storage';
let app:ElectronApplication,page:Page,root:string;
const button=()=>page.getByRole('button',{name:'与前一个标签比较',exact:true});
const dialog=()=>page.getByRole('dialog',{name:'文件差异对比'});
async function launch(names:string[],contents:string[]){
 const files=names.map(name=>path.join(root,name));for(let i=0;i<files.length;i++)await fs.writeFile(files[i],contents[i]);
 const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
 const executablePath=process.env.TODOLINE_TEST_EXE;app=await _electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[path.resolve('.')]),...files],env:env as Record<string,string>});page=await app.firstWindow();await expect(page.locator('.file-tab')).toHaveCount(files.length);await expect(page.locator('.file-tab.active')).toContainText(names.at(-1)!);await expect(page.locator('.document-scroller[data-active] .ProseMirror')).toBeVisible();
 return files;
}
async function openDiff(){await button().click();await expect(dialog()).toBeVisible();await expect(dialog().locator('.diff-summary')).not.toContainText('正在对比');await expect(dialog().locator('[role=alert]')).toHaveCount(0);}
test.beforeEach(async({},info)=>{root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});});
test.afterEach(async()=>{await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});

test('compares the immediate previous tab with aligned lines, inline marks and difference navigation',async({},info)=>{
 const files=await launch(['无关.txt','前一个.log','当前.cfg'],['unrelated','title\nremoved\nanchor\nvalue=123 foo=old\ntail','title\nanchor\nvalue=163 foo=new\nadded\ntail']);
 expect((await page.evaluate(()=>performance.getEntriesByType('resource').map(x=>x.name))).some(x=>/DiffView-|diff-worker-/.test(x))).toBe(false);
 await openDiff();await expect(dialog().locator('.diff-file strong')).toHaveText(['前一个.log','当前.cfg']);await expect(dialog().locator('.diff-summary')).toContainText('新增 1 行');await expect(dialog().locator('.diff-summary')).toContainText('删除 1 行');await expect(dialog().locator('.diff-summary')).toContainText('修改 1 行');
 await expect(dialog().locator('.diff-pane').first().locator('.diff-delete')).toContainText('removed');await expect(dialog().locator('.diff-pane').last().locator('.diff-add')).toContainText('added');expect(await dialog().locator('.diff-change mark').count()).toBeGreaterThan(2);await expect(dialog().locator('.diff-position')).toHaveText('1 / 2 处');
 await page.screenshot({path:info.outputPath('diff-dark.png')});await page.getByRole('button',{name:'下一个差异',exact:true}).click();await expect(dialog().locator('.diff-position')).toHaveText('2 / 2 处');await page.keyboard.press('F7');await expect(dialog().locator('.diff-position')).toHaveText('1 / 2 处');await page.keyboard.press('Shift+F7');await expect(dialog().locator('.diff-position')).toHaveText('2 / 2 处');
 await expect(page.locator('.workspace')).toHaveAttribute('inert','');await expect(page.locator('.titlebar')).not.toHaveAttribute('inert','');await page.keyboard.press('Escape');await expect(dialog()).toHaveCount(0);await expect(page.locator('.workspace')).not.toHaveAttribute('inert','');expect(await fs.readFile(files[0],'utf8')).toBe('unrelated');expect(await fs.readFile(files[1],'utf8')).toContain('value=123');expect(await fs.readFile(files[2],'utf8')).toContain('value=163');
 await page.getByRole('textbox',{name:'快速搜索导航'}).fill('value');await expect(page.locator('.document-scroller[data-active] .text-search-match')).toHaveCount(1);
 await page.getByRole('button',{name:'外观与设置',exact:true}).click();await page.getByRole('button',{name:'浅色',exact:true}).click();await page.keyboard.press('Escape');await openDiff();await page.screenshot({path:info.outputPath('diff-light.png')});await page.getByRole('button',{name:'关闭对比',exact:true}).click();await expect(dialog()).toHaveCount(0);
});

test('requires two adjacent files of the same document mode and uses current editor content',async()=>{
 await launch(['纯文本.txt','左.md','右.md'],['plain','# 标题\n\nold','# 标题\n\nold']);await page.locator('.file-tab').first().click();await expect(button()).toBeDisabled();await page.locator('.file-tab').nth(1).click();await expect(button()).toBeDisabled();await page.locator('.file-tab').nth(2).click();await expect(button()).toBeEnabled();
 await openDiff();await expect(dialog().locator('.diff-summary')).toHaveText('内容一致，无差异');await expect(page.getByRole('button',{name:'下一个差异',exact:true})).toBeDisabled();await page.keyboard.press('Escape');
 await page.locator('.document-scroller[data-active] .markdown-document').evaluate((el:any)=>{el.editor.commands.setTextSelection(el.editor.state.doc.content.size-1);el.editor.commands.insertContent(' live change');(document.querySelector('[aria-label="与前一个标签比较"]') as HTMLButtonElement).click();});
 await expect(dialog()).toBeVisible();await expect(dialog().locator('.diff-summary')).toContainText('修改 1 行');await expect(dialog().locator('.diff-pane').last()).toContainText('live change');await expect(dialog().locator('.diff-pane').first()).toContainText('# 标题');
});

test('large comparisons virtualize rows, align scroll positions and can jump to distant changes',async()=>{
 const lines=Array.from({length:8000},(_,i)=>`line ${i} ${'long text '.repeat(8)}`),right=[...lines];right[20]+=' early';right[7000]+=' late';await launch(['large-a.txt','large-b.txt'],[lines.join('\n'),right.join('\n')]);await openDiff();await expect(dialog().locator('.diff-summary')).toContainText('修改 2 行');expect(await dialog().locator('.diff-line').count()).toBeLessThan(120);
 await page.getByRole('button',{name:'下一个差异',exact:true}).click();await expect(dialog().locator('.diff-pane').last().locator('.diff-change')).toContainText('late');const panes=dialog().locator('.diff-scroll');await expect.poll(()=>panes.first().evaluate(el=>el.scrollTop)).toBeGreaterThan(100_000);expect(await panes.first().evaluate(el=>el.scrollTop)).toBe(await panes.last().evaluate(el=>el.scrollTop));
 await panes.last().evaluate(el=>el.scrollTop=5000);await expect.poll(()=>panes.first().evaluate(el=>el.scrollTop)).toBe(5000);expect(await dialog().locator('.diff-line').count()).toBeLessThan(120);
 // Schedule a scroll update and explicitly jump before its animation frame runs.
 await panes.last().evaluate(el=>{el.scrollTop=100;el.dispatchEvent(new Event('scroll',{bubbles:true}));document.querySelector<HTMLButtonElement>('[aria-label="上一个差异"]')!.click();});
 await expect(dialog().locator('.diff-pane').last().locator('.diff-change')).toContainText('early');
 await page.keyboard.press('Escape');await expect(dialog()).toHaveCount(0);
});

test('unequal line widths keep both panes aligned at the end of the files',async()=>{
 const lines=Array.from({length:100},(_,i)=>`row ${i}`),right=[...lines];right[0]='x'.repeat(300);right[99]='changed end';
 await launch(['short.txt','wide.txt'],[lines.join('\n'),right.join('\n')]);await openDiff();
 const panes=dialog().locator('.diff-scroll');expect(await panes.first().evaluate(el=>el.clientHeight)).toBe(await panes.last().evaluate(el=>el.clientHeight));
 await panes.last().evaluate(el=>el.scrollTop=el.scrollHeight);
 await expect.poll(async()=>await panes.first().evaluate(el=>el.scrollTop)-await panes.last().evaluate(el=>el.scrollTop)).toBe(0);
 await expect(dialog().locator('.diff-pane').last().locator('.diff-change')).toContainText('changed end');
});

test('TDE compares event text, creation/deadline metadata and completion without database IDs',async()=>{
 await launch(['seed.txt'],['seed']);const store=new DocumentStore();
 for(const [name,done,text] of [['left.tde',0,'正文旧'],['right.tde',1,'正文新']] as const){const file=path.join(root,name),doc=store.open(file,true);await store.save({...doc,events:[{id:-1,pos:0,created_at:1700000000,deadline_raw:'1分钟后',deadline_ts:1700000060,done,top_divider:1,content_text:text,content_html:`<p>${text}</p>`}]});store.close(doc.handle);await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();await expect(page.locator('.file-tab.active')).toContainText(name.replace('.tde',''));}
 await openDiff();await expect(dialog().locator('.diff-mode')).toHaveText('从左侧修改到右侧，需：');await expect(dialog().locator('.diff-summary')).toContainText('修改 2 行');await expect(dialog().locator('.diff-pane').first()).toContainText('未完成');await expect(dialog().locator('.diff-pane').last()).toContainText('已完成');await expect(dialog().locator('.diff-pane').last()).toContainText('截止 1分钟后');
});
