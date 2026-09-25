import type { JSONContent } from '@tiptap/core';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { markdownUrl, isSupportedMarkdownHtml } from './markdown-clipboard';

// Keep the adapter independent of the editor schema; it can be loaded on demand
// and tested without constructing a view or initializing KaTeX.
interface Ast {
  type: string; children?: Ast[]; value?: string; depth?: number; url?: string;
  title?: string | null; alt?: string | null; lang?: string | null; meta?: string | null;
  ordered?: boolean; start?: number | null; spread?: boolean; checked?: boolean | null;
  identifier?: string; label?: string; referenceType?: string;
  align?: (string | null)[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkStringify, { bullet: '-', fences: true, listItemIndent: 'one' });
type Mark = NonNullable<JSONContent['marks']>[number];
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const paragraph = (content: JSONContent[] = []): JSONContent => ({ type: 'paragraph', content });

/** Recognize chat-style TeX delimiters only outside code and HTML syntax. */
function normalizeMathDelimiters(source: string): string {
  const root = processor.parse(source) as Ast, protectedRanges: [number, number][] = [];
  const collect = (node: Ast) => {
    if (['code', 'inlineCode', 'html', 'math', 'inlineMath'].includes(node.type)) {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) protectedRanges.push([start, end]);
    } else node.children?.forEach(collect);
  };
  collect(root); protectedRanges.sort((a, b) => a[0] - b[0]);
  const convert = (part: string) => part.replace(/\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g, (_match, inline: string | undefined, block: string | undefined) => inline !== undefined ? `$${inline}$` : `\n$$\n${block}\n$$\n`);
  let cursor = 0, result = '';
  for (const [start, end] of protectedRanges) { result += convert(source.slice(cursor, start)) + source.slice(start, end); cursor = end; }
  return result + convert(source.slice(cursor));
}

export function parseMarkdown(input: string, parseHtml?: (html: string) => JSONContent[]): JSONContent {
  // Front matter is preserved verbatim rather than misread as a rule and heading.
  const front = /^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1(?:\r?\n|$)/.exec(input)?.[0];
  const source = normalizeMathDelimiters(front ? input.slice(front.length) : input);
  const root = processor.parse(source) as Ast;
  const definitions = new Map<string, Ast>();
  for (const node of root.children ?? []) if (node.type === 'definition' && node.identifier) definitions.set(node.identifier, node);
  const raw = (node: Ast, inline = false): JSONContent => ({ type: inline ? 'rawMarkdownInline' : 'rawMarkdown', attrs: { source: source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0) || node.value || '' } });
  const inlines = (nodes: Ast[], marks: Mark[] = []): JSONContent[] => nodes.flatMap(node => {
    const withMark = (mark: Mark) => inlines(node.children ?? [], [...marks, mark]);
    switch (node.type) {
      case 'text': return node.value ? [{ type: 'text', text: node.value, ...(marks.length ? { marks } : {}) }] : [];
      case 'strong': return withMark({ type: 'bold' });
      case 'emphasis': return withMark({ type: 'italic' });
      case 'delete': return withMark({ type: 'strike' });
      case 'inlineCode': return [{ type: 'text', text: node.value || ' ', marks: [...marks, { type: 'code' }] }];
      case 'inlineMath': return [{ type: 'inlineMath', attrs: { latex: node.value ?? '' }, marks }];
      case 'break': return [{ type: 'hardBreak' }];
      case 'link': return withMark({ type: 'link', attrs: { href: node.url ?? '', title: node.title ?? null } });
      case 'linkReference': {
        const definition = definitions.get(node.identifier ?? '');
        return definition ? withMark({ type: 'link', attrs: { href: definition.url, title: definition.title ?? null } }) : [raw(node, true)];
      }
      case 'image': return [{ type: 'image', attrs: { src: node.url ?? '', alt: node.alt ?? '', title: node.title ?? null } }];
      case 'imageReference': {
        const definition = definitions.get(node.identifier ?? '');
        return definition ? [{ type: 'image', attrs: { src: definition.url ?? '', alt: node.alt ?? '', title: definition.title ?? null } }] : [raw(node, true)];
      }
      default: return [raw(node, true)];
    }
  });
  const blocks = (nodes: Ast[]): JSONContent[] => nodes.flatMap(node => {
    switch (node.type) {
      case 'paragraph': return [paragraph(inlines(node.children ?? []))];
      case 'heading': return [{ type: 'heading', attrs: { level: node.depth ?? 1 }, content: inlines(node.children ?? []) }];
      case 'blockquote': return [{ type: 'blockquote', content: blocks(node.children ?? []) }];
      case 'thematicBreak': return [{ type: 'horizontalRule' }];
      case 'code': return [{ type: 'codeBlock', attrs: { language: node.lang ?? null, meta: node.meta ?? null }, content: node.value ? [{ type: 'text', text: node.value }] : [] }];
      case 'math': return [{ type: 'blockMath', attrs: { latex: node.value ?? '' } }];
      case 'list': return [{ type: node.ordered ? 'orderedList' : 'bulletList', attrs: { start: node.start ?? 1, spread: !!node.spread }, content: (node.children ?? []).map(item => ({ type: 'listItem', attrs: { checked: item.checked ?? null, spread: !!item.spread }, content: blocks(item.children ?? []) })) }];
      case 'table': return [{ type: 'table', attrs: { markdownAlign: node.align ?? [] }, content: (node.children ?? []).map((row, index) => ({ type: 'table_row', content: (row.children ?? []).map((cell,column) => ({ type: index === 0 ? 'table_header' : 'table_cell', attrs:{markdownAlign:node.align?.[column]??null}, content: [paragraph(inlines(cell.children ?? []))] })) })) }];
      case 'html': {
        // Only convert full semantic blocks; partial/unknown HTML stays as source.
        if (parseHtml && /^\s*<(table|p|h[1-6]|blockquote|pre|ul|ol)(?:\s|>)/i.test(node.value ?? '')) {
          if(isSupportedMarkdownHtml(node.value??'')){const result = parseHtml(node.value ?? ''); if (result.length) return result;}
        }
        return [raw(node)];
      }
      default: return [raw(node)];
    }
  });
  const content = [...(front ? [{ type: 'rawMarkdown', attrs: { source: front.trimEnd() } }] : []), ...blocks(root.children ?? [])];
  return { type: 'doc', content: content.length ? content : [paragraph()] };
}

