// @vitest-environment jsdom
import type { JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { escapeHtml, markdown, parseQtHtml, plainText, serializeQtHtml } from '../src/renderer/codec';

it('batch imports share a blank document without leaking styles, content or unsupported flags',()=>{
  const parsingDocument=new DOMParser().parseFromString('', 'text/html');
  const samples=[
    '<html><head><style>p, li { white-space: pre-wrap; }</style></head><body style="color:red;font-size:9pt"><p> a  b </p></body></html>',
    '<p> a  b &amp; c </p>',
    '<table style="float:left"><tr><td>保留原文</td></tr></table>',
    '<p><b>正常</b><img src="asset:1" /></p>',
    '<p></p>',
  ];
  for(const html of samples)expect(parseQtHtml(html,parsingDocument)).toEqual(parseQtHtml(html));
  expect(parsingDocument.body.childNodes).toHaveLength(0);
});

const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const text = (text: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text, ...(marks ? { marks } : {}) });
function descendants(content: JSONContent[]): JSONContent[] {
  return content.flatMap(node => [node, ...descendants(node.content || [])]);
}
function mark(node: JSONContent, type: string) { return node.marks?.find(mark => mark.type === type); }

// Source-format fixture, including the Qt document header, inherited body font,
// fragment comments, list metadata, pre-wrap CSS, and the empty-paragraph sentinel.
const qtDocument = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0//EN" "http://www.w3.org/TR/REC-html40/strict.dtd">
<html><head><meta name="qrichtext" content="1" /><meta charset="utf-8" />
<style type="text/css">
p, li { white-space: pre-wrap; }
hr { height: 1px; border-width: 0; }
li.unchecked::marker { content: "\\2610"; }
li.checked::marker { content: "\\2612"; }
</style></head>
<body style="font-family:Arial; font-size:11pt; font-weight:400; font-style:normal; color:#222222;">
<!--StartFragment--><p style="margin-top:0px; margin-bottom:0px; -qt-block-indent:0; text-indent:0px;">  第一行  <span style="font-weight:700; font-style:italic; text-decoration:underline line-through; color:#ff0000; font-size:18pt; font-family:'Microsoft YaHei'; background-color:#ffff00;">重点</span><br />第二行</p>
<p style="-qt-paragraph-type:empty; margin-top:0px; -qt-block-indent:0;"><br /></p>
<h2 style="white-space:pre-wrap;">标题</h2>
<p><a href="https://example.com/a?x=1&amp;y=2" title="说明 &quot;链接&quot;">链接</a> 图<img src="asset:42" width="120" height="80" /></p><!--EndFragment-->
</body></html>`;

const qtLists = `<html><head><style>p, li { white-space: pre-wrap; }</style></head><body>
<ol start="3" style="margin-top:0px; margin-bottom:0px; -qt-list-indent:1;">
<li style="margin-top:0px; -qt-block-indent:0;">第一项</li>
<ul style="-qt-list-indent:2;"><li>子项</li></ul>
<li><p style="margin-top:0px;">第二项</p></li>
<li><p style="-qt-paragraph-type:empty;"><br /></p></li>
</ol><p>结束</p></body></html>`;

describe('Qt HTML import', () => {
  it('recognizes source-format markup and inherited formatting', () => {
    const result = parseQtHtml(qtDocument);
    expect(result.readOnly).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.content.map(node => node.type)).toEqual(['paragraph', 'paragraph', 'heading', 'paragraph']);
    expect(result.content[1]).toEqual(p());
    expect(result.content[2].attrs).toEqual({ level: 2 });
    const nodes = descendants(result.content);
    const first = nodes.find(node => node.text === '  第一行  ')!;
    expect(mark(first, 'textStyle')?.attrs).toEqual({ color: 'rgb(34, 34, 34)', fontSize: '11pt', fontFamily: 'Arial' });
    const emphasized = nodes.find(node => node.text === '重点')!;
    expect(emphasized.marks?.map(mark => mark.type)).toEqual(['bold', 'italic', 'strike', 'underline', 'textStyle', 'highlight']);
    expect(mark(emphasized, 'textStyle')?.attrs).toMatchObject({ color: 'rgb(255, 0, 0)', fontSize: '18pt' });
    expect(mark(emphasized, 'textStyle')?.attrs?.fontFamily).toContain('Microsoft YaHei');
    expect(mark(emphasized, 'highlight')?.attrs).toEqual({ color: 'rgb(255, 255, 0)' });
    expect(nodes.find(node => node.type === 'image')?.attrs).toEqual({ assetId: 42, width: 120, height: 80 });
    expect(mark(nodes.find(node => node.text === '链接')!, 'link')?.attrs).toEqual({ href: 'https://example.com/a?x=1&y=2', title: '说明 "链接"' });
    expect(plainText(result.content)).toBe('  第一行  重点\n第二行\n\n标题\n链接 图[图片]');
  });

  it('round-trips the full Qt source into the same supported content', () => {
    const imported = parseQtHtml(qtDocument);
    const serialized = serializeQtHtml(imported.content);
    const reparsed = parseQtHtml(serialized);
    expect(reparsed).toEqual(imported);
    expect(serialized).toContain('name="qrichtext"');
    expect(serialized).toContain('src="asset:42"');
    expect(serialized).not.toContain('StartFragment');
  });

  it('handles both Qt sibling nesting and standard nested lists without losing start numbers', () => {
    const result = parseQtHtml(qtLists);
    expect(result.readOnly).toBe(false);
    const list = result.content[0];
    expect(list).toMatchObject({ type: 'orderedList', attrs: { start: 3 } });
    expect(list.content).toHaveLength(3);
    expect(list.content![0].content?.map(node => node.type)).toEqual(['paragraph', 'bulletList']);
    expect(list.content![2].content).toEqual([p()]);
    expect(plainText(result.content)).toBe('3. 第一项\n   - 子项\n4. 第二项\n5. \n结束');
    expect(markdown(result.content)).toBe('3. 第一项\n   - 子项\n4. 第二项\n5. \n\n结束');
    expect(parseQtHtml(serializeQtHtml(result.content))).toEqual(result);
    const standard = parseQtHtml('<ul><li>外层<ol start="10"><li>内层</li></ol></li></ul>');
    expect(plainText(standard.content)).toBe('- 外层\n  10. 内层');
  });

  it('keeps consecutive empty paragraphs and actual hard breaks distinct', () => {
    const result = parseQtHtml('<p></p><p style="-qt-paragraph-type:empty;"><br /></p><p>一<br /><br />二</p><p></p>');
    expect(result.content).toEqual([p(), p(), p(text('一'), { type: 'hardBreak' }, { type: 'hardBreak' }, text('二')), p()]);
    expect(plainText(result.content)).toBe('\n\n一\n\n二\n');
    expect(parseQtHtml(serializeQtHtml(result.content))).toEqual(result);
    expect(parseQtHtml('')).toEqual({ content: [p()], readOnly: false });
    expect(parseQtHtml(' \n<!--empty-->\t')).toEqual({ content: [p()], readOnly: false });
  });

  it('recognizes the Qt empty-paragraph sentinel directly on a list item', () => {
    const result = parseQtHtml('<ol><li style="-qt-paragraph-type:empty;"><br /></li><li>next</li></ol>');
    expect(result.readOnly).toBe(false);
    expect(result.content[0].content![0].content).toEqual([p()]);
    expect(plainText(result.content)).toBe('1. \n2. next');
    expect(parseQtHtml(serializeQtHtml(result.content))).toEqual(result);
  });
  it('keeps Qt paragraphs between li elements as unnumbered item continuations',()=>{
    const parsed=parseQtHtml('<ol start="6"><li>one</li><p style="margin-left:40px;-qt-block-indent:1">quote</p><p style="-qt-paragraph-type:empty"><br /></p><li>two</li></ol>');
    expect(parsed.readOnly).toBe(false);expect(parsed.content[0].content).toHaveLength(2);expect(parsed.content[0].content![0].content).toHaveLength(3);expect(parsed.content[0].content![0].content![1].attrs?.format).toMatchObject({marginLeft:'40px',qtIndent:1});expect(plainText(parsed.content)).toBe('6. one\n   quote\n   \n7. two');expect(parseQtHtml(serializeQtHtml(parsed.content))).toEqual(parsed);
  });

  it('collapses ordinary HTML whitespace but respects pre-wrap and nonbreaking spaces', () => {
    expect(plainText(parseQtHtml('<p> a   <b> b </b> c \n d </p>').content)).toBe('a b c d');
    expect(plainText(parseQtHtml('<p style="white-space:pre-wrap"> a   b\n c </p>').content)).toBe(' a   b\n c ');
    expect(plainText(parseQtHtml('<p>&nbsp;&amp;&lt;&gt;&quot;&#39;</p>').content)).toBe('\u00a0&<>"\'');
    expect(parseQtHtml('<div>one<div>two</div>three</div>').content).toEqual([p(text('one')), p(text('two')), p(text('three'))]);
  });

  it('supports semantic tags, CSS font shorthand, resets, and background shorthand', () => {
    const result = parseQtHtml('<p><b>bold <span style="font-weight:normal">normal</span></b><i>I</i><del>S</del><u>U</u><mark>M</mark><span style="font:italic 16px Arial; background:#00ff00">styled</span></p>');
    const nodes = descendants(result.content);
    expect(mark(nodes.find(node => node.text === 'normal')!, 'bold')).toBeUndefined();
    expect(mark(nodes.find(node => node.text === 'I')!, 'italic')).toBeDefined();
    expect(mark(nodes.find(node => node.text === 'S')!, 'strike')).toBeDefined();
    expect(mark(nodes.find(node => node.text === 'U')!, 'underline')).toBeDefined();
    expect(mark(nodes.find(node => node.text === 'M')!, 'highlight')).toBeDefined();
    expect(mark(nodes.find(node => node.text === 'styled')!, 'textStyle')?.attrs).toMatchObject({ fontSize: '16px', fontFamily: 'Arial' });
    expect(mark(nodes.find(node => node.text === 'styled')!, 'highlight')?.attrs).toEqual({ color: 'rgb(0, 255, 0)' });
  });

  it.each(['section', 'video', 'iframe', 'object', 'svg', 'math', 'form', 'custom-block'])('marks unsupported <%s> content read-only', tag => {
    const html = `<${tag}>保留</${tag}>`;
    const result = parseQtHtml(`<p>before</p>${html}<p>after</p>`);
    expect(result.readOnly).toBe(true);
    expect(result.reason).toContain(tag);
    expect(plainText(result.content)).toContain('保留');
    expect(plainText(result.content)).toContain('before');
    expect(plainText(result.content)).toContain('after');
  });

  it.each(['<ol reversed><li>x</li></ol>', '<ol type="w"><li>x</li></ol>', '<ul type="a"><li>x</li></ul>', '<ol><li value="7">x</li></ol>', '<ul><li class="checked">x</li></ul>'])('does not silently discard unsupported list semantics: %s', html => {
    expect(parseQtHtml(html).readOnly).toBe(true);
  });
});

describe('sanitization and asset policy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('removes executable content, handlers, and unsafe style properties', () => {
    const result = parseQtHtml(`<p onclick="alert(1)">safe<script>alert(2)</script><span style="color:red; background-image:url(https://tracker.invalid/a); position:fixed" onmouseover="alert(3)">text</span></p>`);
    const output = serializeQtHtml(result.content);
    expect(plainText(result.content)).toBe('safetext');
    expect(output).not.toMatch(/alert|onclick|onmouseover|tracker|background-image|position/);
    expect(output).toContain('color:');
  });

  it.each(['javascript:alert(1)', 'java&#x09;script:alert(1)', '&#106;avascript:alert(1)', 'vbscript:msgbox(1)',
    'data:text/html,test', 'file:///C:/private.txt', 'C:\\private.txt', '//example.com', '/local/path', 'asset:1',
    'https://user:password@example.com'])('strips unsafe link %s while preserving its label', href => {
    const result = parseQtHtml(`<p><a href="${href}">label</a></p>`);
    expect(plainText(result.content)).toBe('label');
    expect(descendants(result.content).some(node => mark(node, 'link'))).toBe(false);
    expect(serializeQtHtml(result.content)).not.toContain('<a ');
    expect(markdown(result.content)).toBe('label');
  });

  it.each(['https://example.com/path?x=1&y=2', 'http://localhost:8080/a', 'mailto:test@example.com'])('preserves permitted link %s', href => {
    const result = parseQtHtml(`<p><a href="${escapeHtml(href)}">label</a></p>`);
    expect(mark(result.content[0].content![0], 'link')?.attrs?.href).toBe(href);
    expect(parseQtHtml(serializeQtHtml(result.content))).toEqual(result);
  });

  it.each(['https://example.invalid/pixel.png', '//example.invalid/pixel.png', 'file:///C:/secret.png',
    'C:\\secret.png', '../secret.png', 'data:image/png;base64,AAAA', 'blob:abc', 'asset:0', 'asset:-1',
    'asset:9007199254740992', 'asset:1/other'])('never retains non-asset image source %s', src => {
    const result = parseQtHtml(`<p>图<img src="${src}" srcset="https://tracker.invalid/2x 2x" onerror="alert(1)" /></p>`);
    expect(result.readOnly).toBe(true);
    expect(plainText(result.content)).toBe('图[图片]');
    expect(descendants(result.content).some(node => node.type === 'image')).toBe(false);
    expect(serializeQtHtml(result.content)).not.toMatch(/<img|srcset|onerror|tracker/);
  });

  it('parses resource-bearing HTML only in template contents, without connecting it to a document', () => {
    const parser = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const created: HTMLTemplateElement[] = [];
    const createElement = Document.prototype.createElement;
    vi.spyOn(Document.prototype, 'createElement').mockImplementation(function (this: Document, ...args: Parameters<Document['createElement']>) {
      const element = createElement.apply(this, args);
      if (String(args[0]) === 'template') created.push(element as unknown as HTMLTemplateElement);
      return element;
    });
    const result = parseQtHtml('</template><body background="https://tracker.invalid/bg"><img src="https://tracker.invalid/pixel"><iframe src="file:///C:/secret"></iframe></body>');
    expect(result.readOnly).toBe(true);
    expect(parser).toHaveBeenCalledWith('', 'text/html');
    expect(parser).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0].isConnected).toBe(false);
    expect(created[0].content.querySelector('img')?.isConnected).toBe(false);
    expect(document.querySelector('img[src*="tracker.invalid"]')).toBeNull();
  });

  it('sanitizes untrusted editor JSON again on HTML and Markdown export', () => {
    const content = [p(text('<script> & "quote"', [
      { type: 'link', attrs: { href: 'javascript:alert(1)', onclick: 'alert(2)' } },
      { type: 'textStyle', attrs: { color: 'red; background-image:url(https://evil.invalid)', fontFamily: 'Arial', fontSize: '12px;position:fixed' } },
      { type: 'highlight', attrs: { color: 'url(https://evil.invalid)' } },
    ]), { type: 'image', attrs: { src: 'file:///C:/private.png', onerror: 'alert(1)' } })];
    const output = serializeQtHtml(content);
    expect(output).toContain('&lt;script&gt; &amp; &quot;quote&quot;');
    expect(output).toContain('font-family:Arial');
    expect(output).not.toMatch(/<script|javascript|onerror|onclick|file:|evil|position/);
    expect(markdown(content)).toBe('\\<script\\> &amp; "quote"`[图片]`');
    expect(plainText(content)).toBe('<script> & "quote"[图片]');
  });

  it('uses numeric assetId or an asset:ID fallback and validates dimensions', () => {
    const content = [p(
      { type: 'image', attrs: { assetId: 12, src: 'https://ignored.invalid', width: 64, height: '32px' } },
      { type: 'image', attrs: { src: 'asset:13', width: '1" onerror="alert(1)', height: -2 } },
    )];
    const output = serializeQtHtml(content);
    expect(output).toContain('<img src="asset:12" width="64" height="32" />');
    expect(output).toContain('<img src="asset:13" />');
    expect(output).not.toMatch(/ignored|onerror|alert/);
    expect(descendants(parseQtHtml(output).content).filter(node => node.type === 'image').map(node => node.attrs)).toEqual([
      { assetId: 12, width: 64, height: 32 }, { assetId: 13 },
    ]);
  });

  it('serializes textStyle backgrounds and highlight marks as Qt background colors', () => {
    const content = [p(text('background', [{ type: 'textStyle', attrs: { backgroundColor: '#ff0000' } }]), text('highlight', [{ type: 'highlight', attrs: { color: '#00ff00' } }]))];
    const result = parseQtHtml(serializeQtHtml(content));
    expect(result.readOnly).toBe(false);
    expect(result.content[0].content!.map(node => mark(node, 'highlight')?.attrs?.color)).toEqual(['rgb(255, 0, 0)', 'rgb(0, 255, 0)']);
    const defaultMark = parseQtHtml('<p><mark>default</mark></p>');
    expect(parseQtHtml(serializeQtHtml(defaultMark.content))).toEqual(defaultMark);
  });
});

describe('body exports', () => {
  it('exports headings, links, marks, hard breaks, and image placeholders', () => {
    const content = parseQtHtml('<h2>计划</h2><p><b>重要</b> <i>备注</i> <s>取消</s> <u>下划线</u><br /><a href="https://example.com/a(b)?q=1&amp;x=2">链接</a><img src="asset:7" /></p>').content;
    expect(markdown(content)).toBe('## 计划\n\n**重要** *备注* ~~取消~~ <u>下划线</u>  \n[链接](<https://example.com/a(b)?q=1&x=2>)`[图片]`');
    expect(plainText(content)).toBe('计划\n重要 备注 取消 下划线\n链接[图片]');
  });

  it('groups marks across text runs and escapes literal Markdown/HTML', () => {
    const content = [p(text('one ', [{ type: 'bold' }]), text('two', [{ type: 'bold' }, { type: 'italic' }]), text(' three', [{ type: 'bold' }]))];
    expect(markdown(content)).toBe('**one *two* three**');
    expect(markdown([p(text('1. [x] *literal* <img> &'))])).toBe('1\\. \\[x\\] \\*literal\\* \\<img\\> &amp;');
  });

  it('indents continuation lines and nested lists after multi-digit ordered markers', () => {
    const content = parseQtHtml('<ol start="10"><li><p>first<br />continued</p><p>second paragraph</p><ul><li>child</li></ul></li><li>next</li></ol>').content;
    expect(plainText(content)).toBe('10. first\n    continued\n    second paragraph\n    - child\n11. next');
    expect(markdown(content)).toBe('10. first  \n    continued\n    \n    second paragraph\n    - child\n11. next');
    expect(plainText(parseQtHtml('<ol start="0"><li>zero</li><li>one</li></ol>').content)).toBe('0. zero\n1. one');
  });

  it('retains empty body blocks and never mutates editor content', () => {
    const content = [p(), p(text(' a  b ')), p()];
    const before = JSON.stringify(content);
    expect(plainText(content)).toBe('\n a  b \n');
    expect(markdown(content)).toBe('\n\n a  b \n\n');
    serializeQtHtml(content);
    expect(JSON.stringify(content)).toBe(before);
    expect(plainText([])).toBe('');
    expect(markdown([])).toBe('');
  });

  it('escapes all HTML delimiter characters', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('refuses to silently serialize unknown editor structure', () => {
    expect(() => serializeQtHtml([{ type: 'unknownBlock', content: [] }])).toThrow('Unsupported editor node: unknownBlock');
  });
});
