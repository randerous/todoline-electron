import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import { parseQtHtml, plainText, serializeQtHtml } from '../src/renderer/codec';
import { TodoEditor } from '../src/renderer/editor';
import { newEvent } from '../src/renderer/document';
import { levelStyle, listMarker } from '../src/renderer/list-style';

// Exactly what Qt 6.8 writes back after reading these lists (captured with qt-compat create-html).
const qtStyled = `<ol style="margin-top: 0px; -qt-list-indent: 1;"><li>一级
<ol style="margin-top: 0px; -qt-list-indent: 2; -qt-list-number-prefix: '('; -qt-list-number-suffix: ')';"><li>二级</li></ol></li></ol>
<ul type="square" style="-qt-list-indent: 1;"><li>方块</li></ul>
<ul type="circle" style="-qt-list-indent: 1;"><li>空心</li></ul>
<ol type="a" style="-qt-list-indent: 1;"><li>字母</li></ol>
<ol type="i" style="-qt-list-indent: 1;"><li>罗马</li></ol>`;

describe('list markers in Qt HTML', () => {
  it('reads Qt letter, roman, square, circle and (1) lists without falling back to read-only', () => {
    const parsed = parseQtHtml(qtStyled);
    expect(parsed.readOnly).toBe(false);
    const [outer, square, circle, alpha, roman] = parsed.content;
    expect(outer.attrs?.listStyle).toBeUndefined();
    expect(outer.content![0].content![1]).toMatchObject({ type: 'orderedList', attrs: { listStyle: 'paren' } });
    expect(square).toMatchObject({ type: 'bulletList', attrs: { listStyle: 'square' } });
    expect(circle).toMatchObject({ type: 'bulletList', attrs: { listStyle: 'circle' } });
    expect(alpha).toMatchObject({ type: 'orderedList', attrs: { listStyle: 'lower-alpha' } });
    expect(roman).toMatchObject({ type: 'orderedList', attrs: { listStyle: 'lower-roman' } });
  });

  it('writes markers the way Qt reads them and survives its own round trip', () => {
    const html = serializeQtHtml(parseQtHtml(qtStyled).content);
    expect(html).toContain(`-qt-list-number-prefix: '(';-qt-list-number-suffix: ')';`);
    expect(html).toContain('<ul type="square"');
    expect(html).toContain('<ul type="circle"');
    expect(html).toContain('<ol start="1" type="a"');
    expect(html).toContain('<ol start="1" type="i"');
    expect(parseQtHtml(html).content).toEqual(parseQtHtml(qtStyled).content);
  });

  it('keeps circled numbers on a property Qt ignores and leaves default lists untouched', () => {
    const circled = { type: 'orderedList', attrs: { start: 1, listStyle: 'circled' }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '圈' }] }] }] };
    const html = serializeQtHtml([circled]);
    expect(html).toContain('-todoline-list-style: circled;');
    expect(html).toContain('<ol start="1" style=');
    expect(parseQtHtml(html).content[0].attrs?.listStyle).toBe('circled');
    const plain = serializeQtHtml(parseQtHtml('<ol><li>一</li></ol><ul><li>二</li></ul>').content);
    expect(plain.replace('<style type="text/css">','')).not.toMatch(/type=|list-number|todoline-list/);
  });

  it('marks styled lists for the PDF page, which has no Qt properties to read', () => {
    const shown = serializeQtHtml(parseQtHtml(qtStyled).content, true);
    for (const style of ['paren', 'square', 'circle', 'lower-alpha', 'lower-roman']) expect(shown).toContain(`data-list-style="${style}"`);
    expect(serializeQtHtml(parseQtHtml(qtStyled).content)).not.toContain('data-list-style');
  });

  it('exports the marker a reader sees to plain text but keeps Markdown syntax', () => {
    const parsed = parseQtHtml(qtStyled).content;
    const text = plainText(parsed);
    expect(text).toContain('(1) 二级');
    expect(text).toContain('■ 方块');
    expect(text).toContain('○ 空心');
    expect(text).toContain('a. 字母');
    expect(text).toContain('i. 罗马');
    expect(listMarker('circled', 3)).toBe('③ ');
    expect(listMarker('circled', 21)).toBe('21. ');
    expect(plainText(parseQtHtml('<ol start="3"><li>x</li></ol><ul><li>y</li></ul>').content)).toBe('3. x\n- y');
  });

  it('opens levels as 1. then (1) then ① then ■ then ●', () => {
    expect([1, 2, 3, 4, 5, 6].map(levelStyle)).toEqual(['decimal', 'paren', 'circled', 'square', 'disc', 'disc']);
  });
});