/** An HTML representation only of our bounded editor schema (never arbitrary source). */
export function markdownNodeHtml(node: JSONContent): string {
  const attrs = node.attrs ?? {}, children = () => (node.content ?? []).map(markdownNodeHtml).join('');
  let html: string;
  switch (node.type) {
    case 'text': html = escape(node.text ?? ''); break;
    case 'paragraph': return `<p>${children()}</p>`;
    case 'heading': return `<h${attrs.level}>${children()}</h${attrs.level}>`;
    case 'hardBreak': return '<br>';
    case 'horizontalRule': return '<hr>';
    case 'blockquote': return `<blockquote>${children()}</blockquote>`;
    case 'bulletList': return `<ul>${children()}</ul>`;
    case 'orderedList': return `<ol start="${Number(attrs.start) || 1}">${children()}</ol>`;
    case 'listItem': return `<li>${attrs.checked === true ? '[x] ' : attrs.checked === false ? '[ ] ' : ''}${children()}</li>`;
    case 'codeBlock': return `<pre><code${attrs.language ? ` class="language-${escape(attrs.language)}"` : ''}>${children()}</code></pre>`;
    case 'table': return `<table><tbody>${children()}</tbody></table>`;
    case 'table_row': return `<tr>${children()}</tr>`;
    case 'table_cell': case 'table_header': {
      const tag = node.type === 'table_header' ? 'th' : 'td';
      return `<${tag}${['left','center','right'].includes(attrs.markdownAlign)?` align="${attrs.markdownAlign}"`:''}${Number(attrs.colspan) > 1 ? ` colspan="${Number(attrs.colspan)}"` : ''}${Number(attrs.rowspan) > 1 ? ` rowspan="${Number(attrs.rowspan)}"` : ''}>${children()}</${tag}>`;
    }
    case 'image': return markdownUrl(attrs.src ?? '', true) ? `<img src="${escape(attrs.src)}" alt="${escape(attrs.alt ?? '')}"${attrs.title ? ` title="${escape(attrs.title)}"` : ''}>` : escape(attrs.alt ?? '');
    case 'inlineMath': return `<span data-md-math-inline="${escape(attrs.latex ?? '')}">${escape(attrs.latex ?? '')}</span>`;
    case 'blockMath': return `<div data-md-math-block="${escape(attrs.latex ?? '')}">${escape(attrs.latex ?? '')}</div>`;
    case 'rawMarkdownInline': return escape(attrs.source ?? '');
    case 'rawMarkdown': return `<pre>${escape(attrs.source ?? '')}</pre>`;
    default: return children();
  }
  for (const mark of node.marks ?? []) {
    const tag = ({ bold: 'strong', italic: 'em', strike: 's', code: 'code', superscript: 'sup', subscript: 'sub' } as Record<string, string>)[mark.type];
    if (tag) html = `<${tag}>${html}</${tag}>`;
    else if (mark.type === 'link' && markdownUrl(mark.attrs?.href ?? '')) html = `<a href="${escape(mark.attrs!.href)}">${html}</a>`;
  }
  return html;
}

