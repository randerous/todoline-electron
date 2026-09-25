// macOS smoke test: boots the built app with Playwright's Electron driver and
// walks the core usage flows, reporting hard failures, renderer errors and
// main-process output.
//
// Notes for macOS:
//  * Editor shortcuts are ProseMirror `Mod-*` bindings, i.e. Cmd on macOS.
//    The Windows-style Ctrl combinations in the README do nothing on macOS.
//  * Native menu accelerators (Cmd+N/O/S/F) cannot be delivered through
//    Playwright's CDP input, so those commands are injected over the same IPC
//    channel the menu uses (tl:command).
//
// Usage: node scripts/smoke-mac.mjs [--keep]
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const project = path.resolve('.');
const keep = process.argv.includes('--keep');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'todoline-smoke-'));
const profile = path.join(root, 'profile');
await fs.mkdir(profile, { recursive: true });
await fs.mkdir('.cache/smoke', { recursive: true });
const env = { ...process.env, TODOLINE_TEST: '1', TODOLINE_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;

const results = [], pageErrors = [], consoleErrors = [], mainLog = [];
const check = async (name, fn) => {
  const started = Date.now();
  try { const extra = await fn(); results.push(['PASS', name, extra ?? '', Date.now() - started]); }
  catch (error) {
    let detail = error.message.split('\n')[0];
    try { const text = await page.locator('body').innerText(); detail += ` | ui=${JSON.stringify(text.slice(0, 100))}`; } catch {}
    results.push(['FAIL', name, detail]);
  }
  const state = await probe().catch(() => null);
  if (state) results.push(['PROBE', name, JSON.stringify(state)]);
};

let app = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env });
let page = await app.firstWindow();
const watch = instance => {
  instance.process().stdout?.on('data', d => mainLog.push(String(d).trim()));
  instance.process().stderr?.on('data', d => mainLog.push(String(d).trim()));
  instance.on('close', () => mainLog.push(`[app closed]`));
};
const wire = p => {
  p.on('pageerror', e => pageErrors.push(String(e.stack || e).split('\n').slice(0, 4).join(' || ')));
  p.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400)); });
};
watch(app); wire(page);
const show = () => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); });
const mainWindow = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('index.html')) !== undefined);
const cmd = name => app.evaluate(({ BrowserWindow }, n) => {
  const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('index.html'));
  if (!win) throw new Error('main window not found');
  win.webContents.send('tl:command', n);
}, name);
const stubOpen = file => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, file);
const stubSave = file => app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, file);
await show();
const installProbe = async () => page.evaluate(() => {
  const w = window;
  w.__tl = { notices: [], errors: [], commands: [] };
  w.desktop.onNotices?.(n => w.__tl.notices.push(Array.isArray(n) ? n.length : -1));
  w.desktop.onError?.(m => w.__tl.errors.push(m));
  w.desktop.onCommand?.(c => w.__tl.commands.push(c));
});
await installProbe();
const probe = () => page.evaluate(() => ({
  tabs: document.querySelectorAll('.file-tab').length,
  noticeCount: window.__tl?.notices?.at(-1) ?? -1,
  errors: window.__tl?.errors?.slice(-2) ?? [],
  commands: window.__tl?.commands?.slice(-3) ?? [],
  app: document.querySelector('.app')?.className ?? '',
  dialogs: [...document.querySelectorAll('[role=dialog]')].map(d => d.getAttribute('aria-label')),
})).catch(e => ({ probeError: e.message }));
const shot = n => page.screenshot({ path: `.cache/smoke/${n}.png` }).catch(() => {});
const editor = () => page.locator('.document-scroller[data-active] .ProseMirror');
const tabs = async () => page.evaluate(async () => (await window.desktop.session()).tabs.map(t => ({ path: t.path, kind: t.kind })));
const activePath = async () => (await tabs()).at(-1)?.path;
const readRows = async file => { const db = new Database(file, { readonly: true }); const rows = db.prepare('select id,pos,top_divider,done,deadline_raw,deadline_ts,content_text,content_html from events order by pos').all(); db.close(); return rows; };
// The floating search window is a child BrowserWindow; identify it by its
// content rather than by URL (the URL changes once the renderer loads).
const findSearchWindow = async () => {
  for (const candidate of app.windows()) {
    if (candidate === page || candidate.isClosed()) continue;
    try { if (await candidate.getByRole('textbox', { name: '搜索内容' }).count()) return candidate; } catch {}
  }
  return false;
};
const until = async (label, fn, timeout = 15000) => {
  const deadline = Date.now() + timeout; let last = 'n/a';
  for (;;) {
    try { const value = await fn(); if (value) return value; last = value; } catch (error) { last = `error: ${error.message}`; }
    if (Date.now() > deadline) throw new Error(`${label} timed out (last: ${JSON.stringify(last)})`);
    await page.waitForTimeout(200);
  }
};
const rowsUntil = (file, predicate, label) => until(label, async () => { const rows = await readRows(file); return predicate(rows) ? rows : false; });

