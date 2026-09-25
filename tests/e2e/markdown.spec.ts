import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {searchWindow} from './search-window';

let app: ElectronApplication, page: Page, root: string, file: string;
async function launch(open?: string) {
  const env:NodeJS.ProcessEnv = { ...process.env, TODOLINE_TEST: '1', TODOLINE_DATA_DIR: path.join(root, 'profile') }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.TODOLINE_TEST_EXE;
  app = await electron.launch({ ...(executablePath?{executablePath}:{}), args: [...(executablePath?[]:[path.resolve('.')]), ...(open ? ['--open', open] : [])], env: env as Record<string, string> });
  page = await app.firstWindow(); page.on('pageerror', error => console.error('MARKDOWN RENDERER', error));
  await expect(page.locator('.app')).toBeVisible();
}
test.beforeEach(async ({}, info) => {
  root = info.outputPath('workspace'); await fs.mkdir(root, { recursive: true }); file = path.join(root, '中文 笔记.md');
  await fs.writeFile(file, '# 主标题\n\n## 表格\n\n| 名称 | 值 |\n| --- | --- |\n| A | 1 |\n\n## 公式\n\n$$\nx^2 + y^2\n$$\n\n```js\n  run()\n```\n');
});
test.afterEach(async ({}, info) => { if (page && info.status !== info.expectedStatus) await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {}); await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); });

