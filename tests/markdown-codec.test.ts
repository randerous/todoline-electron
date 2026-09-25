import { expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { markdownNodeHtml, parseMarkdown, serializeMarkdown } from '../src/renderer/markdown-codec';

function nodes(doc: JSONContent, type: string): JSONContent[] {
  return [...(doc.type === type ? [doc] : []), ...(doc.content ?? []).flatMap(child => nodes(child, type))];
}
it('round-trips chat structures, editable math, tables, code and task lists', () => {
  const source = '# 标题\n\n**粗体** 和 *斜体*、~~删除~~，公式 $x^2$。\n\n> 引用\n\n- [x] 完成\n- [ ] 待办\n\n| 列 | 值 |\n| :--- | ---: |\n| a | `b` |\n\n```ts title="example"\nif (a < b) {\n  run()\n}\n```\n\n$$\n\\frac{1}{2}\n$$\n';
  const doc = parseMarkdown(source), text = serializeMarkdown(doc), reopened = parseMarkdown(text);
  expect(reopened).toEqual(doc);
  expect(nodes(doc, 'inlineMath')[0].attrs?.latex).toBe('x^2');
  expect(nodes(doc, 'blockMath')[0].attrs?.latex).toBe('\\frac{1}{2}');
  expect(nodes(doc, 'listItem').map(n => n.attrs?.checked)).toEqual([true, false]);
  expect(nodes(doc, 'codeBlock')[0].attrs).toEqual({ language: 'ts', meta: 'title="example"' });
  expect(nodes(doc, 'table')[0].attrs?.markdownAlign).toEqual(['left', 'right']);
  expect(text).toContain('|'); expect(text).not.toContain('<table>');
});
it('supports backslash TeX delimiters without converting text inside inline or fenced code', () => {
  const doc = parseMarkdown('行内 \\(x+1\\)\n\n\\[y^2\\]\n\n`\\(literal\\)`\n\n```txt\n\\[literal\\]\n```');
  expect(nodes(doc, 'inlineMath').map(n => n.attrs?.latex)).toEqual(['x+1']);
  expect(nodes(doc, 'blockMath').map(n => n.attrs?.latex)).toEqual(['y^2']);
  expect(nodes(doc, 'codeBlock')[0].content?.[0].text).toBe('\\[literal\\]');
  expect(nodes(doc, 'text').find(n => n.marks?.some(m => m.type === 'code'))?.text).toBe('\\(literal\\)');
});
it('preserves front matter, footnotes and unfamiliar HTML as source blocks', () => {
  const source = '---\ntitle: 例子\ncustom: true\n---\n\n内容[^note]\n\n[^note]: 说明\n\n<custom-widget data-value="1">原文</custom-widget>\n';
  const saved = serializeMarkdown(parseMarkdown(source));
  expect(saved).toContain('---\ntitle: 例子\ncustom: true\n---');
  expect(saved).toContain('[^note]'); expect(saved).toContain('[^note]: 说明');
  expect(saved).toContain('<custom-widget data-value="1">原文</custom-widget>');
});
it('keeps links, image references and definitions without placeholder image text', () => {
  const source = '[OpenAI](https://openai.com "网站") ![图](assets/图片.png)\n\n[参考][ref]\n\n[ref]: https://example.com\n';
  const doc = parseMarkdown(source), saved = serializeMarkdown(doc);
  expect(saved).toContain('![图](assets/图片.png)'); expect(saved).toContain('https://openai.com'); expect(saved).toContain('https://example.com');
  expect(saved).not.toContain('[图片]');
});
it('exports merged and multi-paragraph table cells as bounded HTML', () => {
  const doc: JSONContent = { type: 'doc', content: [{ type: 'table', content: [{ type: 'table_row', content: [{ type: 'table_cell', attrs: { colspan: 2, rowspan: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] }] }] };
  const saved = serializeMarkdown(doc);
  expect(saved).toContain('<td colspan="2"><p>a</p><p>b</p></td>');
  expect(parseMarkdown(saved).content?.[0].type).toBe('rawMarkdown');
});
it('groups adjacent marks so mixed bold content remains valid on round-trip', () => {
  const doc: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bold ', marks: [{ type: 'bold' }] }, { type: 'text', text: 'nested', marks: [{ type: 'bold' }, { type: 'italic' }] }] }] };
  expect(serializeMarkdown(doc)).toBe('**bold *nested***\n');
  expect(parseMarkdown(serializeMarkdown(doc))).toEqual(doc);
});
it('does not silently drop unsupported editor nodes during save', () => {
  expect(() => serializeMarkdown({ type: 'doc', content: [{ type: 'unsupportedWidget' }] })).toThrow('原文件未修改');
});
it('HTML generation escapes content and refuses active image and link references', () => {
  expect(markdownNodeHtml({ type: 'text', text: '<script>bad()</script>' })).toBe('&lt;script&gt;bad()&lt;/script&gt;');
  expect(markdownNodeHtml({ type: 'image', attrs: { src: 'javascript:bad()', alt: '图片' } })).toBe('图片');
});