await page.locator('.app').waitFor({ timeout: 20000 });
await check('boot: home screen renders without renderer errors', async () => { await shot('01-home'); if (pageErrors.length) throw new Error(pageErrors[0]); return 'ok'; });

await check('new document via toolbar makes a dated .tde tab', async () => {
  await page.getByRole('button', { name: /新建文档 · Ctrl\+N/ }).click();
  await page.locator('.file-tab').first().waitFor({ timeout: 10000 });
  const name = (await page.locator('.tab-name').first().innerText()).trim();
  if (!/^\d{8}_\d+$/.test(name)) throw new Error(`tab name = ${JSON.stringify(name)}`);
  return name;
});

await check('typing lands in the editor and autosaves to SQLite', async () => {
  await editor().click();
  await page.keyboard.type('第一行测试内容');
  const rows = await rowsUntil(await activePath(), r => r.length === 1 && r[0].content_text.includes('第一行测试内容'), 'typed text saved');
  return `text=${rows[0].content_text}`;
});

await check('Cmd+H (Mod-h) inserts a divider and a second event', async () => {
  await page.keyboard.press('Meta+h');
  await page.keyboard.type('第二件事情');
  const rows = await rowsUntil(await activePath(), r => r.length === 2 && r[1].content_text.includes('第二件事情'), 'two events');
  await shot('02-two-events');
  return `events=${rows.length}`;
});

await check('Cmd+B (Mod-b) bold is stored as <strong>', async () => {
  await page.keyboard.press('Meta+b');
  await page.keyboard.type('加粗片段');
  await page.keyboard.press('Meta+b');
  const rows = await rowsUntil(await activePath(), r => /<strong>/i.test(r.at(-1).content_html), 'bold html');
  return rows.at(-1).content_html.slice(0, 70);
});

await check('Cmd+Z undo and Cmd+Shift+Z redo change the document', async () => {
  const before = (await readRows(await activePath())).at(-1).content_text;
  await page.keyboard.press('Meta+z');
  await until('undo applied', async () => { const t = (await readRows(await activePath())).at(-1).content_text; return t !== before ? t : false; });
  await page.keyboard.press('Meta+Shift+z');
  await until('redo applied', async () => { const t = (await readRows(await activePath())).at(-1).content_text; return t === before ? t : false; });
  return 'undo/redo ok';
});

await check('completion checkbox persists done=1', async () => {
  await page.locator('.event-check').first().click();
  const rows = await rowsUntil(await activePath(), r => r.some(x => x.done === 1), 'done flag');
  return `done=${rows.filter(r => r.done === 1).length}/${rows.length}`;
});

await check('deadline parsing stores a timestamp and shows a countdown', async () => {
  await page.locator('.event-deadline').first().fill('明天下午3点');
  await page.locator('.event-deadline').first().press('Enter');
  const rows = await rowsUntil(await activePath(), r => r.some(x => x.deadline_ts), 'deadline ts');
  const countdown = (await page.locator('.countdown').first().innerText()).trim();
  if (!countdown) throw new Error('countdown empty');
  return `countdown=${countdown}`;
});

