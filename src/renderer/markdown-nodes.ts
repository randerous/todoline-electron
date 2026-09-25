import { Node, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import CodeBlock from '@tiptap/extension-code-block';
import { Table, TableRow, TableCell, TableHeader, TableBehavior } from './tables';
import { markdownUrl } from './markdown-clipboard';
import {cellDomAttrs} from './table-format';

let katexPromise: Promise<typeof import('katex')> | undefined;
const formulaCache = new Map<string, string>();
export async function formulaHtml(latex: string, display: boolean) {
  const key = `${display}:${latex}`, cached = formulaCache.get(key); if (cached !== undefined) return cached;
  katexPromise ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([katex]) => katex).catch(error => { katexPromise = undefined; throw error; });
  const katex = await katexPromise;
  const html = katex.default.renderToString(latex, { displayMode: display, throwOnError: false, trust: false, maxExpand: 1000, maxSize: 20 });
  formulaCache.set(key, html); if (formulaCache.size > 256) formulaCache.delete(formulaCache.keys().next().value!);
  return html;
}

function sourceNode(name: string, inline: boolean, math: boolean) {
  const attribute = math ? 'latex' : 'source', htmlAttribute = math ? `data-md-math-${inline ? 'inline' : 'block'}` : `data-md-raw-${inline ? 'inline' : 'block'}`;
  return Node.create({
    name, group: inline ? 'inline' : 'block', inline, atom: true, selectable: true,
    addAttributes() { return { [attribute]: { default: '', parseHTML: element => element.getAttribute(htmlAttribute), renderHTML: attrs => ({ [htmlAttribute]: attrs[attribute] }) } }; },
    parseHTML() { return [{ tag: `${inline ? 'span' : 'div'}[${htmlAttribute}]` }]; },
    renderHTML({ node, HTMLAttributes }) { return [inline ? 'span' : 'div', HTMLAttributes, node.attrs[attribute]]; },
    addNodeView() { return ({ node, editor, getPos }) => {
      let current = node, generation = 0, destroyed = false;
      const dom = document.createElement(inline ? 'span' : 'div'); dom.className = math ? `md-formula${inline ? ' inline' : ' block'}` : `md-raw${inline ? ' inline' : ' block'}`;
      dom.contentEditable = 'false';
      const display = document.createElement(inline ? 'span' : 'div'); display.className = 'md-source-display'; display.tabIndex = 0; display.setAttribute('role', 'button'); display.setAttribute('aria-label', math ? '编辑公式 LaTeX' : '编辑保留的 Markdown 源码'); dom.append(display);
      let panel: HTMLDivElement | undefined;
      const refresh = () => {
        const id = ++generation, source = String(current.attrs[attribute] ?? ''); display.textContent = source;
        if (math) void formulaHtml(source, !inline).then(html => { if (!destroyed && generation === id) display.innerHTML = html; }).catch(() => { if (!destroyed && generation === id) display.title = '公式渲染暂不可用，点击编辑源码'; });
      };
      const open = () => {
        if (!editor.isEditable || panel) return;
        panel = document.createElement('div'); panel.className = 'md-source-editor'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', math ? '编辑公式' : '编辑源码');
        const input = document.createElement('textarea'); input.value = current.attrs[attribute] ?? ''; input.setAttribute('aria-label', math ? 'LaTeX 源码' : 'Markdown 源码');
        const controls = document.createElement('div'), apply = document.createElement('button'), cancel = document.createElement('button'); apply.textContent = '应用'; cancel.textContent = '取消';
        const close = () => { panel?.remove(); panel = undefined; editor.view.focus(); };
        const save = () => { const pos = getPos(); if (typeof pos === 'number' && !editor.isDestroyed && editor.state.doc.nodeAt(pos)?.type === current.type) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, [attribute]: input.value })); close(); };
        apply.onclick = save; cancel.onclick = close;
        input.onkeydown = event => { if (event.isComposing) return; if (event.key === 'Escape') { event.preventDefault(); close(); } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); } };
        controls.append(cancel, apply); panel.append(input, controls); dom.append(panel); input.focus(); input.select();
      };
      display.onclick = open; display.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
      // Large documents defer formula work until a node approaches the viewport.
      let observer: IntersectionObserver | undefined;
      if (math && typeof IntersectionObserver !== 'undefined') { display.textContent = current.attrs[attribute]; observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); observer = undefined; refresh(); } }, { rootMargin: '300px' }); observer.observe(dom); }
      else refresh();
      return { dom, update(next) { if (next.type !== current.type) return false; const changed = next.attrs[attribute] !== current.attrs[attribute]; current = next; if (changed) refresh(); return true; }, stopEvent(event) { return !!panel?.contains(event.target as globalThis.Node) || display.contains(event.target as globalThis.Node); }, ignoreMutation() { return true; }, destroy() { destroyed = true; observer?.disconnect(); panel?.remove(); } };
    }; },
  });
}

