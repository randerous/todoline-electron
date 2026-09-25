import { expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { activeHeading, markdownHeadings, visibleHeadings } from '../src/renderer/markdown-outline';

const schema = getSchema([StarterKit]);
const paragraph = { type: 'paragraph', content: [{ type: 'text', text: '正文' }] };
const heading = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: text ? [{ type: 'text', text }] : [] });
it('collects actual heading positions and distinguishes duplicate titles', () => {
  const doc = schema.nodeFromJSON({ type: 'doc', content: [paragraph, heading(1, '章节'), paragraph, heading(2, '章节'), heading(2, '章节')] });
  const result = markdownHeadings(doc);
  expect(result.map(h => h.level)).toEqual([1, 2, 2]); expect(new Set(result.map(h => h.id)).size).toBe(3);
  for (const h of result) expect(doc.nodeAt(h.pos)?.type.name).toBe('heading');
  expect(activeHeading(result, 0)).toBeUndefined(); expect(activeHeading(result, result[1].pos + 1)).toBe(result[1].id);
});
it('collapses descendants even with skipped heading levels and retains later peers', () => {
  const doc = schema.nodeFromJSON({ type: 'doc', content: [heading(1, 'A'), heading(3, 'A.1'), heading(6, 'A.1.a'), heading(2, 'A.2'), heading(1, 'B')] });
  const result = markdownHeadings(doc);
  expect(visibleHeadings(result, new Set([result[0].id])).map(h => h.text)).toEqual(['A', 'B']);
  expect(visibleHeadings(result, new Set([result[1].id])).map(h => h.text)).toEqual(['A', 'A.1', 'A.2', 'B']);
});
it('handles empty documents and changes in heading text without mistaking body text for headings', () => {
  expect(markdownHeadings(schema.nodeFromJSON({ type: 'doc', content: [paragraph] }))).toEqual([]);
  expect(markdownHeadings(schema.nodeFromJSON({ type: 'doc', content: [heading(1, '')] }))[0].text).toBe('未命名标题');
});