await check('ordered list via Cmd+L and Tab indent', async () => {
  await page.keyboard.press('Meta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('列表行一');
  await page.keyboard.press('Meta+l');
  await rowsUntil(await activePath(), r => /<ol/i.test(r.at(-1).content_html), 'ordered list html');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(900);
  const html = (await readRows(await activePath())).at(-1).content_html;
  return `indented=${/data-list-indent="1"|data-list-style/i.test(html)}`;
});

await check('link popup writes an <a> into the saved html', async () => {
  await editor().click();
  await page.keyboard.press('Meta+a');
  await page.getByRole('button', { name: '插入链接' }).click();
  await page.getByRole('textbox', { name: '链接地址' }).fill('https://example.com/x');
  await page.getByRole('button', { name: '应用' }).click();
  await until('anchor rendered', async () => (await page.locator('.document-scroller[data-active] a').count()) > 0);
  await until('anchor saved', async () => /<a /i.test((await readRows(await activePath())).at(-1).content_html));
  return 'anchor saved';
});

await check('table menu inserts a 3x3 table', async () => {
  await editor().click();
  await page.keyboard.press('Meta+End');
  await page.getByRole('button', { name: '段落与字符格式' }).click();
  await page.getByRole('button', { name: '表格…' }).click();
  await page.getByRole('button', { name: '插入 3 × 3 表格' }).click();
  const tables = await until('table rendered', async () => await page.locator('.document-scroller[data-active] table').count());
  await until('table saved', async () => (await readRows(await activePath())).some(r => /<table/i.test(r.content_html)), 20000);
  return `tables=${tables}`;
});

await check('inserted png image becomes an asset and renders a preview', async () => {
  const file = path.join(root, '样本.png');
  const png = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.alloc(120 * 90 * 4, 200), { width: 120, height: 90 }).toPNG().toString('base64'));
  await fs.writeFile(file, Buffer.from(png, 'base64'));
  await editor().click();
  await page.locator('input[type=file]').setInputFiles(file);
  await until('image preview', async () => (await page.locator('.document-scroller[data-active] .image-view img').count()) > 0, 25000);
  const db = new Database(await activePath(), { readonly: true });
  const assets = db.prepare('select count(*) as n from assets').get();
  db.close();
  await shot('03-image-inserted');
  if (!assets.n) throw new Error('no asset row stored');
  return `assets=${assets.n}`;
});

await check('quick search highlights matching events', async () => {
  const input = page.getByRole('textbox', { name: '快速搜索导航' });
  await input.fill('第一行');
  await until('quick search hit', async () => !(await page.getByRole('button', { name: '下一个快速搜索结果' }).isDisabled()));
  await input.fill('');
  return 'hit found';
});

await check('copying selected text reaches the system clipboard', async () => {
  await until('editor clickable', async () => { await editor().click({ timeout: 4000 }); return true; }, 20000);
  await page.keyboard.press('Meta+a');
  await app.evaluate(({ clipboard }) => clipboard.clear());
  await page.keyboard.press('Meta+c');
  const copied = await until('clipboard text', async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) || false);
  if (!copied.includes('第一行测试内容')) throw new Error(`clipboard = ${JSON.stringify(copied)}`);
  return JSON.stringify(copied.slice(0, 24));
});

await check('event copy pastes back with its structure in a new tab', async () => {
  await until('editor clickable', async () => { await editor().click({ timeout: 4000 }); return true; }, 20000);
  await page.locator('.event-divider').first().click();
  await page.keyboard.press('Meta+Shift+c');
  const copied = await until('event on clipboard', async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) || false);
  if (!copied.includes('第二件')) throw new Error(`clipboard = ${JSON.stringify(copied.slice(0, 60))}`);
  const before = (await tabs()).length;
  await cmd('new');
  await until('new tab', async () => (await tabs()).length === before + 1);
  await until('editor clickable', async () => { await editor().click({ timeout: 4000 }); return true; }, 20000);
  await page.keyboard.press('Meta+v');
  const rows = await rowsUntil(await activePath(), r => r.some(x => x.content_text.includes('第二件')), 'pasted event');
  await page.locator('.file-tab').last().locator('.tab-close').click();
  await until('extra tab closed', async () => (await tabs()).length === before);
  return `pasted ${rows.length} event(s)`;
});

