import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser, type Node as PMNode } from '@tiptap/pm/model';
import { searchMatches, searchPattern, type SearchOptions } from '../shared/search';
import { markdownExtensions } from './markdown-nodes';
import { parseMarkdown } from './markdown-codec';
import { normalizeMarkdownClipboardHtml } from './markdown-clipboard';

export function searchMarkdownDoc(doc: PMNode, query: string, options: SearchOptions = {}): { id: number; text: string }[] {
  const matcher = searchPattern(query, options), found: { id: number; text: string }[] = []; if (!matcher) return found;
  doc.descendants((node, pos) => {
    const text = node.isText ? node.text ?? '' : ['inlineMath', 'blockMath', 'rawMarkdown', 'rawMarkdownInline'].includes(node.type.name) ? String(node.attrs.latex ?? node.attrs.source ?? '') : '';
    for (const [start] of searchMatches(text, matcher)) found.push({ id: pos + (node.isText ? start : 0), text });
  }); return found;
}
/** Search an unvisited tab without mounting an editor, NodeViews or math renderer. */
export function searchMarkdownSource(source: string, query: string, options: SearchOptions = {}) {
  const schema = getSchema(markdownExtensions(src => src));
  const json = parseMarkdown(source, html => {
    const clean = normalizeMarkdownClipboardHtml(html).html, body = new DOMParser().parseFromString(clean, 'text/html').body;
    return PMDOMParser.fromSchema(schema).parse(body).toJSON().content ?? [];
  });
  return searchMarkdownDoc(schema.nodeFromJSON(json), query, options);
}
