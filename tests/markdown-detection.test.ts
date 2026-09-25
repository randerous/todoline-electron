import { expect, it } from 'vitest';
import { hasMarkdownFeatures } from '../src/renderer/markdown-detection';
import fs from 'node:fs';

it.each(['hello', '#ticket', '# 独立的一行', '- 买牛奶\n- 买面包', 'https://example.com', '1. 第一项\n2. 第二项', '价格 $10 和 $20'])('does not auto-switch ordinary TDE text: %s', text => {
  expect(hasMarkdownFeatures({ text })).toBe(false);
});
it.each(['# 标题\n\n## 小节', '# 标题\n\n- 项目', '```ts\nconst x = 1\n```', '| 名称 | 值 |\n| --- | --- |\n| a | b |', '$$\nx^2+y^2\n$$', '\\[x^2\\]'])('detects unambiguous Markdown structures: %s', text => {
  expect(hasMarkdownFeatures({ text })).toBe(true);
});
it('recognizes semantic HTML from rendered chat replies but not arbitrary styled text', () => {
  expect(hasMarkdownFeatures({ text: '标题', html: '<h2>标题</h2>' })).toBe(true);
  expect(hasMarkdownFeatures({ text: 'x', html: '<span class="katex"><annotation encoding="application/x-tex">x</annotation></span>' })).toBe(true);
  expect(hasMarkdownFeatures({ text: '链接', html: '<a href="https://example.com">链接</a>' })).toBe(false);
  expect(hasMarkdownFeatures({ text: '正文', html: '<b style="font-size:20px">正文</b>' })).toBe(false);
});
it('recognizes the supplied openEuler reply without hash headings',()=>{
  const sample=fs.readFileSync('tests/fixtures/openeuler-next.md','utf8');expect(hasMarkdownFeatures({text:sample})).toBe(true);
  expect(hasMarkdownFeatures({text:'plain rendered text',html:'<p><strong>分支模型</strong></p><ul><li><code>Next</code>：开发分支</li></ul>'})).toBe(true);
});
it.each(['**只有一句加粗**','请查看 `package.json`','- **采购清单**\n- 牛奶','普通 __ 下划线和 ** 星号'])('does not convert a weak isolated signal: %s',text=>{expect(hasMarkdownFeatures({text})).toBe(false);});
