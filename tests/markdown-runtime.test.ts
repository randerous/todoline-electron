import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { DocumentTab } from '../src/renderer/runtime';
import { newEvent } from '../src/renderer/document';
import type { DesktopAPI } from '../src/shared/types';
let tab: DocumentTab;
beforeAll(() => { Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect); Element.prototype.getClientRects = () => [] as unknown as DOMRectList; });
afterEach(() => { tab?.destroy(); document.body.innerHTML = ''; });
function setup(draft = true) {
  let revision = 0;
  const create = vi.fn().mockResolvedValue({ kind: 'markdown', handle: 'md', name: '未命名.md', path: 'draft/未命名.md', source: '', revision: 0, draft: true });
  window.desktop = { readClipboard: vi.fn().mockResolvedValue({ text: '# 标题\n\n## 小节', html: '', events: '' }), save: vi.fn().mockResolvedValue({ revision: 1, idMap: {} }), close: vi.fn().mockResolvedValue(undefined), markdown: { create, save: vi.fn().mockImplementation(async () => ({ revision: ++revision })), addAsset: vi.fn() } } as unknown as DesktopAPI;
  const error = vi.fn(); tab = new DocumentTab({ handle: 'tde', name: '未命名.tde', path: 'draft/未命名.tde', revision: 0, draft, events: [newEvent()] }, vi.fn(), error);
  const element = document.createElement('div'); document.body.append(element); tab.mount(element);
  return { create, error };
}
it('automatically converts only a pristine draft and persists native Markdown without TDE events', async () => {
  const { create, error } = setup(); await tab.editor!.paste();
  expect(error).not.toHaveBeenCalled(); expect(create).toHaveBeenCalledOnce(); expect(tab.isMarkdown).toBe(true); expect(tab.records()).toEqual([]);
  expect(tab.markdown?.headings()).toHaveLength(2); expect(tab.editor).toBeUndefined(); await tab.flush();
  expect(window.desktop.markdown.save).toHaveBeenCalledWith(expect.objectContaining({ source: expect.stringContaining('# 标题') })); expect(window.desktop.save).not.toHaveBeenCalled();
});
it('undoing the converting paste restores the original empty TDE draft', async () => {
  setup(); await tab.editor!.paste(); tab.markdown!.editor.commands.undo();
  await vi.waitFor(() => expect(tab.isMarkdown).toBe(false)); expect(tab.snapshot.handle).toBe('tde'); expect(tab.editor?.editor.isEmpty).toBe(true);
  expect(window.desktop.close).toHaveBeenCalledWith('md');
});
it('never converts an existing saved empty TDE document', async () => {
  const { create } = setup(false); await tab.editor!.paste(); expect(create).not.toHaveBeenCalled(); expect(tab.isMarkdown).toBe(false); expect(tab.records()[0].content_text).toContain('# 标题');
});
it('does not regain eligibility when previous content is cleared', async () => {
  const { create } = setup(); tab.editor!.editor.commands.insertContent('正文'); tab.editor!.editor.commands.selectAll(); tab.editor!.editor.commands.deleteSelection();
  expect(tab.editor!.editor.isEmpty).toBe(true); await tab.editor!.paste(); expect(create).not.toHaveBeenCalled(); expect(tab.isMarkdown).toBe(false);
});
it('explicit saving confirms the TDE format even while it is empty', async () => {
  const { create } = setup(); await tab.confirmFormat(); await tab.editor!.paste(); expect(create).not.toHaveBeenCalled();
});
it('leaves ordinary clipboard text in the existing TDE plain-text path', async () => {
  const { create } = setup(); vi.mocked(window.desktop.readClipboard).mockResolvedValue({ text: '普通文字', html: '<b>普通文字</b>', events: '' });
  await tab.editor!.paste(); expect(create).not.toHaveBeenCalled(); expect(tab.records()[0].content_text).toBe('普通文字'); expect(tab.records()[0].content_html).not.toMatch(/<(strong|b)>/);
});
it('searches an unvisited Markdown tab without constructing an editor',async()=>{
  tab=new DocumentTab({kind:'markdown',handle:'background',path:'background.md',name:'background.md',draft:false,source:'# Heading\n\nneedle $x^2$',revision:0},vi.fn(),vi.fn());
  const element=document.createElement('div');document.body.append(element);tab.mount(element,false);
  expect(await tab.searchHits('needle')).toHaveLength(1);expect(tab.currentEditor).toBeUndefined();expect(element.childNodes).toHaveLength(0);
});
