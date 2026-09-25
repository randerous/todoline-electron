import { expect, it } from 'vitest';
import { markdownUrl, normalizeMarkdownClipboardHtml } from '../src/renderer/markdown-clipboard';
const parse = (html: string) => new DOMParser().parseFromString(normalizeMarkdownClipboardHtml(html).html, 'text/html');

it('extracts editable LaTeX once from duplicate visual and accessibility layers', () => {
  const doc = parse('<p>结果 <span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">xx</span></span></p>');
  expect(doc.querySelectorAll('[data-md-math-inline]')).toHaveLength(1);
  expect(doc.querySelector('[data-md-math-inline]')?.getAttribute('data-md-math-inline')).toBe('x^2');
  expect(doc.body.textContent).toBe('结果 x^2');
});
it('keeps block formulas as blocks and supports data-latex sources', () => {
  const doc = parse('<div class="katex-display"><span class="katex"><math><annotation encoding="application/x-tex">\\frac{1}{2}</annotation></math></span></div><span data-latex="a+b">rendered</span>');
  expect(doc.querySelector('[data-md-math-block]')?.textContent).toBe('\\frac{1}{2}');
  expect(doc.querySelector('[data-md-math-inline]')?.textContent).toBe('a+b');
});
it('retains available formula text with a warning when LaTeX is absent', () => {
  const result = normalizeMarkdownClipboardHtml('<span class="katex"><math><mi>x</mi></math><span class="katex-html">duplicate x</span></span>');
  expect(result.html).toBe('x'); expect(result.warnings).toHaveLength(1);
});
it('preserves code language, indentation and literal angle brackets without copy controls', () => {
  const doc = parse('<pre><header>JavaScript<button>复制代码</button></header><code class="language-js"><span>if (x &lt; 1) {</span>\n  go()\n}</code></pre>');
  expect(doc.querySelector('code')?.className).toBe('language-js');
  expect(doc.querySelector('code')?.textContent).toBe('if (x < 1) {\n  go()\n}');
  expect(doc.body.textContent).not.toContain('复制'); expect(doc.body.textContent).not.toContain('JavaScript');
});
it('preserves table spans, lists and tasks while discarding website layout and unsafe attributes', () => {
  const doc = parse('<section style="font-size:8px"><h2 onclick="bad()">标题</h2><table><tr><th colspan="2">表头</th></tr><tr><td rowspan="2">a</td><td>b</td></tr></table><ol start="3"><li><input type="checkbox" checked>完成</li></ol></section>');
  expect(doc.querySelector('h2')?.attributes.length).toBe(0);
  expect(doc.querySelector('th')?.getAttribute('colspan')).toBe('2'); expect(doc.querySelector('td')?.getAttribute('rowspan')).toBe('2');
  expect(doc.querySelector('ol')?.getAttribute('start')).toBe('3'); expect(doc.querySelector('li')?.getAttribute('data-checked')).toBe('true');
});
it('drops active elements and protocol payloads instead of executing or persisting them', () => {
  const doc = parse('<script>alert(1)</script><iframe src="evil"></iframe><p onmouseover="bad()"><a href="javascript:alert(1)">正文</a><img src="file:///private.png" alt="图片"><img src="data:image/svg+xml;base64,YQ=="></p>');
  expect(doc.querySelector('script,iframe,img,[onmouseover]')).toBeNull(); expect(doc.querySelector('a')?.hasAttribute('href')).toBe(false);
  expect(doc.body.textContent).toBe('正文图片');
});
it('accepts portable references without accepting active URLs', () => {
  for (const url of ['assets/image.png', '../image.png', '#章节', 'https://example.com']) expect(markdownUrl(url)).toBe(url);
  for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil/image', 'file:///C:/private', 'java\nscript:x']) expect(markdownUrl(url)).toBeNull();
});