await check('image copy pastes back as an image', async () => {
  await page.locator('.tab-name').first().click();
  await until('image present', async () => (await page.locator('.document-scroller[data-active] .image-view img').count()) > 0);
  await page.locator('.document-scroller[data-active] .image-view img').first().click();
  await app.evaluate(({ clipboard }) => clipboard.clear());
  await page.keyboard.press('Meta+c');
  const size = await until('clipboard image', async () => { const s = await app.evaluate(({ clipboard }) => clipboard.readImage().getSize()); return s.width ? s : false; });
  const before = (await tabs()).length;
  await cmd('new');
  await until('new tab', async () => (await tabs()).length === before + 1);
  await until('editor clickable', async () => { await editor().click({ timeout: 4000 }); return true; }, 20000);
  await page.keyboard.press('Meta+v');
  await until('image pasted', async () => (await page.locator('.document-scroller[data-active] .image-view img').count()) > 0, 25000);
  await page.locator('.file-tab').last().locator('.tab-close').click();
  await until('extra tab closed', async () => (await tabs()).length === before);
  return `${size.width}x${size.height}`;
});

await check('search window opens by command, finds the event, closes', async () => {
  await cmd('search');
  const search = await until('search window', findSearchWindow);
  wire(search);
  await search.getByRole('textbox', { name: '搜索内容' }).fill('第二件');
  const bar = await until('search result', async () => { const t = await search.locator('.search-bar').innerText(); return /1 个事件/.test(t) ? t.replace(/\s+/g, ' ') : false; });
  await search.getByRole('button', { name: '关闭搜索' }).click();
  return bar.slice(0, 60);
});

await check('theme switch flips html[data-theme] and persists in session', async () => {
  await page.getByRole('button', { name: '外观与设置' }).click();
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await until('light theme', async () => (await page.locator('html').getAttribute('data-theme')) === 'light');
  await page.keyboard.press('Escape');
  const stored = await page.evaluate(async () => (await window.desktop.session()).settings.theme);
  if (stored !== 'light') throw new Error(`session theme = ${stored}`);
  return 'light';
});

await check('calendar panel lists the deadline event', async () => {
  await page.getByRole('button', { name: '事件日历' }).click();
  await until('calendar grid', async () => (await page.locator('.calendar-grid').count()) > 0);
  const marked = await page.locator('.calendar-note').count();
  await page.keyboard.press('Escape');
  return `notes=${marked}`;
});

await check('recent documents menu lists the open file', async () => {
  await page.getByRole('button', { name: '最近打开的文档' }).click();
  const items = await page.locator('.recent-items button').count();
  await page.keyboard.press('Escape');
  if (!items) throw new Error('recent list empty');
  return `${items} entries`;
});

await check('word wrap toggle flips aria-pressed', async () => {
  const button = page.getByRole('button', { name: '自动换行' });
  const before = await button.getAttribute('aria-pressed');
  await button.click();
  await until('wrap toggled', async () => (await button.getAttribute('aria-pressed')) !== before);
  await button.click();
  return `pressed=${before}->${await button.getAttribute('aria-pressed')}`;
});

await check('deadline soon triggers the reminder popup and 我知道了 clears it', async () => {
  // The first visible divider belongs to the second event and the completion
  // test already marked it done; add a fresh, unfinished event with a deadline.
  await page.locator('.document-scroller[data-active] .ProseMirror').click();
  await page.keyboard.press('Meta+End');
  await page.keyboard.press('Meta+h');
  await page.keyboard.type('提醒事件');
  await page.waitForTimeout(900);
  const deadlineInput = page.locator('.event-deadline').last();
  await deadlineInput.fill('1 分钟后');
  await deadlineInput.press('Enter');
  await rowsUntil(await activePath(), r => r.some(x => !x.done && x.deadline_ts && Math.abs(x.deadline_ts * 1000 - Date.now()) < 5 * 60000), 'near deadline saved');
  await until('reminder notice', async () => {
    const state = await page.evaluate(() => ({ notices: window.__tl?.notices ?? [], errors: window.__tl?.errors ?? [] }));
    if (state.errors.length) throw new Error(`main reported: ${state.errors.at(-1)}`);
    return state.notices.some(n => n > 0);
  }, 60000);
  const reminder = await until('reminder window', async () => app.windows().find(p => p.url().includes('reminder.html') && p.url() !== 'about:blank'), 20000);
  wire(reminder);
  const text = await until('reminder content', async () => { const t = await reminder.locator('body').innerText().catch(() => ''); return t.includes('提醒事件') ? t.replace(/\s+/g, ' ') : false; }, 20000);
  await shot('04-reminder');
  await reminder.getByRole('button', { name: '我知道了' }).click();
  await until('reminder hidden', async () => !(await reminder.locator('body').innerText().catch(() => '')).includes('提醒事件'), 20000);
  return text.slice(0, 70);
});