const MarkdownListItem = Node.create({
  name: 'listItem', content: 'paragraph block*', defining: true,
  addAttributes() { return { checked: { default: null, parseHTML: element => element.getAttribute('data-task') === 'true' ? element.getAttribute('data-checked') === 'true' : null, renderHTML: attrs => attrs.checked === null ? {} : { 'data-task': 'true', 'data-checked': String(attrs.checked) } }, spread: { default: false, rendered: false } }; },
  parseHTML() { return [{ tag: 'li' }]; }, renderHTML({ HTMLAttributes }) { return ['li', HTMLAttributes, 0]; },
  addNodeView() { return ({ node, editor, getPos }) => {
    let current = node;
    const dom = document.createElement('li'), checkbox = document.createElement('input'), contentDOM = document.createElement('div');
    checkbox.type = 'checkbox'; checkbox.contentEditable = 'false'; checkbox.setAttribute('aria-label', '任务完成状态'); dom.append(checkbox, contentDOM);
    const refresh = () => { checkbox.hidden = current.attrs.checked === null; checkbox.checked = !!current.attrs.checked; checkbox.disabled = !editor.isEditable; if (current.attrs.checked !== null) dom.dataset.task = 'true'; else delete dom.dataset.task; };
    checkbox.onchange = () => { const pos = getPos(); if (editor.isEditable && typeof pos === 'number') editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, checked: checkbox.checked })); else refresh(); };
    refresh(); return { dom, contentDOM, update(next) { if (next.type !== current.type) return false; current = next; refresh(); return true; }, stopEvent(event) { return event.target === checkbox; } };
  }; },
});

export function markdownExtensions(imageSource: (src: string) => string): Extensions {
  const align={default:null,parseHTML:(el:HTMLElement)=>{const value=el.style.textAlign||el.getAttribute('align');return value&&['left','center','right'].includes(value)?value:null;},renderHTML:()=>({})};
  const cell=(extension:typeof TableCell,tag:string)=>extension.extend({addAttributes(){return {...this.parent?.(),markdownAlign:align};},renderHTML({node}){const attrs=cellDomAttrs(node.attrs);if(node.attrs.markdownAlign)attrs.style=[attrs.style,'text-align:'+node.attrs.markdownAlign].filter(Boolean).join(';');return [tag,attrs,0];}});
  const Image = Node.create({
    name: 'image', inline: true, group: 'inline', draggable: true, atom: true,
    addAttributes() { return { src: { default: '' }, alt: { default: '' }, title: { default: null } }; },
    parseHTML() { return [{ tag: 'img[src]' }]; },
    renderHTML({ node }) { return ['img', { src: markdownUrl(node.attrs.src, true) ? node.attrs.src : '', alt: node.attrs.alt, title: node.attrs.title }]; },
    addNodeView() { return ({ node }) => {
      const dom = document.createElement('span'); dom.className = 'md-image'; dom.contentEditable = 'false';
      const refresh = (next: typeof node) => {
        dom.replaceChildren(); const url = markdownUrl(next.attrs.src, true), label = next.attrs.alt || next.attrs.src || '图片';
        if (!url || /^https?:/i.test(url)) { const placeholder = document.createElement('span'); placeholder.className = 'md-image-placeholder'; placeholder.textContent = label; placeholder.title = url ? '远程图片链接已保留' : '图片路径不可用'; dom.append(placeholder); return; }
        const img = document.createElement('img'); img.alt = next.attrs.alt ?? ''; img.title = next.attrs.title ?? ''; img.loading = 'lazy'; img.src = imageSource(url); dom.append(img);
      };
      refresh(node); return { dom, update(next) { if (next.type !== node.type) return false; if (JSON.stringify(next.attrs) !== JSON.stringify(node.attrs)) refresh(next); node = next; return true; }, ignoreMutation() { return true; } };
    }; },
  });
  return [StarterKit.configure({ codeBlock: false, listItem: false, underline:false, link: { openOnClick: false } }),
    CodeBlock.extend({ addAttributes() { return { ...this.parent?.(), meta: { default: null, rendered: false } }; } }),
    MarkdownListItem,
    Table.extend({ addAttributes() { return { ...this.parent?.(), markdownAlign: { default: [], rendered: false } }; } }), TableRow, cell(TableCell,'td'), cell(TableHeader,'th'), TableBehavior,
    Image, sourceNode('inlineMath', true, true), sourceNode('blockMath', false, true), sourceNode('rawMarkdown', false, false), sourceNode('rawMarkdownInline', true, false)];
}
