import { effectiveStyle, isBulletStyle, isListStyle, listMarker, storedStyle, type ListStyle } from './list-style';
import type { JSONContent } from '@tiptap/core';
import {readParagraphFormat,formatStyles,inheritedFormat,normalizeFormat,type ParagraphFormat} from './paragraph-format';
import {readTableLayout,tableDomAttrs,cellDomAttrs,validTable,span} from './table-format';

type Mark = NonNullable<JSONContent['marks']>[number];
type Marks = Map<string, Mark>;
interface InlineState { marks: Marks; preWrap: boolean; format?:ParagraphFormat }
interface InlineToken { node: JSONContent; preWrap: boolean }
export interface QtHtmlResult { content: JSONContent[]; readOnly: boolean; reason?: string }

const markOrder = ['code','bold', 'italic', 'strike', 'underline', 'link', 'textStyle', 'superscript','subscript','highlight'];
const inlineTags = new Set(['span', 'b', 'strong', 'i', 'em', 's', 'strike', 'del', 'u', 'a', 'mark', 'font', 'br', 'img','sup','sub','code']);
const discardedTags = new Set(['script', 'style', 'meta', 'link', 'base', 'title', 'template', 'noscript', 'qt-import-head']);
const wrapperTags = new Set(['div', 'qt-import-html', 'qt-import-body']);

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function safeLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  if (!href || /[\u0000-\u0020\u007f-\u009f\\]/.test(href)) return null;
  // Relative paths, file:, data:, asset:, and protocol-relative URLs never leave
  // this codec as links. Actual navigation is owned by the outer application's IPC.
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return null;
  try {
    const url = new URL(href);
    if (url.protocol === 'mailto:') return url.pathname ? href : null;
    return url.hostname && !url.username && !url.password ? href : null;
  } catch { return null; }
}

function assetId(attrs: JSONContent['attrs']): number | null {
  const id = attrs?.assetId;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return id;
  const match = typeof attrs?.src === 'string' ? /^asset:(\d+)$/.exec(attrs.src) : null;
  const sourceId = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(sourceId) && sourceId > 0 ? sourceId : null;
}