export function serializeMarkdown(doc: JSONContent): string {
  function inline(nodes: JSONContent[]): Ast[] {
    // Group adjacent nodes by a common outer mark so bold links and mixed marks
    // serialize as one span, rather than invalid adjacent delimiter sequences.
    const result: Ast[] = [];
    for (let i = 0; i < nodes.length;) {
      const node = nodes[i], mark = node.marks?.[0];
      if (mark && node.type === 'text' && mark.type !== 'code') {
        let end = i + 1;
        while (end < nodes.length && nodes[end].type === 'text' && JSON.stringify(nodes[end].marks?.[0]) === JSON.stringify(mark)) end++;
        const children = inline(nodes.slice(i, end).map(n => ({ ...n, marks: n.marks?.slice(1) })));
        const type = ({ bold: 'strong', italic: 'emphasis', strike: 'delete', link: 'link' } as Record<string, string>)[mark.type];
        if (type) result.push({ type, ...(type === 'link' ? { url: mark.attrs?.href ?? '', title: mark.attrs?.title ?? null } : {}), children });
        else result.push(...children);
        i = end; continue;
      }
      switch (node.type) {
        case 'text': result.push({ type: node.marks?.some(m => m.type === 'code') ? 'inlineCode' : 'text', value: node.text ?? '' }); break;
        case 'hardBreak': result.push({ type: 'break' }); break;
        case 'inlineMath': result.push({ type: 'inlineMath', value: node.attrs?.latex ?? '' }); break;
        case 'image': result.push({ type: 'image', url: node.attrs?.src ?? '', alt: node.attrs?.alt ?? '', title: node.attrs?.title ?? null }); break;
        case 'rawMarkdownInline': result.push({ type: 'html', value: node.attrs?.source ?? '' }); break;
        default: result.push({ type: 'text', value: node.text ?? '' });
      }
      i++;
    }
    return result;
  }
  const block = (node: JSONContent): Ast => {
    const attrs = node.attrs ?? {}, content = node.content ?? [];
    switch (node.type) {
      case 'paragraph': return { type: 'paragraph', children: inline(content) };
      case 'heading': return { type: 'heading', depth: attrs.level ?? 1, children: inline(content) };
      case 'horizontalRule': return { type: 'thematicBreak' };
      case 'blockquote': return { type: 'blockquote', children: content.map(block) };
      case 'codeBlock': return { type: 'code', lang: attrs.language ?? null, meta: attrs.meta ?? null, value: content.map(c => c.text ?? '').join('') };
      case 'blockMath': return { type: 'math', value: attrs.latex ?? '' };
      case 'bulletList': case 'orderedList': return { type: 'list', ordered: node.type === 'orderedList', start: attrs.start ?? 1, spread: !!attrs.spread, children: content.map(item => ({ type: 'listItem', checked: item.attrs?.checked ?? null, spread: !!item.attrs?.spread, children: (item.content ?? []).map(block) })) };
      case 'table': {
        const simple = content.length > 0 && content.every((row, i) => row.content?.length === content[0].content?.length && row.content?.every(cell => Number(cell.attrs?.colspan ?? 1) === 1 && Number(cell.attrs?.rowspan ?? 1) === 1 && cell.type === (i === 0 ? 'table_header' : 'table_cell') && cell.content?.length === 1 && cell.content[0].type === 'paragraph' && !cell.content[0].content?.some(n => n.type === 'hardBreak')));
        if (!simple) return { type: 'html', value: markdownNodeHtml(node) };
        return { type: 'table', align: content[0].content?.map((cell,i)=>cell.attrs?.markdownAlign??attrs.markdownAlign?.[i]??null)??[], children: content.map(row => ({ type: 'tableRow', children: (row.content ?? []).map(cell => ({ type: 'tableCell', children: inline(cell.content![0].content ?? []) })) })) };
      }
      case 'rawMarkdown': return { type: 'html', value: attrs.source ?? '' };
      default: throw new Error(`无法保存 Markdown 节点 ${node.type}，原文件未修改。`);
    }
  };
  return processor.stringify({ type: 'root', children: (doc.content ?? []).map(block) } as Parameters<typeof processor.stringify>[0]);
}