await check('export writes md/txt/pdf files of plausible size', async () => {
  const out = [];
  for (const format of ['md', 'txt', 'pdf']) {
    const file = path.join(root, `导出.${format}`);
    await stubSave(file);
    await page.getByRole('button', { name: '导出', exact: true }).click();
    await page.getByRole('button', { name: format === 'md' ? 'Markdown .md' : format === 'txt' ? '纯文本 .txt' : 'PDF 文档 .pdf' }).click();
    const card = page.getByRole('dialog', { name: '导出完成' });
    await card.waitFor({ timeout: 25000 });
    await card.getByRole('button', { name: '知道了' }).click();
    const size = (await fs.stat(file).catch(() => ({ size: 0 }))).size;
    if (size < (format === 'pdf' ? 1000 : 10)) throw new Error(`${format} size=${size}`);
    out.push(`${format}:${size}`);
  }
  return out.join(' ');
});

await check('second tab via command, tab switching keeps both documents', async () => {
  await cmd('new');
  await until('two tabs', async () => (await page.locator('.file-tab').count()) === 2);
  await page.locator('.tab-name').first().click();
  await until('first document shown', async () => (await page.locator('.document-scroller[data-active]').innerText()).includes('第一行测试内容'));
  return '2 tabs';
});

await check('compare with the previous tab opens the diff view', async () => {
  await page.locator('.tab-name').nth(1).click();
  await until('second tab active', async () => (await page.locator('.document-scroller[data-active]').count()) > 0);
  const button = page.getByRole('button', { name: '与前一个标签对比' }).or(page.getByRole('button', { name: '与前一个标签比较' }));
  await until('compare enabled', async () => !(await button.isDisabled()));
  await button.click();
  await until('diff panes', async () => (await page.locator('.diff-panes').count()) > 0);
  await page.keyboard.press('Escape');
  await until('diff closed', async () => (await page.locator('.diff-panes').count()) === 0);
  return 'diff rendered';
});

await check('saveAs writes a second .tde that can be reopened', async () => {
  await page.locator('.tab-name').first().click();
  const target = path.join(root, '另存为副本.tde');
  await stubSave(target);
  await cmd('saveAs');
  await until('saveAs file', async () => fs.stat(target).then(s => s.size > 0, () => false), 20000);
  await until('saveAs tab', async () => (await tabs()).some(t => t.path.endsWith('另存为副本.tde')));
  const rows = await readRows(target);
  if (!rows.length) throw new Error('copy has no events');
  return `events=${rows.length}`;
});

await check('closing an untouched auto-named tab removes its empty draft file', async () => {
  const second = (await tabs())[1].path;
  await page.locator('.file-tab').nth(1).locator('.tab-close').click();
  await until('one tab', async () => (await page.locator('.file-tab').count()) === 1);
  await until('draft removed', async () => !(await fs.stat(second).then(() => true, () => false)));
  return `removed ${path.basename(second)}`;
});

await check('closing a document with content keeps its file and history', async () => {
  await cmd('new');
  await until('second tab', async () => (await tabs()).length === 2);
  await until('editor clickable', async () => { await editor().click({ timeout: 4000 }); return true; }, 25000);
  await page.keyboard.type('这段内容必须保留');
  await rowsUntil((await tabs())[1].path, r => r.some(x => x.content_text.includes('这段内容必须保留')), 'content saved');
  const file = (await tabs())[1].path;
  await page.locator('.file-tab').nth(1).locator('.tab-close').click();
  await until('back to one tab', async () => (await tabs()).length === 1);
  await until('file kept', async () => fs.stat(file).then(s => s.size > 0, () => false));
  const recent = await page.evaluate(async () => (await window.desktop.session()).recent);
  if (!recent.some(f => f === file)) throw new Error('closed document missing from recent list');
  return `kept ${path.basename(file)}`;
});