function dimension(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?(?:px)?$/.test(value.trim())) return null;
  const number = typeof value === 'number' ? value : Number(value.trim().replace(/px$/, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** Qt writes letter/roman numbering and square/circle bullets as `type`, and number
 *  decorations as quoted -qt-list-number-prefix/suffix. Circled numbers have no Qt
 *  style, so they ride on a property Qt ignores and fall back to 1. 2. 3. there. */
function readListStyle(element: Element, tag: string): { listStyle: ListStyle | null; numberPrefix: string | null; numberSuffix: string | null } | null {
  const kind = tag === 'ol' ? 'orderedList' : 'bulletList';
  const type = element.getAttribute('type');
  const css = element.getAttribute('style') || '';
  const byType: Record<string, ListStyle> = { '1': 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman', disc: 'disc', circle: 'circle', square: 'square' };
  let style: ListStyle | undefined = type === null ? undefined : byType[type] ?? byType[type.toLowerCase()];
  if (type !== null && !style) return null;
  const cssType = /(?:^|;)\s*list-style-type\s*:\s*([a-z-]+)/i.exec(css)?.[1]?.toLowerCase();
  if (!style && cssType) { if (!isListStyle(cssType)) return null; style = cssType; }
  if (/(?:^|;)\s*-todoline-list-style\s*:\s*circled\b/i.test(css) && (!style || style === 'decimal')) style = 'circled';
  style ??= effectiveStyle(kind, null);
  if (isBulletStyle(style) !== (kind === 'bulletList')) return null;
  const quoted = (name: string) => kind === 'orderedList' ? new RegExp(`(?:^|;)\\s*-qt-list-number-${name}\\s*:\\s*(['"])(.*?)\\1`, 'i').exec(css)?.[2] ?? null : null;
  let numberPrefix = quoted('prefix'), numberSuffix = quoted('suffix');
  if (style === 'decimal' && numberPrefix === '(' && numberSuffix === ')') { style = 'paren'; numberPrefix = numberSuffix = null; }
  return { listStyle: storedStyle(kind, style), numberPrefix, numberSuffix };
}
/** The level Qt gives a list: its own -qt-list-indent, else one below the enclosing list. */
function qtListLevel(element: Element): number {
  const own = /(?:^|;)\s*-qt-list-indent\s*:\s*(\d+)/i.exec(element.getAttribute('style') || '');
  if (own) return Math.max(1, Number(own[1]));
  const parent = element.parentElement?.closest('ol,ul');
  return parent ? qtListLevel(parent) + 1 : 1;
}
/** Levels a list sits deeper than its nesting, as when a list's first item was indented on its own. */
function listIndentOf(element: Element): number {
  const parent = element.parentElement?.closest('ol,ul');
  return Math.max(0, qtListLevel(element) - (parent ? qtListLevel(parent) + 1 : 1));
}
function listStart(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+$/.test(value))) return 1;
  const start = Number(value);
  return Number.isSafeInteger(start) ? start : 1;
}

function headingLevel(value: unknown): number {
  const level = Number(value);
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1;
}

function safeCss(property: string, value: unknown, document: Document): string | null {
  if (typeof value !== 'string' || !value.trim() || /[<>\u0000-\u001f\\]|url\s*\(|expression\s*\(|@import/i.test(value)) return null;
  const style = document.createElement('span').style;
  style.setProperty(property, value.trim());
  return style.getPropertyValue(property) || null;
}


export function codeStyleCss(raw:unknown,document:Document=new DOMParser().parseFromString('', 'text/html')):string{
  const attrs=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
  return Object.entries({fontFamily:'font-family',fontSize:'font-size',color:'color'}).map(([key,property])=>{const value=safeCss(property,attrs[key],document);return value?`${property}:${value};`:'';}).join('');
}
const codeLanguage=(value:unknown)=>typeof value==='string'&&/^[a-z0-9_+#.-]{1,64}$/i.test(value)?value:null;

function orderedMarks(marks: Marks): Mark[] {
  return markOrder.flatMap(type => marks.has(type) ? [marks.get(type)!] : []);
}

function elementState(element: Element, inherited: InlineState, document: Document): InlineState {
  const marks = new Map(inherited.marks);
  const set = (type: string, enabled: boolean, attrs?: Mark['attrs']) => {
    if (enabled) marks.set(type, attrs ? { type, attrs } : { type });
    else marks.delete(type);
  };
  const tag = element.localName;
  if (tag === 'b' || tag === 'strong') set('bold', true);
  if (tag === 'i' || tag === 'em') set('italic', true);
  if (tag === 's' || tag === 'strike' || tag === 'del') set('strike', true);
  if (tag === 'u') set('underline', true);
  if (tag === 'code') set('code', true);
  if (tag === 'mark') set('highlight', true, { color: safeCss('background-color', '#ffff00', document)! });
  if (tag === 'a') {
    const href = safeLink(element.getAttribute('href'));
    const title = element.getAttribute('title');
    set('link', !!href, href ? { href, ...(title ? { title } : {}) } : undefined);
  }

  const style = (element as HTMLElement).style;
  const get = (property: string) => style?.getPropertyValue(property) || '';
  const vertical=get('vertical-align')||(tag==='sup'?'super':tag==='sub'?'sub':'');
  if(vertical&&vertical!=='inherit'){set('superscript',vertical==='super');set('subscript',vertical==='sub');}
  const weight = get('font-weight');
  if (weight) set('bold', /^(bold|bolder)$/i.test(weight) || +weight >= 600 || (+weight >= 63 && +weight <= 99));
  if (get('font-style')) set('italic', /^(italic|oblique)/i.test(get('font-style')));
  const decoration = get('text-decoration-line') || get('text-decoration');
  if (decoration) {
    set('strike', /\bline-through\b/.test(decoration));
    set('underline', /\bunderline\b/.test(decoration));
  }
  const textStyle = { ...marks.get('textStyle')?.attrs };
  const properties = { color: 'color', fontSize: 'font-size', fontFamily: 'font-family' };
  for (const [attr, property] of Object.entries(properties)) {
    const legacy = tag === 'font' ? element.getAttribute(attr === 'fontFamily' ? 'face' : attr) : null;
    const raw = get(property) || legacy;
    if (!raw) continue;
    if (/^(initial|unset)$/i.test(raw)) delete textStyle[attr];
    else if (raw !== 'inherit') {
      const value = safeCss(property, raw, document);
      if (value) textStyle[attr] = value;
    }
  }
  if((tag==='code'||tag==='pre')&&!get('font-family'))textStyle.fontFamily='Consolas';
  set('textStyle', Object.keys(textStyle).length > 0, textStyle);
  const background = get('background-color') || get('background');
  if (background) {
    const color = safeCss('background-color', background, document);
    if (color) set('highlight', color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)', { color });
  }
  const whiteSpace = get('white-space');
  return { marks, preWrap: whiteSpace ? /^(pre-wrap|pre|break-spaces)$/.test(whiteSpace) : inherited.preWrap,format:readParagraphFormat(element,inherited.format) };
}

// Fragment parsing into a template never activates images, styles, or embedded
// browsing contexts. Rename document containers first: a fragment parser otherwise
// discards <body>'s inherited font/color attributes. The tokenizer only renames tag
// names, leaving quoted attributes and comments intact; the browser parses HTML.
export function inertDocument(html: string, document = new DOMParser().parseFromString('', 'text/html')): { document: Document; root: DocumentFragment } {
  const template = document.createElement('template');
  template.innerHTML = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?([a-zA-Z][\w:-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/g,
    (token: string, tag: string | undefined) => tag && /^(html|head|body)$/i.test(tag)
      ? token.replace(/^(<\/?)[\w:-]+/, `$1qt-import-${tag.toLowerCase()}`) : token,
  );
  return { document, root: template.content };
}

function compactInline(tokens: InlineToken[]): JSONContent[] {
  const result: InlineToken[] = [];
  const trimEnd = () => {
    const last = result.at(-1);
    if (last?.node.type === 'text' && !last.preWrap) {
      last.node.text = last.node.text!.replace(/ $/, '');
      if (!last.node.text) result.pop();
    }
  };
  for (const token of tokens) {
    const previous = result.at(-1);
    if (token.node.type === 'text') {
      if (!token.preWrap && (!previous || previous.node.type === 'hardBreak' || /[ \t\r\n]$/.test(previous.node.text || ''))) {
        token.node.text = token.node.text!.replace(/^ /, '');
      }
      if (!token.node.text) continue;
    } else if (token.node.type === 'hardBreak') trimEnd();
    result.push(token);
  }
  trimEnd();
  const nodes: JSONContent[] = [];
  for (const { node } of result) {
    const previous = nodes.at(-1);
    if (node.type === 'text' && previous?.type === 'text' && JSON.stringify(node.marks) === JSON.stringify(previous.marks)) {
      previous.text += node.text!;
    } else nodes.push(node);
  }
  return nodes;
}

/** Import Qt rich text into the editor schema. readOnly means retain the source HTML. */
export function parseQtHtml(html: string, parsingDocument?:Document): QtHtmlResult {
  const { document, root } = inertDocument(html,parsingDocument);
  const unsupported = new Set<string>();
  for(const element of root.querySelectorAll('[style],[align],[dir]')){
    const style=(element as HTMLElement).style;
    if(inlineTags.has(element.localName)&&(element.hasAttribute('dir')||style.direction))unsupported.add('行内文字方向');
    const heightType=/(?:^|;)\s*-qt-line-height-type\s*:\s*([^;]+)/i.exec(element.getAttribute('style')||'')?.[1].trim();
    if(heightType&&!['fixed','proportional'].includes(heightType))unsupported.add('Qt 行高类型');
    const alignment=element.getAttribute('align')||style.textAlign;
    if(alignment&&!['left','right','center','justify','start','end','initial','inherit'].includes(alignment))unsupported.add('段落对齐');
    if(style.verticalAlign&&!(['td','th'].includes(element.localName)?['top','middle','bottom','baseline','initial','inherit']:['baseline','super','sub','initial','inherit']).includes(style.verticalAlign))unsupported.add('垂直对齐');
    for(const property of ['letter-spacing','word-spacing']){
      const value=style.getPropertyValue(property);if(value&&!/^(?:0(?:px|pt|em)?|normal|initial|inherit)$/.test(value))unsupported.add(property);
    }
    for(const property of ['text-indent','margin-left','margin-right','margin-top','margin-bottom']){
      const raw=style.getPropertyValue(property);if(raw&&!/^(?:-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt)?|initial|inherit|unset)$/.test(raw))unsupported.add(property);
    }
    if(style.lineHeight&&!/^(?:(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|%)?|normal|initial|inherit|unset)$/.test(style.lineHeight))unsupported.add('line-height');
    if(wrapperTags.has(element.localName)&&['margin-left','margin-right','margin-top','margin-bottom'].some(p=>parseFloat(style.getPropertyValue(p))))unsupported.add('容器边距');
  }
  let qtPreWrap = false;
  for (const style of root.querySelectorAll('style')) {
    // Only Qt's known whitespace rule is interpreted; stylesheets never execute.
    const css = style.textContent || '';
    if (/p\s*,\s*li\s*\{\s*white-space\s*:\s*pre-wrap\s*;?\s*\}/i.test(css)) qtPreWrap = true;
  }
  const initial: InlineState = { marks: new Map(), preWrap: false };
  const isBlock = (element: Element) => !inlineTags.has(element.localName) && !discardedTags.has(element.localName);
  const attrs=(format?:ParagraphFormat)=>format&&Object.keys(format).length?{format}:{};
  const paragraph = (content: JSONContent[] = [],format?:ParagraphFormat): JSONContent => ({ type: 'paragraph',...(Object.keys(attrs(format)).length?{attrs:attrs(format)}:{}),content });

  function inline(node: Node, state: InlineState): InlineToken[] {
    if (node.nodeType === 3) {
      const text = state.preWrap ? node.nodeValue || '' : (node.nodeValue || '').replace(/[ \t\r\n\f]+/g, ' ');
      const marks = orderedMarks(state.marks);
      return text ? [{ node: { type: 'text', text, ...(marks.length ? { marks } : {}) }, preWrap: state.preWrap }] : [];
    }
    if (node.nodeType !== 1) return [];
    const element = node as Element;
    const tag = element.localName;
    if (discardedTags.has(tag)) return [];
    const next = elementState(element, state, document);
    if (tag === 'br') return [{ node: { type: 'hardBreak' }, preWrap: next.preWrap }];
    if (tag === 'img') {
      const id = assetId({ src: element.getAttribute('src') });
      if (id === null) {
        unsupported.add('非 asset: 图片');
        return [{ node: { type: 'text', text: '[图片]' }, preWrap: true }];
      }
      const attrs: NonNullable<JSONContent['attrs']> = { assetId: id };
      for (const key of ['width', 'height']) {
        const size = dimension(element.getAttribute(key) || (element as HTMLElement).style.getPropertyValue(key));
        if (size !== null) attrs[key] = size;
      }
      const marks = orderedMarks(next.marks);
      return [{ node: { type: 'image', attrs, ...(marks.length ? { marks } : {}) }, preWrap: next.preWrap }];
    }
    if (!inlineTags.has(tag)) unsupported.add(`<${tag}>`);
    return Array.from(element.childNodes).flatMap(child => inline(child, next));
  }

  function block(element: Element, inherited: InlineState): JSONContent[] {
    const tag = element.localName;
    const state = elementState(element, inherited, document);
    if(tag==='table'){
      const rows:JSONContent[]=[];
      const readRows=(parent:Element,section:string|null,rowState:InlineState)=>{for(const child of Array.from(parent.children)){
        if(['thead','tbody','tfoot'].includes(child.localName)){readRows(child,child.localName,elementState(child,rowState,document));continue;}
        if(child.localName!=='tr'){unsupported.add('表格内的非行内容');continue;}
        const current=elementState(child,rowState,document),cells:JSONContent[]=[];
        for(const cell of Array.from(child.children)){
          if(!['td','th'].includes(cell.localName)){unsupported.add('表格行内的非单元格内容');continue;}
          for(const key of ['colspan','rowspan'])if(cell.hasAttribute(key)&&String(span(cell.getAttribute(key)))!==cell.getAttribute(key))unsupported.add('无效合并单元格');
          const inner=elementState(cell,current,document);
          cells.push({type:cell.localName==='th'?'table_header':'table_cell',attrs:{colspan:span(cell.getAttribute('colspan')),rowspan:span(cell.getAttribute('rowspan')),layout:readTableLayout(cell,unsupported)},content:blocks(cell,{...inner,format:inheritedFormat(inner.format)})});
        }
        rows.push({type:'table_row',attrs:{layout:readTableLayout(child,unsupported),section},content:cells});
      }};
      readRows(element,null,{...state,format:inheritedFormat(state.format)});if(!validTable(rows))unsupported.add('非矩形或越界合并的表格');
      return [{type:'table',attrs:{layout:readTableLayout(element,unsupported)},content:rows}];
    }
    if ((tag === 'p' || tag === 'li') && qtPreWrap && !(element as HTMLElement).style.whiteSpace) state.preWrap = true;
    if (tag === 'p' || /^h[1-6]$/.test(tag)) {
      let content = compactInline(Array.from(element.childNodes).flatMap(child => inline(child, state)));
      if (/-qt-paragraph-type\s*:\s*empty\b/i.test(element.getAttribute('style') || '')
        && content.length === 1 && content[0].type === 'hardBreak') content = [];
      return [tag === 'p' ? paragraph(content,state.format) : { type: 'heading', attrs: { level: +tag[1],...attrs(state.format) }, content }];
    }
    if(tag==='blockquote'){
      const format={marginLeft:'40px',marginRight:'40px',...state.format};
      return [{type:'blockquote',attrs:{format},content:blocks(element,{...state,format:inheritedFormat(state.format)})}];
    }
    if(tag==='pre'){
      let raw=compactInline(Array.from(element.childNodes).flatMap(child=>inline(child,{...state,preWrap:true})));
      if(/-qt-paragraph-type\s*:\s*empty\b/i.test(element.getAttribute('style')||'')&&raw.length===1&&raw[0].type==='hardBreak')raw=[];
      if(raw.some(n=>n.type!=='text'&&n.type!=='hardBreak'))unsupported.add('代码块内的非文本内容');
      const content:JSONContent[]=[];
      for(const node of raw){
        const text=node.type==='hardBreak'?'\n':node.type==='text'?node.text||'':'';if(!text)continue;
        const marks=node.marks?.filter(m=>m.type!=='code'),previous=content.at(-1);
        if(previous&&JSON.stringify(previous.marks||[])===JSON.stringify(marks||[]))previous.text+=text;
        else content.push({type:'text',text,...(marks?.length?{marks}:{})});
      }
      const language=codeLanguage(element.getAttribute('data-language')||element.querySelector('code')?.className.match(/(?:^|\s)language-(\S+)/)?.[1]);
      const codeStyle=state.marks.get('textStyle')?.attrs;
      return [{type:'codeBlock',attrs:{...attrs(state.format),...(language?{language}:{}),...(codeStyle?{codeStyle}:{})},content}];
    }
    if (tag === 'ol' || tag === 'ul') {
      const list = readListStyle(element, tag);
      if (element.hasAttribute('reversed') || !list) unsupported.add(`<${tag}> numbering`);
      const items: JSONContent[] = [];
      for (const child of Array.from(element.childNodes)) {
        if (child.nodeType === 3 && !child.nodeValue?.trim()) continue;
        if (child.nodeType === 8) continue;
        if (child.nodeType === 1) {
          const entry = child as Element;
          if (discardedTags.has(entry.localName)) continue;
          if (entry.localName === 'li') {
            if (entry.hasAttribute('value') || /\b(?:checked|unchecked)\b/.test(entry.className)) unsupported.add('<li> numbering/checkbox');
            const itemState = elementState(entry, state, document);
            if (qtPreWrap && !(entry as HTMLElement).style.whiteSpace) itemState.preWrap = true;
            const content = blocks(entry, {...itemState,format:inheritedFormat(itemState.format)});
            if (/-qt-paragraph-type\s*:\s*empty\b/i.test(entry.getAttribute('style') || '')
              && content.length === 1 && content[0].type === 'paragraph'
              && content[0].content?.length === 1 && content[0].content[0].type === 'hardBreak') content[0] = paragraph();
            if (content[0]?.type !== 'paragraph') content.unshift(paragraph());
            items.push({ type: 'listItem',...(Object.keys(attrs(itemState.format)).length?{attrs:attrs(itemState.format)}:{}),content });
            continue;
          }
          // QTextDocument can emit a nested list as a sibling of its preceding li.
          if ((entry.localName === 'ol' || entry.localName === 'ul') && items.length) {
            items.at(-1)!.content!.push(...block(entry, state));
            continue;
          }
          // Qt writes an item's additional unnumbered paragraphs after </li>.
          // They continue that item; creating a new item would change numbering.
          if(entry.localName==='p'&&items.length){
            items.at(-1)!.content!.push(...block(entry,state));
            continue;
          }
        }
        unsupported.add(`<${tag}> child`);
        items.push({ type: 'listItem', content: [paragraph(compactInline(inline(child, state)))] });
      }
      if (!items.length) items.push({ type: 'listItem', content: [paragraph()] });
      const listAttrs={...(tag==='ol'?{start:listStart(element.getAttribute('start'))}:{}),...(list?.listStyle?{listStyle:list.listStyle}:{}),...(list?.numberPrefix!=null?{numberPrefix:list.numberPrefix}:{}),...(list?.numberSuffix!=null?{numberSuffix:list.numberSuffix}:{}),...(listIndentOf(element)?{listIndent:listIndentOf(element)}:{}),...attrs(state.format)};
      return [{ type: tag === 'ol' ? 'orderedList' : 'bulletList', ...(Object.keys(listAttrs).length?{attrs:listAttrs}:{}), content: items }];
    }
    if (!wrapperTags.has(tag)) unsupported.add(`<${tag}>`);
    return blocks(element, state);
  }

  function blocks(parent: ParentNode, state: InlineState): JSONContent[] {
    const content: JSONContent[] = [];
    let pending: InlineToken[] = [];
    const flush = () => {
      const nodes = compactInline(pending);
        if (nodes.length) content.push(paragraph(nodes,state.format));
      pending = [];
    };
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 1 && isBlock(child as Element)) {
        flush();
        content.push(...block(child as Element, state));
      } else {
        // Pretty-print indentation between blocks is never a new paragraph.
        if (!pending.length && child.nodeType === 3 && !/[^ \t\r\n\f]/.test(child.nodeValue || '')) continue;
        pending.push(...inline(child, state));
      }
    }
    flush();
    return content.length ? content : [paragraph([],state.format)];
  }

  const content = blocks(root, initial);
  return unsupported.size
    ? { content, readOnly: true, reason: `包含暂不支持的 HTML 内容：${[...unsupported].join('、')}；请保留原始 HTML。` }
    : { content, readOnly: false };
}

function wrapHtml(value: string, marks: Mark[] | undefined, document: Document): string {
  for (const mark of [...(marks || [])].reverse()) {
    const simple: Record<string, string> = { bold: 'strong', italic: 'em', strike: 's', underline: 'u',superscript:'sup',subscript:'sub' };
    if(mark.type==='code')value=`<code style="font-family:Consolas;">${value}</code>`;
    else if (Object.hasOwn(simple, mark.type)) value = `<${simple[mark.type]}>${value}</${simple[mark.type]}>`;
    else if (mark.type === 'link') {
      const href = safeLink(mark.attrs?.href);
      if (href) {
        const title = typeof mark.attrs?.title === 'string' ? ` title="${escapeHtml(mark.attrs.title)}"` : '';
        value = `<a href="${escapeHtml(href)}"${title}>${value}</a>`;
      }
    } else if (mark.type === 'textStyle' || mark.type === 'highlight') {
      const declarations: string[] = [];
      const properties = mark.type === 'highlight'
        ? { color: 'background-color' }
        : { color: 'color', fontSize: 'font-size', fontFamily: 'font-family', backgroundColor: 'background-color' };
      for (const [attr, property] of Object.entries(properties)) {
        const raw = mark.attrs?.[attr] ?? (mark.type === 'highlight' ? '#ffff00' : undefined);
        const safe = safeCss(property, raw, document);
        if (safe) declarations.push(`${property}:${safe};`);
      }
      if (declarations.length) value = `<span style="${escapeHtml(declarations.join(''))}">${value}</span>`;
    }
  }
  return value;
}

/** Serialize only the supported schema to Qt-compatible, asset-only HTML. */
export function serializeQtHtml(content: JSONContent[],display=false): string {
  const document = new DOMParser().parseFromString('', 'text/html');
  // Qt levels of the list being written and its plain nesting depth; they differ only below
  // a list whose items were indented on their own.
  let listLevel=0,listNesting=0;
  const geometry=(node:JSONContent,paragraph=false,extra='')=>{
    const format=normalizeFormat(node.attrs?.format);
    let attrs='';if(!display&&format.textAlign)attrs+=` align="${format.textAlign}"`;if(format.direction)attrs+=` dir="${format.direction}"`;
    const style=(paragraph?'white-space:pre-wrap;':'')+'margin-top:0px;margin-bottom:0px;'+formatStyles(format,display)+extra;
    return attrs+(style?` style="${style}"`:'');
  };
  function render(node: JSONContent): string {
    const children = () => (node.content || []).map(render).join('');
    switch (node.type) {
      case 'table': {
        if(!validTable(node.content??[]))throw new Error('无法保存非矩形或越界合并的表格。');
        let body='',section:string|null=null;
        for(const row of node.content??[]){const next=['thead','tbody','tfoot'].includes(row.attrs?.section)?row.attrs!.section:null;if(next!==section){if(section)body+=`</${section}>`;if(next)body+=`<${next}>`;section=next;}body+=render(row);}if(section)body+=`</${section}>`;
        return `<table${htmlAttributes(tableDomAttrs(node.attrs?.layout,document))}>${body}</table>`;
      }
      case 'table_row': return `<tr${htmlAttributes(tableDomAttrs(node.attrs?.layout,document))}>${children()}</tr>`;
      case 'table_cell': case 'table_header': {const tag=node.type==='table_header'?'th':'td';return `<${tag}${htmlAttributes(cellDomAttrs(node.attrs??{},document))}>${children()}</${tag}>`;}
      case 'doc': return children();
      case 'text': return wrapHtml(escapeHtml(node.text || ''), node.marks, document);
      case 'hardBreak': return '<br />';
      case 'image': {
        const id = assetId(node.attrs);
        if (id === null) return '[图片]';
        let attrs = ` src="asset:${id}"`;
        for (const key of ['width', 'height']) {
          const size = dimension(node.attrs?.[key]);
          if (size !== null) attrs += ` ${key}="${size}"`;
        }
        return wrapHtml(`<img${attrs} />`, node.marks, document);
      }
      case 'paragraph': return node.content?.length
        ? `<p${geometry(node,true)}>${children()}</p>`
        : `<p${geometry(node,true).replace('style="','style="-qt-paragraph-type:empty;')}><br /></p>`;
      case 'heading': {
        const level = headingLevel(node.attrs?.level);
        return `<h${level}${geometry(node,true)}>${children()}</h${level}>`;
      }
      case 'blockquote': return `<blockquote${geometry({...node,attrs:{...node.attrs,format:{marginLeft:'40px',marginRight:'40px',...normalizeFormat(node.attrs?.format)}}})}>${children()}</blockquote>`;
      case 'codeBlock': {
        const language=codeLanguage(node.attrs?.language),style=codeStyleCss(node.attrs?.codeStyle,document);
        const attrs=geometry(node).replace('style="',`style="font-family:Consolas;${escapeHtml(style)}`);
        const body=(node.content||[]).map(child=>child.type==='text'?wrapHtml(escapeHtml(child.text||'').replace(/\n/g,'<br />'),child.marks,document):(()=>{throw new Error('代码块只能包含文本');})()).join('');
        return `<pre${body?attrs:attrs.replace('style="','style="-qt-paragraph-type:empty;')}${language?` data-language="${language}"`:''}>${body||'<br />'}</pre>`;
      }
      case 'orderedList': case 'bulletList': {
        const kind=node.type as 'orderedList'|'bulletList',style=effectiveStyle(kind,node.attrs?.listStyle),tag=kind==='orderedList'?'ol':'ul';
        const type=({'lower-alpha':'a','upper-alpha':'A','lower-roman':'i','upper-roman':'I',square:'square',circle:'circle'} as Record<string,string>)[style];
        // Qt reads the decoration only when quoted and writes it back in single quotes.
        const quote=(value:string)=>value.includes("'")?(value.includes('"')?null:`&quot;${escapeHtml(value)}&quot;`):`'${escapeHtml(value)}'`;
        const prefix=style==='paren'?'(':kind==='orderedList'&&typeof node.attrs?.numberPrefix==='string'?node.attrs.numberPrefix:null;
        const suffix=style==='paren'?')':kind==='orderedList'&&typeof node.attrs?.numberSuffix==='string'?node.attrs.numberSuffix:null;
        let extra='';
        if(prefix!==null&&quote(prefix))extra+=`-qt-list-number-prefix: ${quote(prefix)};`;
        if(suffix!==null&&quote(suffix))extra+=`-qt-list-number-suffix: ${quote(suffix)};`;
        if(style==='circled')extra+='-todoline-list-style: circled;';
        const indent=Math.max(0,Math.trunc(Number(node.attrs?.listIndent)||0)),level=listLevel+1+indent,nesting=listNesting+1;
        if(level!==nesting)extra+=`-qt-list-indent: ${level};`;
        const shown=(display&&style!=='decimal'&&style!=='disc'?` data-list-style="${style}"`:'')+(display&&indent?` data-list-indent="${indent}"`:'');
        const open=kind==='orderedList'?`ol start="${listStart(node.attrs?.start)}"`:'ul';
        const outer=[listLevel,listNesting];listLevel=level;listNesting=nesting;const inner=children();[listLevel,listNesting]=outer;
        return `<${open}${type?` type="${type}"`:''}${shown}${geometry(node,false,extra)}>${inner}</${tag}>`;
      }
      case 'listItem': return `<li${geometry(node)}>${children()}</li>`;
      default: throw new Error(`Unsupported editor node: ${node.type || '(missing type)'}`);
    }
  }
  const body = (content.length ? content : [{ type: 'paragraph' }]).map(render).join('\n');
  return '<!DOCTYPE HTML><html><head><meta name="qrichtext" content="1" />'
    + '<style type="text/css">p, li { white-space: pre-wrap; }</style></head><body>' + body + '</body></html>';
}

function escapeMarkdown(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/[\\`*_[\]{}<>#!|+~-]/g, '\\$&')
    .replace(/(^|\n)(\s*\d+)\./g, '$1$2\\.').replace(/\r\n?|\n/g, '  \n');
}

function markdownInline(content: JSONContent[]): string {
  const entries = content.map(node => ({
    node,
    marks: markOrder.flatMap(type => {
      if (!['bold', 'italic', 'strike', 'underline', 'link','superscript','subscript','code'].includes(type)) return [];
      const mark = node.marks?.find(mark => mark.type === type);
      return mark && (type !== 'link' || safeLink(mark.attrs?.href)) ? [mark] : [];
    }),
  }));
  // Group adjacent ranges sharing a mark, so a bold range split by an italic
  // child does not turn into ambiguous sequences like **one****two**.
  function render(items: typeof entries): string {
    let result = '';
    for (let index = 0; index < items.length;) {
      const item = items[index];
      const mark = item.marks[0];
      if (!mark) {
        result += item.node.type === 'image' ? '`[图片]`'
          : item.node.type === 'hardBreak' ? '  \n'
          : item.node.type === 'text' ? escapeMarkdown(item.node.text || '')
          : markdownInline(item.node.content || []);
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < items.length && JSON.stringify(items[end].marks[0]) === JSON.stringify(mark)) end += 1;
      const body = render(items.slice(index, end).map(entry => ({ ...entry, marks: entry.marks.slice(1) })));
      if(mark.type==='code'){const raw=plainInline(items.slice(index,end).map(entry=>entry.node)).replace(/\n/g,' '),runs=raw.match(/`+/g)||[],ticks='`'.repeat(Math.max(0,...runs.map(run=>run.length))+1),pad=(/^`|`$/.test(raw)||(/^ .* $/.test(raw)&&/\S/.test(raw)))?' ':'';result+=ticks+pad+raw+pad+ticks;}
      else if (mark.type === 'link') {
        const href = safeLink(mark.attrs?.href)!.replace(/[<>"\s]/g, char => encodeURIComponent(char));
        result += `[${body}](<${href}>)`;
      } else if (mark.type === 'underline') result += `<u>${body}</u>`;
      else if(mark.type==='superscript'||mark.type==='subscript'){const tag=mark.type==='superscript'?'sup':'sub';result+=`<${tag}>${body}</${tag}>`;}
      else {
        const delimiter = mark.type === 'bold' ? '**' : mark.type === 'italic' ? '*' : '~~';
        const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(body)!;
        result += match[2] ? `${match[1]}${delimiter}${match[2]}${delimiter}${match[3]}` : body;
      }
      index = end;
    }
    return result;
  }
  return render(entries);
}

function plainInline(content: JSONContent[]): string {
  return content.map(node => node.type === 'image' ? '[图片]'
    : node.type === 'hardBreak' ? '\n'
    : node.type === 'text' ? node.text || '' : plainInline(node.content || [])).join('');
}

function exportBlocks(content: JSONContent[], md: boolean, listItem = false): string {
  const render = (node: JSONContent): string => {
    if(node.type==='table')return md?serializeQtHtml([node],true).replace(/^[\s\S]*<body[^>]*>/i,'').replace(/<\/body>[\s\S]*$/i,'').replace(/<img\b[^>]*>/gi,'[图片]'):(node.content??[]).map(row=>(row.content??[]).map(cell=>exportBlocks(cell.content??[],false).replace(/\n/g,' / ')).join('\t')).join('\n');
    if (node.type === 'doc') return exportBlocks(node.content || [], md);
    if (node.type === 'orderedList' || node.type === 'bulletList') {
      const start = listStart(node.attrs?.start);
      return (node.content || []).map((item, index) => {
        const style = effectiveStyle(node.type as 'orderedList' | 'bulletList', node.attrs?.listStyle);
        // Markdown only understands "1." and "-"; plain text shows the marker the reader sees.
        const marker = md ? (node.type === 'orderedList' ? `${start + index}. ` : '- ') : listMarker(style, start + index, node.attrs?.numberPrefix, node.attrs?.numberSuffix);
        const body = exportBlocks(item.content || [], md, true);
        return marker + body.replace(/\n/g, `\n${' '.repeat(marker.length)}`);
      }).join('\n');
    }
    if(node.type==='blockquote'){const text=exportBlocks(node.content||[],md);return md?text.split('\n').map(line=>'> '+line).join('\n'):text;}
    if(node.type==='codeBlock'){const text=plainInline(node.content||[]),ticks='`'.repeat(Math.max(3,...(text.match(/`+/g)||[]).map(run=>run.length+1)));return md?ticks+(codeLanguage(node.attrs?.language)||'')+'\n'+text+'\n'+ticks:text;}
    if (node.type === 'listItem') return exportBlocks(node.content || [], md, true);
    const inline = md ? markdownInline : plainInline;
    if (node.type === 'heading') return (md ? `${'#'.repeat(headingLevel(node.attrs?.level))} ` : '') + inline(node.content || []);
    if (node.type === 'paragraph') return inline(node.content || []);
    return inline([node]);
  };
  return content.map((node, index) => {
    const separator = index === 0 ? '' : !md || (listItem && /^(bulletList|orderedList)$/.test(node.type || '')) ? '\n' : '\n\n';
    return separator + render(node);
  }).join('');
}
function htmlAttributes(attrs:Record<string,string>){return Object.entries(attrs).map(([key,value])=>` ${key}="${escapeHtml(value)}"`).join('');}

/** Body exports; event metadata and separators belong to the outer EventRecord app. */
export function plainText(content: JSONContent[]): string { return exportBlocks(content, false); }
export function markdown(content: JSONContent[]): string { return exportBlocks(content, true); }