test('opens and edits native Markdown with a heading outline, formula rendering and no events', async () => {
  await launch(file); const body = page.locator('.markdown-document'); await expect(body).toBeVisible();
  await expect(page.getByRole('navigation', { name: '目录导航' })).toContainText('主标题'); await expect(body.locator('table')).toHaveCount(1);
  await expect(body.locator('.katex')).toBeVisible(); await expect(page.locator('.event-divider')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '全部事件', exact: true })).toHaveCount(0);
  await body.locator('h1').click(); await page.keyboard.press('End'); await page.keyboard.type(' edited');
  await expect.poll(() => fs.readFile(file, 'utf8')).toContain('# 主标题 edited');
  const saved = await fs.readFile(file, 'utf8'); expect(saved).toContain('x^2 + y^2'); expect(saved).toContain('```js'); expect(saved).not.toContain('content_html');
  await page.screenshot({ path: path.join(root, 'markdown-editor.png') });
});
test('restores Markdown tabs and preserves original bytes when untouched', async () => {
  const before = await fs.readFile(file); await launch(file); await expect(page.locator('.markdown-document')).toBeVisible();
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click(); await app.waitForEvent('close');
  expect(await fs.readFile(file)).toEqual(before); await launch(); await expect(page.locator('.markdown-document')).toBeVisible();
  await expect(page.locator('.file-tab.active')).toContainText('中文 笔记.md');
});
test('dropping real files opens tabs, deduplicates existing documents and leaves body text intact', async () => {
  await launch(file); await expect(page.locator('.markdown-document')).toBeVisible();
  const second = path.join(root, '第二份.md'); await fs.writeFile(second, '# 第二份\n\n正文');
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = 'drop-source'; input.style.display = 'none'; document.body.append(input); });
  await page.locator('#drop-source').setInputFiles([file, second]);
  await page.evaluate(() => { const input = document.querySelector<HTMLInputElement>('#drop-source')!, dataTransfer = new DataTransfer(); for (const file of Array.from(input.files!)) dataTransfer.items.add(file); document.querySelector('.app')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })); });
  await expect(page.locator('.file-tab')).toHaveCount(2); await expect(page.locator('.file-tab.active')).toContainText('第二份.md');
  await expect(page.locator('.document-scroller:visible .markdown-document')).toContainText('正文');
  expect(await fs.readFile(second, 'utf8')).toBe('# 第二份\n\n正文');
});
test('pastes rendered chat structures into Markdown and edits the formula source', async () => {
  await launch(file); const body = page.locator('.markdown-document'); await expect(body).toBeVisible();
  await app.evaluate(({ clipboard }) => clipboard.write({ text: '回复 公式', html: '<h2>回复</h2><p><span class="katex"><math><annotation encoding="application/x-tex">\\frac{a}{b}</annotation></math><span class="katex-html">duplicate</span></span></p><pre><code class="language-python">  print(1)</code></pre>' }));
  await body.locator('h1').click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+v');
  await expect(body.locator('h2')).toHaveText('回复'); await expect(body.locator('.md-formula')).toHaveCount(1); await expect(body.locator('code')).toContainText('  print(1)');
  await body.getByRole('button', { name: '编辑公式 LaTeX' }).click(); await body.getByRole('textbox', { name: 'LaTeX 源码' }).fill('x^3'); await body.getByRole('button', { name: '应用', exact: true }).click();
  await expect.poll(() => fs.readFile(file, 'utf8')).toContain('$x^3$');
});
test('a blank new tab auto-converts to Markdown, undo restores TDE and first save uses md', async () => {
  await launch(); await page.getByRole('button', { name: '新建文档 · Ctrl+N', exact: true }).click();
  await expect(page.locator('.todo-document')).toBeVisible(); await page.locator('.todo-document').click();
  await app.evaluate(({ clipboard }) => clipboard.writeText('# 标题\n\n## 小节\n\n**正文**'));
  await page.keyboard.press('Control+v'); await expect(page.locator('.markdown-document')).toBeVisible();
  await expect(page.locator('.file-tab')).toHaveCount(1); await expect(page.getByRole('navigation', { name: '目录导航' })).toContainText('小节');
  await expect(page.locator('.markdown-document')).toBeFocused();
  await page.keyboard.press('Control+z'); await expect(page.locator('.todo-document')).toBeVisible(); await expect(page.locator('.markdown-document')).toHaveCount(0);
  await page.locator('.todo-document').click(); await page.keyboard.press('Control+v'); await expect(page.locator('.markdown-document')).toBeVisible();
  const target = path.join(root, '自动转换.md'); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, target);
  // The hidden Playwright window does not receive native OS menu accelerators.
  // Exercise the same save command through its visible menu; native shortcut
  // delivery is covered separately by native-shortcuts.spec.ts using SendInput.
  await page.locator('.file-tab.active').click({button:'right'});await page.getByRole('button',{name:'立即保存 Ctrl S',exact:true}).click();
  await expect.poll(async () => fs.readFile(target, 'utf8').catch(() => '')).toContain('# 标题');
});
test('clearing typed content does not make a TDE tab eligible for automatic conversion', async () => {
  await launch(); await page.getByRole('button', { name: '新建文档 · Ctrl+N', exact: true }).click(); const body = page.locator('.todo-document'); await body.click();
  await page.keyboard.type('existing'); await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace');
  await app.evaluate(({ clipboard }) => clipboard.write({ text: '# 标题\n\n## 小节', html: '<h1>标题</h1><h2>小节</h2>' }));
  await page.keyboard.press('Control+v'); await expect(body).toContainText('# 标题'); await expect(page.locator('.markdown-document')).toHaveCount(0);
});
test('pasted images survive Save As, inline rename and an offline PDF export with math',async()=>{
  await launch(file);const body=page.locator('.markdown-document');await expect(body).toBeVisible();
  const bytes=await app.evaluate(({nativeImage})=>Array.from(nativeImage.createFromBitmap(Buffer.alloc(32*24*4,180),{width:32,height:24}).toPNG()));
  const image=path.join(root,'图片.png');await fs.writeFile(image,Buffer.from(bytes));
  await body.locator('h1').click();await page.locator('input[type=file][accept="image/*"]').setInputFiles(image);
  await expect(body.locator('.md-image img')).toBeVisible();await expect.poll(()=>fs.readFile(file,'utf8')).toContain('.assets/');
  const directory=path.join(root,'副本目录');await fs.mkdir(directory);const target=path.join(directory,'新文件.md');
  await app.evaluate(({dialog},target)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:target});},target);
  await page.locator('.file-tab.active').click({button:'right'});await page.getByRole('button',{name:'另存为… Ctrl Shift S',exact:true}).click();
  await expect(page.locator('.file-tab.active')).toContainText('新文件.md');
  await expect.poll(()=>body.locator('.md-image img').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBe(32);
  await page.locator('.file-tab.active .tab-name').dblclick();await page.getByRole('textbox',{name:'新文件名'}).fill('重命名.md');await page.getByRole('textbox',{name:'新文件名'}).press('Enter');
  await expect(page.locator('.file-tab.active')).toContainText('重命名.md');expect(await fs.readFile(path.join(directory,'重命名.md'),'utf8')).toContain('.assets/');
  const pdf=path.join(root,'导出.pdf');await app.evaluate(({dialog},target)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:target});},pdf);
  await page.getByRole('button',{name:'导出',exact:true}).click();await page.getByRole('button',{name:'PDF 文档 .pdf',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'导出完成'})).toBeVisible();expect((await fs.readFile(pdf)).subarray(0,5).toString()).toBe('%PDF-');expect((await fs.stat(pdf)).size).toBeGreaterThan(5000);
});
test('directory navigation follows headings, folds children and updates after a title edit',async()=>{
  await fs.writeFile(file,'# 第一章\n\n## 子章节\n\n'+Array.from({length:60},(_,i)=>`第 ${i} 段正文。`).join('\n\n')+'\n\n# 第二章\n\n结束');
  await launch(file);const nav=page.getByRole('navigation',{name:'目录导航'});await expect(nav.getByRole('button',{name:'子章节',exact:true})).toBeVisible();
  await nav.getByRole('button',{name:'折叠 第一章'}).click();await expect(nav.getByRole('button',{name:'子章节',exact:true})).toHaveCount(0);
  await nav.getByRole('button',{name:'第二章',exact:true}).click();await expect(nav.getByRole('button',{name:'第二章',exact:true})).toHaveAttribute('aria-current','location');
  // The final heading cannot reach the viewport top when little text follows
  // it. A delayed native scroll event must not select the preceding chapter.
  await page.locator('.document-scroller[data-active]').evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
  await expect(nav.getByRole('button',{name:'第二章',exact:true})).toHaveAttribute('aria-current','location');
  await page.keyboard.press('End');await page.keyboard.type(' updated');await expect(nav.getByRole('button',{name:'第二章 updated',exact:true})).toBeVisible();
});