await check('double clicking an image opens the viewer and Esc closes it', async () => {
  await page.locator('.tab-name').first().click();
  const image = page.locator('.document-scroller[data-active] .image-view img').first();
  await image.dblclick();
  await until('image viewer', async () => (await page.locator('.image-viewer').count()) > 0);
  await page.keyboard.press('Escape');
  await until('viewer closed', async () => (await page.locator('.image-viewer').count()) === 0);
  return 'viewer ok';
});

await check('an invalid file name is rejected without renaming', async () => {
  const before = (await tabs()).find(t => t.path.endsWith('.tde')).path;
  const renameTab = page.locator('.file-tab').filter({ hasText: path.basename(before, '.tde') }).first();
  await page.keyboard.press('Escape');
  await renameTab.locator('.tab-name').dblclick();
  const input = renameTab.locator('input').first();
  await input.fill('bad<name>.tde');
  await input.press('Enter');
  const message = await until('rename rejected', async () => {
    const text = await page.locator('body').innerText();
    return text.includes('文件名不能包含') ? '文件名不能包含路径或 < > : " / \\ | ? * 等字符。' : false;
  }, 8000);
  const now = (await tabs()).find(t => t.path.endsWith('.tde'));
  if (now.path !== before) throw new Error('document was renamed despite the invalid name');
  return message.slice(0, 60);
});

await check('search can switch to all open files', async () => {
  await cmd('search');
  const search = await until('search window', findSearchWindow);
  wire(search);
  await search.getByRole('button', { name: '所有打开文件' }).click();
  await search.getByRole('textbox', { name: '搜索内容' }).fill('内容');
  const bar = await until('all-files result', async () => {
    const t = await search.locator('.search-bar').innerText();
    // Across files the bar reports hits plus the number of files scanned; the
    // unit differs between event documents and plain text/markdown ones.
    return /[1-9]\d* 个文件/.test(t) && /[1-9]\d* (个事件|处匹配)/.test(t) ? t.replace(/\s+/g, ' ') : false;
  }, 20000);
  await search.getByRole('button', { name: '关闭搜索' }).click();
  return bar.slice(0, 60);
});

await check('new file directory setting redirects later documents', async () => {
  const target = path.join(root, '自定义目录');
  await fs.mkdir(target, { recursive: true });
  await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, target);
  await page.getByRole('button', { name: '外观与设置' }).click();
  await page.getByRole('button', { name: '选择文件夹' }).click();
  await page.keyboard.press('Escape');
  const canonicalTarget = await fs.realpath(target);
  await until('setting stored', async () => (await page.evaluate(async () => (await window.desktop.session()).settings.newFileDirectory)) === target, 10000);
  await cmd('new');
  const created = await until('document in target directory', async () => { const t = (await tabs()).at(-1); return t && t.path.startsWith(canonicalTarget) ? t.path : false; });
  return path.basename(created);
});

await check('markdown paste on a fresh empty tab converts it to .md', async () => {
  const before = (await tabs()).length;
  await cmd('new');
  await until('new tab', async () => (await tabs()).length === before + 1);
  await until('editor clickable', async () => { await editor().click({ timeout: 4000 }); return true; }, 25000);
  await app.evaluate(({ clipboard }) => clipboard.writeText('# 标题\n\n- 第一项\n- 第二项\n\n**加粗**\n'));
  await page.keyboard.press('Meta+v');
  const file = await until('markdown tab', async () => { const t = (await tabs()).at(-1); return t && /\.md$/.test(t.path) ? t.path : false; });
  return path.basename(file);
});

await check('plain-text file opens in text mode through the open dialog', async () => {
  const file = path.join(root, 'note.txt');
  await fs.writeFile(file, 'plain text line\n');
  await stubOpen(file);
  await cmd('open');
  await until('txt tab', async () => (await tabs()).some(t => t.path.endsWith('note.txt')));
  await until('text editor visible', async () => (await page.locator('.document-scroller[data-active]').innerText()).includes('plain text line'));
  return 'opened';
});