let ed: TodoEditor;
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
  Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
});
afterEach(() => { ed?.destroy(); document.body.innerHTML = ''; });
function setup(html: string) {
  const el = document.createElement('div'); document.body.append(el);
  ed = new TodoEditor(el, { handle: 'test', name: 'test.tde', path: 'test.tde', revision: 0, events: [{ ...newEvent(), id: 1, pos: 0, content_html: html }] }, { change: vi.fn(), selection: vi.fn(), error: vi.fn(), asset: vi.fn() });
  return ed.editor;
}
const key = (name: string, extra: KeyboardEventInit = {}) => ed.editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra }));
/** Caret at the start of the item whose text is `text`. */
function caretAt(text: string) {
  const { doc } = ed.editor.state; let at = -1;
  doc.descendants((node, pos) => { if (at < 0 && node.type.name === 'paragraph' && node.textContent === text) at = pos + 1; });
  ed.editor.view.dispatch(ed.editor.state.tr.setSelection(TextSelection.create(doc, at)));
}
/** Marker of every list from the outside in along the caret's path. */
const path = () => { const $from = ed.editor.state.selection.$from, found: string[] = []; for (let d = 1; d <= $from.depth; d++) { const n = $from.node(d); if (n.type.name === 'orderedList' || n.type.name === 'bulletList') found.push(n.type.name + ':' + (n.attrs.listStyle ?? 'default')); } return found; };