test('restores Markdown scroll after lazy editor loading and searches an unvisited Markdown tab',async()=>{
  const second=path.join(root,'后台.md'),profile=path.join(root,'profile');await fs.mkdir(profile,{recursive:true});
  await fs.writeFile(file,'# 长文\n\n'+Array.from({length:100},(_,i)=>`正文段落 ${i}`).join('\n\n'));
  await fs.writeFile(second,'# 后台章节\n\nuniqueNeedle');
  await fs.writeFile(path.join(profile,'session.json'),JSON.stringify({tabs:[{path:file,cursor:2,scroll:900},{path:second,cursor:1,scroll:0}],active:0,recent:[file,second],settings:{advanceMinutes:-1}}));
  await launch();await expect(page.locator('.markdown-document')).toHaveCount(1);
  await expect.poll(()=>page.locator('.document-scroller[data-active]').evaluate(el=>el.scrollTop)).toBeGreaterThan(800);
  await page.getByRole('button',{name:'搜索 · Ctrl+F',exact:true}).click();const search=await searchWindow(app);
  await search.getByRole('button',{name:'所有打开文件',exact:true}).click();await search.getByRole('textbox',{name:'搜索内容'}).fill('uniqueNeedle');
  await expect(search.locator('.search-count')).toContainText('1 处匹配');
  // Search automatically activates its first result; the destination mounts
  // only at that point, as it does when the user clicks its tab.
  await expect(page.locator('.markdown-document')).toHaveCount(2);
  await search.getByRole('button',{name:'下一个搜索结果'}).click();
  await expect(page.locator('.file-tab.active')).toContainText('后台.md');
  await expect(page.locator('.document-scroller[data-active] .md-search-match')).toHaveText('uniqueNeedle');
});

test('code highlighting keeps editable code and local images can be copied into another Markdown document',async()=>{
  await fs.writeFile(file,'# 原文\n\n```js\nconst answer = 42;\n```');await launch(file);
  const body=page.locator('.markdown-document');await expect(body.locator('.hljs-keyword')).toHaveText('const');
  await body.locator('code').click();await page.keyboard.press('End');await page.keyboard.type(' // editable');
  await expect.poll(()=>fs.readFile(file,'utf8')).toContain('const answer = 42; // editable');
  const image=path.join(root,'copy.png');const bytes=await app.evaluate(({nativeImage})=>Array.from(nativeImage.createFromBitmap(Buffer.alloc(24*24*4,180),{width:24,height:24}).toPNG()));await fs.writeFile(image,Buffer.from(bytes));
  await body.locator('h1').click();await page.locator('input[type=file][accept="image/*"]').setInputFiles(image);await expect(body.locator('.md-image img')).toBeVisible();
  await body.locator('h1').click();await page.keyboard.press('Control+a');await page.keyboard.press('Control+c');
  await expect.poll(()=>app.evaluate(({clipboard})=>clipboard.readHTML())).toContain('data:image/png;base64,');
  const target=path.join(root,'目标.md');await fs.writeFile(target,'');await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},target);
  await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();const destination=page.locator('.document-scroller[data-active] .markdown-document');await expect(page.locator('.file-tab.active')).toContainText('目标.md');
  await destination.click();await page.keyboard.press('Control+v');await expect(destination.locator('.md-image img')).toBeVisible();
  await expect.poll(()=>destination.locator('.md-image img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(24);
  await expect.poll(()=>fs.readFile(target,'utf8')).toContain('目标.assets/');
});