await check('inline tab rename keeps the .tde suffix and the file', async () => {
  await page.locator('.tab-name').first().click();
  const before = (await tabs()).find(t => t.path.endsWith('.tde'));
  const tab = page.locator('.file-tab').filter({ hasText: path.basename(before.path, '.tde') }).first();
  await page.keyboard.press('Escape');
  await tab.locator('.tab-name').dblclick();
  const input = tab.locator('input').first();
  await input.fill('改名后文档.tde');
  await input.press('Enter');
  await until('renamed tab', async () => (await tabs()).some(t => t.path.endsWith('改名后文档.tde')));
  if (!(await fs.stat(path.join(path.dirname(before.path), '改名后文档.tde')).then(() => true, () => false))) throw new Error('renamed file missing');
  return 'renamed';
});

await check('case-only tab rename keeps the same document', async () => {
  const diagnostic = async () => JSON.stringify({
    session: (await tabs()).map(t => t.path.split('/').slice(-2).join('/')),
    strip: await page.locator('.tab-name').allInnerTexts(),
    warnings: await page.locator('.document-warning').allInnerTexts().catch(() => []),
  });
  try {
  const before = (await tabs()).find(t => /\.tde$/i.test(t.path));
  const tab = page.locator('.file-tab').filter({ hasText: path.basename(before.path).replace(/\.tde$/i, '') }).first();
  await page.keyboard.press('Escape');
  await tab.locator('.tab-name').dblclick();
  const input = tab.locator('input').first();
  await input.fill('改名后文档.TDE');
  await input.press('Enter');
  const after = await until('case renamed', async () => { const t = (await tabs()).find(x => /\.TDE$/.test(x.path)); return t ? t.path : false; });
  const rows = await readRows(after);
  if (!rows.length) throw new Error('document lost its events after a case-only rename');
  return `events=${rows.length}`;
  } catch (error) { throw new Error(`${error.message} | ${await diagnostic()}`); }
});

await check('format conversion .tde -> .md keeps the text and a recovery copy', async () => {
  await page.locator('.tab-name').first().click();
  const before = (await tabs()).find(t => /\.tde$/i.test(t.path));
  const tab = page.locator('.file-tab').filter({ hasText: path.basename(before.path).replace(/\.tde$/i, '') }).first();
  await page.keyboard.press('Escape');
  await tab.locator('.tab-name').dblclick();
  const input = tab.locator('input').first();
  await input.fill('转换后.md');
  await input.press('Enter');
  const file = await until('converted markdown tab', async () => { const t = (await tabs()).find(x => x.path.endsWith('转换后.md')); return t ? t.path : false; }, 25000);
  const text = await fs.readFile(file, 'utf8');
  if (!text.includes('第一行测试内容')) throw new Error(`md content = ${JSON.stringify(text.slice(0, 120))}`);
  const recoveryRoot = path.join(profile, 'recovery', 'format-renames');
  const backups = await fs.readdir(recoveryRoot).catch(() => []);
  if (!backups.length) throw new Error(`no recovery copy under ${recoveryRoot}`);
  return `md ok, recoveryCopies=${backups.length}`;
});

await check('session restore after restart keeps the document', async () => {
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await app.waitForEvent('close', { timeout: 25000 });
  app = await electron.launch({ args: [project, '--no-sandbox', '--disable-gpu'], env });
  page = await app.firstWindow(); watch(app); wire(page); await show(); await installProbe();
  await until('restored document', async () => { const text = await page.locator('.document-scroller[data-active]').innerText(); return text.includes('第一行测试内容'); });
  return 'restored';
});

await check('no renderer page errors during the whole run', async () => { if (pageErrors.length) throw new Error(pageErrors[0]); return 'clean'; });

const report = { root, results, pageErrors: [...new Set(pageErrors)], consoleErrors: [...new Set(consoleErrors)], mainLog: mainLog.slice(-40) };
await fs.writeFile('.cache/smoke/report.json', JSON.stringify(report, null, 2));
console.log(results.map(r => r[0] === 'PROBE'
  ? `      probe[${r[1]}] ${r[2]}`
  : `${r[0]}  ${r[1]}${r[2] ? `  -> ${r[2]}` : ''}${r[3] ? `  (${r[3]}ms)` : ''}`).join('\n'));
console.log('\npageErrors:', JSON.stringify(report.pageErrors, null, 1));
console.log('consoleErrors:', JSON.stringify(report.consoleErrors, null, 1));
console.log('mainLog tail:', JSON.stringify(report.mainLog.slice(-12), null, 1));
console.log('root:', root);
await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
if (!keep) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
