import { expect, it } from 'vitest';
import { searchMarkdownSource } from '../src/renderer/markdown-search';
it('searches unmounted documents including formulas, code and table text',()=>{
  const source='# 章节\n\n正文 Alpha\n\n| 项 | 值 |\n| --- | --- |\n| 表格 | Alpha |\n\n```js\nAlpha()\n```\n\n$x^2$';
  expect(searchMarkdownSource(source,'alpha')).toHaveLength(3);
  expect(searchMarkdownSource(source,'alpha',{caseSensitive:true})).toEqual([]);
  expect(searchMarkdownSource(source,'x^2')).toHaveLength(1);
});