describe('Tab nests list items', () => {
  it('opens (1), ①, ■ and ● levels, stops at five and undoes one level at a time', () => {
    const e = setup('<ol><li>一</li><li>二</li><li>三</li><li>四</li><li>五</li><li>六</li></ol>');
    for (const [text, times] of [['二', 1], ['三', 2], ['四', 3], ['五', 4], ['六', 5]] as const) {
      caretAt(text);
      for (let i = 0; i < times; i++) key('Tab');
    }
    caretAt('六');
    expect(path()).toEqual(['orderedList:default', 'orderedList:paren', 'orderedList:circled', 'bulletList:square', 'bulletList:default']);
    expect(ed.listStyle()).toBe('disc');
    key('Tab');
    expect(path()).toHaveLength(5);
    expect(e.state.doc.textContent).toBe('一二三四五六');
    caretAt('六');
    key('Tab', { shiftKey: true });
    expect(path()).toHaveLength(4);
    e.commands.undo();
    caretAt('六');
    expect(path()).toHaveLength(5);
  });

  it('joins an open sub-list of another kind instead of opening a second list beside it', () => {
    setup('<ol><li>一<ul type="square"><li>方</li></ul></li><li>二</li></ol>');
    caretAt('二'); key('Tab');
    caretAt('二');
    expect(path()).toEqual(['orderedList:default', 'bulletList:square']);
    expect(ed.editor.state.doc.firstChild?.firstChild?.childCount).toBe(2);
  });

  it('keeps the marker of a sub-list it joins, and Tab elsewhere still inserts spaces', () => {
    const e = setup('<ol><li>一<ol type="a"><li>甲</li></ol></li><li>二</li></ol><p>正文</p>');
    caretAt('二'); key('Tab');
    caretAt('二');
    expect(path()).toEqual(['orderedList:default', 'orderedList:lower-alpha']);
    caretAt('正文'); key('Tab');
    expect(e.state.doc.lastChild?.textContent).toBe('    正文');
  });

  it('styles only the items on the caret line or under the selection, keeping their numbering', () => {
    const e = setup('<ol><li>一</li><li>二</li><li>三</li><li>四</li></ol>');
    const lists = () => { const found: string[] = []; e.state.doc.descendants(node => { if (node.type.name === 'orderedList' || node.type.name === 'bulletList') found.push(`${node.type.name}:${node.attrs.listStyle ?? 'default'}:${node.attrs.start ?? '-'}:${node.childCount}`); return true; }); return found; };
    caretAt('二');
    expect(ed.setListStyle('paren')).toBe(true);
    expect(lists()).toEqual(['orderedList:default:1:1', 'orderedList:paren:2:1', 'orderedList:default:3:2']);
    expect(plainText(parseQtHtml(ed.records()[0].content_html).content)).toBe('1. 一\n(2) 二\n3. 三\n4. 四');
    // Choosing the original marker again joins the pieces back into one list.
    caretAt('二');
    ed.setListStyle('decimal');
    expect(lists()).toEqual(['orderedList:default:1:4']);
    // A selection from 二 into 三 styles exactly those two lines.
    const { doc } = e.state; let from = -1, to = -1;
    doc.descendants((node, pos) => { if (node.type.name !== 'paragraph') return true; if (node.textContent === '二') from = pos + 1; if (node.textContent === '三') to = pos + 2; return false; });
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(doc, from, to)));
    ed.setListStyle('square');
    expect(lists()).toEqual(['orderedList:default:1:1', 'bulletList:square:-:2', 'orderedList:default:4:1']);
    e.commands.undo();
    expect(lists()).toEqual(['orderedList:default:1:4']);
  });

  it('changes only the nested list of the line, never the list around it', () => {
    const e = setup('<ol><li>一<ol><li>甲</li><li>乙</li></ol></li><li>二</li></ol>');
    const lists = () => { const found: string[] = []; e.state.doc.descendants(node => { if (node.type.name === 'orderedList' || node.type.name === 'bulletList') found.push(`${node.attrs.listStyle ?? 'default'}:${node.attrs.start}:${node.childCount}`); return true; }); return found; };
    caretAt('乙');
    ed.setListStyle('circled');
    expect(lists()).toEqual(['default:1:2', 'default:1:1', 'circled:2:1']);
  });

  it('applies a chosen marker to the list at the caret and turns plain text into a list', () => {
    const e = setup('<ol><li>一</li></ol><p>正文</p>');
    caretAt('一');
    expect(ed.setListStyle('square')).toBe(true);
    expect(e.state.doc.firstChild).toMatchObject({ type: { name: 'bulletList' } });
    expect(ed.listStyle()).toBe('square');
    caretAt('正文');
    expect(ed.setListStyle('circled')).toBe(true);
    expect(ed.listStyle()).toBe('circled');
    expect(ed.records()[0].content_html).toContain('-todoline-list-style: circled;');
  });
});
describe('several lines: Tab indents them together and they can become a nested list', () => {
  const pre = (text: string) => `<p style="white-space:pre-wrap">${text}</p>`;
  /** Select from the start of the first line containing `first` to the end of the last line containing `last`. */
  function selectLines(first: string, last: string) {
    const { doc } = ed.editor.state; let from = -1, to = -1;
    doc.descendants((node, pos) => { if (!node.isTextblock) return true; if (from < 0 && node.textContent.includes(first)) from = pos + 1; if (node.textContent.includes(last)) to = pos + 1 + node.content.size; return false; });
    ed.editor.view.dispatch(ed.editor.state.tr.setSelection(TextSelection.create(doc, from, to)));
  }
  const lines = () => { const found: string[] = []; ed.editor.state.doc.descendants(node => { if (node.type.name === 'paragraph') { found.push(node.textContent); return false; } return true; }); return found; };
  const lists = () => { const found: string[] = []; ed.editor.state.doc.descendants(node => { if (node.type.name === 'orderedList' || node.type.name === 'bulletList') found.push(`${node.type.name}:${node.attrs.listStyle ?? 'default'}:${node.childCount}`); return true; }); return found; };

  it('indents every selected line together, and Shift+Tab takes one unit back off each', () => {
    setup('<p>甲</p><p>乙</p><p>丙</p>');
    selectLines('甲', '乙'); key('Tab');
    expect(lines()).toEqual(['    甲', '    乙', '丙']);
    key('Tab');
    expect(lines()).toEqual(['        甲', '        乙', '丙']);
    key('Tab', { shiftKey: true });
    expect(lines()).toEqual(['    甲', '    乙', '丙']);
    ed.editor.commands.setTextSelection(ed.editor.state.doc.content.size - 1); key('Tab', { shiftKey: true });
    expect(lines()).toEqual(['    甲', '    乙', '丙']);
  });

  it('still replaces text selected inside one line, and indents the selected lines of a code block', () => {
    const e = setup('<p>甲乙</p>');
    selectLines('甲乙', '甲乙');
    const { from } = e.state.selection; e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, from + 1, from + 2)));
    key('Tab');
    expect(lines()).toEqual(['甲    ']);
    e.commands.insertContentAt(e.state.doc.content.size, { type: 'codeBlock', content: [{ type: 'text', text: 'one\ntwo\nthree' }] });
    let start = -1; e.state.doc.descendants((node, pos) => { if (node.type.name === 'codeBlock') start = pos + 1; return true; });
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, start, start + 7)));
    key('Tab');
    let code = ''; e.state.doc.descendants(node => { if (node.type.name === 'codeBlock') code = node.textContent; return true; });
    expect(code).toBe('    one\n    two\nthree');
  });

  it('nests several selected list items at once with the next level marker', () => {
    setup('<ol><li>一</li><li>二</li><li>三</li></ol>');
    selectLines('二', '三'); key('Tab');
    expect(lists()).toEqual(['orderedList:default:1', 'orderedList:paren:2']);
    selectLines('二', '三'); key('Tab', { shiftKey: true });
    expect(lists()).toEqual(['orderedList:default:3']);
  });

  it('turns plain lines into a list nested by their indentation, dropping the indentation', () => {
    setup(['需求', '    拆分', '        接口', '    评审', '发布'].map(pre).join(''));
    selectLines('需求', '发布');
    expect(ed.toggleListLines('orderedList')).toBe(true);
    expect(lists()).toEqual(['orderedList:default:2', 'orderedList:paren:2', 'orderedList:circled:1']);
    expect(lines()).toEqual(['需求', '拆分', '接口', '评审', '发布']);
    expect(ed.editor.state.selection.empty).toBe(false);
    expect(ed.records()[0].content_text).toBe('1. 需求\n   (1) 拆分\n       ① 接口\n   (2) 评审\n2. 发布');
  });

  it('uses ● ○ ■ for bullets, counts a tab as a level, and starts unindented or undecidable lines at level one', () => {
    setup(['甲', '\t乙', '\t\t丙'].map(pre).join(''));
    selectLines('甲', '丙'); ed.toggleListLines('bulletList');
    expect(lists()).toEqual(['bulletList:default:1', 'bulletList:circle:1', 'bulletList:square:1']);
    setup(['    甲', '    乙', '  丙'].map(pre).join(''));
    selectLines('甲', '丙'); ed.toggleListLines('orderedList');
    expect(lists()).toEqual(['orderedList:default:3']);
    expect(lines()).toEqual(['甲', '乙', '丙']);
    setup('<p>正文</p>');
    caretAt('正文'); ed.toggleListLines('orderedList');
    expect(lists()).toEqual(['orderedList:default:1']);
  });

  it('unwraps a line that is already that list, and never pulls an event divider into a list', () => {
    const e = setup('<p>甲</p><p>乙</p>');
    caretAt('乙'); ed.split();
    selectLines('甲', '乙'); ed.toggleListLines('orderedList');
    expect((e.state.doc.content as unknown as { content: { type: { name: string } }[] }).content.map(node => node.type.name)).toEqual(['orderedList', 'divider', 'orderedList']);
    caretAt('甲'); ed.toggleListLines('orderedList');
    expect(e.state.doc.firstChild?.type.name).toBe('paragraph');
  });
});
describe('the first item of a list, and continuing numbering', () => {
  const lists = () => { const found: string[] = []; ed.editor.state.doc.descendants(node => { if (node.type.name === 'orderedList' || node.type.name === 'bulletList') found.push(`${node.attrs.listStyle ?? 'default'}:${node.attrs.listIndent ?? 0}:${node.attrs.start ?? '-'}:${node.childCount}`); return true; }); return found; };
  const text = () => ed.records()[0].content_text;
  function selectItems(first: string, last: string) {
    const { doc } = ed.editor.state; let from = -1, to = -1;
    doc.descendants((node, pos) => { if (node.type.name !== 'paragraph') return true; if (from < 0 && node.textContent === first) from = pos + 1; if (node.textContent === last) to = pos + 1 + node.content.size; return false; });
    ed.editor.view.dispatch(ed.editor.state.tr.setSelection(TextSelection.create(doc, from, to)));
  }

  it('Tab on the first item moves it one level deeper on its own and renumbers the items below', () => {
    setup('<ol><li>一</li><li>二</li><li>三</li></ol>');
    caretAt('一'); key('Tab');
    expect(lists()).toEqual(['paren:1:1:1', 'default:0:1:2']);
    expect(text()).toBe('(1) 一\n1. 二\n2. 三');
    caretAt('二'); key('Tab');
    expect(lists()).toEqual(['paren:1:1:2', 'default:0:1:1']);
    expect(text()).toBe('(1) 一\n(2) 二\n1. 三');
    caretAt('二'); key('Tab', { shiftKey: true });
    expect(text()).toBe('(1) 一\n1. 二\n2. 三');
    caretAt('一'); key('Tab', { shiftKey: true });
    expect(lists()).toEqual(['default:0:1:3']);
    // Back exactly as opened, so the record reuses the stored HTML byte for byte.
    expect(ed.records()[0].content_html).toBe('<ol><li>一</li><li>二</li><li>三</li></ol>');
    expect(plainText(parseQtHtml(ed.records()[0].content_html).content)).toBe('1. 一\n2. 二\n3. 三');
  });

  it('a selection that starts at the first item moves all of its items, and the five-level limit still holds', () => {
    setup('<ol><li>一</li><li>二</li><li>三</li></ol>');
    selectItems('一', '二'); key('Tab');
    expect(lists()).toEqual(['paren:1:1:2', 'default:0:1:1']);
    for (let i = 0; i < 5; i++) { caretAt('三'); key('Tab'); }
    // 三 nests under 二 (level 3), then moves two more levels on its own and stops at level five.
    expect(lists().at(-1)).toBe('default:2:-:1');
    expect(ed.records()[0].content_html).toContain('-qt-list-indent: 5;');
  });

  it('reads and writes a list indented on its own exactly as Qt 6.8 does', () => {
    const qt = `<ol style="margin-top: 0px; -qt-list-indent: 2; -qt-list-number-prefix: '('; -qt-list-number-suffix: ')';"><li>一</li></ol><ol style="margin-top: 0px; -qt-list-indent: 1;"><li>二</li><li>三</li></ol>`;
    const parsed = parseQtHtml(qt);
    expect(parsed.readOnly).toBe(false);
    expect(parsed.content[0].attrs).toMatchObject({ listStyle: 'paren', listIndent: 1 });
    expect(parsed.content[1].attrs?.listIndent).toBeUndefined();
    const html = serializeQtHtml(parsed.content);
    expect(html).toContain(`-qt-list-number-suffix: ')';-qt-list-indent: 2;`);
    expect(html.split('-qt-list-indent').length).toBe(2);
    expect(parseQtHtml(html).content).toEqual(parsed.content);
    expect(serializeQtHtml(parsed.content, true)).toContain('data-list-indent="1"');
  });

  it('继续编号 picks up after the previous list on the same level, but not across an event divider', () => {
    setup('<ol><li>一</li><li>二</li></ol><p>说明</p><ol><li>三</li></ol><ol><li>甲<ol><li>子</li></ol></li></ol>');
    caretAt('三');
    expect(ed.canContinueNumbering()).toBe(true);
    expect(ed.continueNumbering()).toBe(true);
    expect(lists()[1]).toBe('default:0:3:1');
    expect(text()).toContain('3. 三');
    caretAt('子');
    expect(ed.canContinueNumbering()).toBe(false);
    caretAt('一');
    expect(ed.canContinueNumbering()).toBe(false);
    caretAt('说明'); ed.split();
    caretAt('三');
    expect(ed.canContinueNumbering()).toBe(false);
  });
});
describe('deleting a line inside a list keeps the numbering running', () => {
  const lists = () => { const found: string[] = []; ed.editor.state.doc.descendants(node => { if (node.type.name === 'orderedList') found.push(`${node.attrs.start}:${node.childCount}`); return true; }); return found; };
  const text = () => plainText(ed.editor.state.doc.toJSON().content);
  const para = (wanted: string) => { let at = -1, size = 0; ed.editor.state.doc.descendants((node, pos) => { if (at < 0 && node.type.name === 'paragraph' && node.textContent === wanted) { at = pos; size = node.nodeSize; } return true; }); return { at, size }; };

  it('clearing a line removes its marker, then indentation, then closes the gap', () => {
    setup('<ol><li>一</li><li>二</li><li>三</li><li>四</li></ol>');
    const two = para('二');
    ed.editor.view.dispatch(ed.editor.state.tr.setSelection(TextSelection.create(ed.editor.state.doc, two.at + 1, two.at + 2)));
    key('Backspace'); key('Backspace');
    expect(lists()).toEqual(['1:1','2:2']);
    expect(ed.editor.state.selection.$from.parent.attrs.format.marginLeft).toBe('27px');
    key('Backspace');
    expect(ed.editor.state.selection.$from.parent.attrs.format?.marginLeft).toBeUndefined();
    key('Backspace');
    expect(lists()).toEqual(['1:3']);
    expect(text()).toBe('1. 一\n2. 三\n3. 四');
  });

  it('Backspace at the start of a line with text folds it into the line above, then merges the text', () => {
    setup('<ol><li>甲</li><li>乙</li><li>丙</li></ol>');
    caretAt('乙'); key('Backspace');
    expect(lists()).toEqual(['1:2']);
    expect(text()).toBe('1. 甲\n   乙\n2. 丙');
    key('Backspace');
    expect(text()).toBe('1. 甲乙\n2. 丙');
    // The first item keeps the ordinary Backspace, which takes it out of the list.
    caretAt('甲乙'); key('Backspace');
    expect(lists()).toEqual(['1:1']);
  });

  it('removing what stood between two lists joins them, but lists already side by side stay apart', () => {
    setup('<ol><li>一</li></ol><p>中间</p><ol><li>二</li></ol>');
    const middle = para('中间');
    ed.editor.view.dispatch(ed.editor.state.tr.delete(middle.at, middle.at + middle.size));
    expect(lists()).toEqual(['1:2']);
    expect(text()).toBe('1. 一\n2. 二');
    setup('<ol><li>一</li></ol><ol><li>二二</li></ol>');
    const second = para('二二');
    ed.editor.view.dispatch(ed.editor.state.tr.delete(second.at + 1, second.at + 2));
    expect(lists()).toEqual(['1:1', '1:1']);
  });
});
