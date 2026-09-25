import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { MarkdownEditor } from '../src/renderer/markdown-editor';
import type { DesktopAPI } from '../src/shared/types';

let owner: MarkdownEditor;
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
  Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
});
afterEach(() => { owner?.destroy(); document.body.innerHTML = ''; });
function setup(source = '') {
  window.desktop = { copy: vi.fn().mockResolvedValue(undefined), readClipboard: vi.fn(), openLink: vi.fn() } as unknown as DesktopAPI;
  const element = document.createElement('div'); document.body.append(element);
  const bridge = { change: vi.fn(), selection: vi.fn(), error: vi.fn(), asset: vi.fn().mockResolvedValue('doc.assets/image.png') };
  owner = new MarkdownEditor(element, { kind: 'markdown', handle: 'test', name: 'test.md', path: 'test.md', draft: false, revision: 0, source }, bridge);
  return { editor: owner.editor, bridge };
}
const clipboard = (text: string, html = '') => ({ text, html, events: '' });

it('retains original source until an edit and reports headings without event nodes', () => {
  const source = '# 标题\r\n\r\n正文\r\n'; const { editor } = setup(source);
  expect(owner.source()).toBe(source); expect(owner.headings().map(h => h.text)).toEqual(['标题']);
  expect(editor.schema.nodes.divider).toBeUndefined(); expect(editor.state.doc.attrs.head).toBeUndefined();
  editor.commands.setTextSelection(1); editor.commands.insertContent('新');
  expect(owner.source()).toContain('# 新标题'); editor.commands.undo(); expect(owner.source()).toBe(source);
});
it('pastes mixed rendered content as editable headings, tables, code and one formula, with one-step undo', async () => {
  const { editor } = setup('原文'); editor.commands.selectAll();
  await owner.paste(false, clipboard('标题 表格 公式', '<h2>标题</h2><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><pre><code class="language-js">  run()</code></pre><p><span class="katex"><math><annotation encoding="application/x-tex">x^2</annotation></math><span class="katex-html">xx</span></span></p>'));
  const types: string[] = []; editor.state.doc.descendants(node => { types.push(node.type.name); });
  expect(types).toContain('heading'); expect(types).toContain('table'); expect(types).toContain('codeBlock'); expect(types.filter(t => t === 'inlineMath')).toHaveLength(1);
  expect(owner.source()).toContain('$x^2$'); expect(owner.source()).toContain('```js'); expect(owner.source()).toContain('| A');
  editor.commands.undo(); expect(owner.source()).toBe('原文');
});
it('parses copied Markdown text and allows an explicit plain-text paste', async () => {
  const { editor } = setup();
  await owner.paste(false, clipboard('## 标题\n\n- [x] 完成'));
  expect(editor.state.doc.firstChild?.type.name).toBe('heading'); expect(document.querySelector<HTMLInputElement>('li input')?.checked).toBe(true);
  editor.commands.selectAll(); await owner.paste(true, clipboard('## 原样\n- 列表', '<h2>原样</h2>'));
  expect(editor.state.doc.firstChild?.type.name).toBe('paragraph'); expect(editor.state.doc.textContent).toBe('## 原样- 列表');
});
it('keeps paste literal inside a code block', async () => {
  const { editor } = setup('```txt\nabc\n```'); editor.commands.setTextSelection(2);
  await owner.paste(false, clipboard('# title\n  indent', '<h1>title</h1>'));
  expect(editor.state.doc.firstChild?.type.name).toBe('codeBlock'); expect(editor.state.doc.textContent).toBe('a# title\n  indentbc');
});
it('edits merged HTML tables and preserves their structure in saved Markdown', async () => {
  const { editor } = setup('<table><tr><td colspan="2"><p>A</p><p>B</p></td></tr></table>');
  expect(editor.state.doc.firstChild?.type.name).toBe('table'); editor.commands.setTextSelection(4); editor.commands.insertContent('X');
  expect(owner.source()).toContain('colspan="2"'); expect(owner.source()).toContain('XA'); expect(owner.source()).toContain('<p>B</p>');
});
it('does not replace an edited selection while pasted images are being imported', async () => {
  const { editor, bridge } = setup('abcdef'); let finish!: (src: string) => void;
  bridge.asset.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); editor.commands.setTextSelection({ from: 2, to: 4 });
  const operation = owner.paste(false, clipboard('', '<p><img src="data:image/png;base64,AQI="></p>'));
  await vi.waitFor(() => expect(bridge.asset).toHaveBeenCalled()); editor.commands.insertContent('NEW'); finish('doc.assets/image.png');
  await expect(operation).rejects.toThrow('位置'); expect(editor.state.doc.textContent).toBe('aNEWdef');
});
it('search returns positions and highlights matches without treating the document as an event', () => {
  setup('甲 apple\n\n乙 Apple'); expect(owner.search('apple')).toHaveLength(2); expect(owner.search('apple', { caseSensitive: true })).toHaveLength(1);
  owner.setSearch('apple'); expect(document.querySelectorAll('.md-search-match')).toHaveLength(2);
});
it('copies readable text with formula source and private formatting', async () => {
  const { editor } = setup('## 标题\n\n$x^2$'); editor.commands.selectAll(); await owner.copy();
  expect(window.desktop.copy).toHaveBeenCalledWith(expect.objectContaining({ text:'标题\nx^2', html: expect.stringContaining('data-md-math-inline') }));
});
it('copies local images as portable attachments without exposing local paths in text', async () => {
  const {editor}=setup('![图片](doc.assets/photo.png)');
  window.desktop.markdown={readAsset:vi.fn().mockResolvedValue('data:image/png;base64,AQI=')} as unknown as DesktopAPI['markdown'];
  editor.commands.selectAll();await owner.copy();
  expect(window.desktop.markdown.readAsset).toHaveBeenCalledWith('test','doc.assets/photo.png');
  expect(window.desktop.copy).toHaveBeenCalledWith(expect.objectContaining({text:'[图片]',html:expect.stringContaining('data:image/png;base64,AQI=')}));
});
it('keeps unfamiliar nested HTML intact when editing another part of a file',()=>{
  const {editor}=setup('<table><tr><td><custom-widget data-value="1">original</custom-widget></td></tr></table>\n\n正文');
  expect(editor.state.doc.firstChild?.type.name).toBe('rawMarkdown');
  editor.commands.setTextSelection(editor.state.doc.content.size-1);editor.commands.insertContent('修改');
  expect(owner.source()).toContain('<custom-widget data-value="1">original</custom-widget>');
});
it('renders column alignment and retains it after an HTML table paste and a text edit',async()=>{
  const {editor}=setup('| Left | Right |\n| :--- | ---: |\n| a | b |');
  expect(document.querySelectorAll('th')[1].style.textAlign).toBe('right');editor.commands.selectAll();
  await owner.paste(false,clipboard('table','<table><tr><th style="text-align:center">A</th></tr><tr><td align="center">B</td></tr></table>'));
  expect(document.querySelector('th')?.style.textAlign).toBe('center');expect(owner.source()).toMatch(/:--+:|:-+:/);
});
it('preserves tasks and raw source through internal HTML copy and paste',async()=>{
  const {editor}=setup('- [x] 完成\n\n<custom-widget>raw</custom-widget>');editor.commands.selectAll();await owner.copy();
  const copied=vi.mocked(window.desktop.copy).mock.calls[0][0];await owner.paste(false,clipboard(copied.text,copied.html??''));
  expect(owner.source()).toContain('- [x] 完成');expect(owner.source()).toContain('<custom-widget>raw</custom-widget>');
});
it('renders Markdown syntax when clipboard HTML is only a plain wrapper',async()=>{
  const {editor}=setup();await owner.paste(false,clipboard('**分支模型**\n\n- `Next`：**开发分支**','<p>**分支模型**</p><p>- `Next`：**开发分支**</p>'));
  expect(editor.state.doc.textContent).toBe('分支模型Next：开发分支');expect(document.querySelector('li code')?.textContent).toBe('Next');
});
