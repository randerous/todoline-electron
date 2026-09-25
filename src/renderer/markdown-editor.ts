import {multiTextSelection,MultiTextSelection} from './multi-selection';
import {copyToClipboard,clipboardPlainText} from './clipboard-output';
import { Editor, Extension, type JSONContent } from '@tiptap/core';
import { DOMParser as PMDOMParser, DOMSerializer, Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, TextSelection,NodeSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history';
import { addRowAfter, addRowBefore, addColumnAfter, addColumnBefore, deleteRow, deleteColumn, deleteTable, mergeCells, splitCell, toggleHeaderRow } from '@tiptap/pm/tables';
import type { TextFileSnapshot } from '../shared/native-document';
import type { DesktopAPI } from '../shared/types';
import { searchMatches, searchPattern, type SearchOptions } from '../shared/search';
import { AsyncTarget, orderedClipboard } from './async-editing';
import { normalizeMarkdownClipboardHtml, markdownUrl } from './markdown-clipboard';
import { markdownExtensions,formulaHtml } from './markdown-nodes';
import { parseMarkdown, serializeMarkdown, markdownNodeHtml } from './markdown-codec';
import { markdownHeadings } from './markdown-outline';
import { markdownCodeHighlight } from './markdown-code-plugin';
import { searchMarkdownDoc } from './markdown-search';
import './markdown-editor.css';
import {hasMarkdownFeatures} from './markdown-detection';

type Clipboard = Awaited<ReturnType<DesktopAPI['readClipboard']>>;
export interface MarkdownBridge {
  change(history?: boolean): void; selection(): void; error(message: string): void;
  asset(data: Uint8Array, name: string): Promise<string>;
}

export class MarkdownEditor {
  readonly editor: Editor;
  private pending = new Set<Promise<unknown>>();
  private targets = new Set<AsyncTarget>();
  private applying = false;
  private originalJSON = '';
  private originalSource: string;
  private matcher: RegExp | null = null;
  private destroyed = false;
  constructor(element: HTMLElement, private snapshot: TextFileSnapshot, private bridge: MarkdownBridge) {
    this.originalSource = snapshot.source;
    const owner = this;
    const search = Extension.create({ name: 'markdownSearch', addKeyboardShortcuts(){return {'Mod-l':()=>this.editor.commands.toggleOrderedList(),...Object.fromEntries(([1,2,3,4,5,6] as const).map(level=>['Mod-'+level,()=>this.editor.isEditable&&this.editor.commands.toggleHeading({level})]))};}, addProseMirrorPlugins() { return [multiTextSelection(),markdownCodeHighlight(),new Plugin({ props: { decorations(state) {
      if (!owner.matcher) return DecorationSet.empty;
      const decorations: Decoration[] = [];
      state.doc.descendants((node, pos) => { if (node.isText) for (const [from, to] of searchMatches(node.text ?? '', owner.matcher!)) decorations.push(Decoration.inline(pos + from, pos + to, { class: 'md-search-match' }));else if(node.isAtom&&searchMatches(String(node.attrs.latex??node.attrs.source??''),owner.matcher!).length)decorations.push(Decoration.node(pos,pos+node.nodeSize,{class:'md-search-match'})); });
      return DecorationSet.create(state.doc, decorations);
    } } })]; } });
    this.editor = new Editor({
      element, extensions: [...markdownExtensions(src => this.imageSource(src)), search],
      content: { type: 'doc', content: [{ type: 'paragraph' }] }, editable: !snapshot.readOnly,
      editorProps: { attributes: { class: 'markdown-document', spellcheck: 'false', 'aria-label': 'Markdown 正文' },
        handlePaste: () => { void this.paste().catch(error => bridge.error(String(error))); return true; },
        handleDOMEvents: {
          copy: (_view, event) => { event.preventDefault(); void this.copy().catch(error => bridge.error(String(error))); return true; },
          cut: (_view, event) => { event.preventDefault(); void this.copy(true).catch(error => bridge.error(String(error))); return true; },
          click: (view, event) => { const anchor = (event.target as HTMLElement).closest('a[href]'); if (anchor) { event.preventDefault(); if(view.state.selection instanceof NodeSelection){const pos=view.posAtCoords({left:event.clientX,top:event.clientY})?.pos??view.posAtDOM(anchor,0);view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));}if (event.ctrlKey || event.metaKey) { const href = markdownUrl(anchor.getAttribute('href') ?? ''); if (href && /^(https?:|mailto:)/i.test(href)) void window.desktop.openLink(href); } return true; } return false; },
        },
      },
      onUpdate: ({transaction}) => { bridge.change(isHistoryTransaction(transaction)); }, onSelectionUpdate: () => bridge.selection(),
      onTransaction: ({ transaction }) => { for (const target of this.targets) target.map(transaction, this.applying); },
    });
    this.editor.chain().setMeta('addToHistory', false).setContent(parseMarkdown(snapshot.source, html => this.parseHtml(html)), { emitUpdate: false }).run();
    this.originalJSON = JSON.stringify(this.editor.getJSON());
    window.addEventListener('keydown', this.modifier); window.addEventListener('keyup', this.modifier); window.addEventListener('blur', this.blur);
  }
  private modifier = (event: KeyboardEvent) => { this.editor.view.dom.classList.toggle('ctrl-held', event.ctrlKey || event.metaKey); };
  private blur = () => { this.editor.view.dom.classList.remove('ctrl-held'); };
  private imageSource(src: string) { return src.startsWith('data:') ? src : `md-asset://document/${this.snapshot.handle}/${encodeURIComponent(src)}`; }
  private parseHtml(html: string): JSONContent[] {
    const normalized = normalizeMarkdownClipboardHtml(html), doc = new DOMParser().parseFromString(normalized.html, 'text/html');
    for (const warning of normalized.warnings) this.bridge.error(warning);
    return PMDOMParser.fromSchema(this.editor.schema).parse(doc.body).toJSON().content ?? [];
  }
  source(): string { const json = this.editor.getJSON(); return JSON.stringify(json) === this.originalJSON ? this.originalSource : serializeMarkdown(json); }
  text(): string { return this.editor.state.doc.textBetween(0, this.editor.state.doc.content.size, '\n', node => node.attrs.latex ?? node.attrs.source ?? node.attrs.alt ?? ''); }
  html(): string { return (this.editor.getJSON().content ?? []).map(markdownNodeHtml).join('\n'); }
  async printHtml():Promise<string>{
    const doc=new DOMParser().parseFromString(this.html(),'text/html');
    await Promise.all(Array.from(doc.querySelectorAll('[data-md-math-inline],[data-md-math-block]')).map(async node=>{const block=node.hasAttribute('data-md-math-block');node.innerHTML=await formulaHtml(node.getAttribute(block?'data-md-math-block':'data-md-math-inline')??'',block);}));
    for(const image of Array.from(doc.images)){
      const src=image.getAttribute('src')??'';
      if(/^https?:/i.test(src)){image.replaceWith(doc.createTextNode((image.alt||'图片')+' ('+src+')'));continue;}
      if(!src.startsWith('data:'))image.src=this.imageSource(src);
    }
    return doc.body.innerHTML;
  }
  headings() { return markdownHeadings(this.editor.state.doc); }
  retarget(snapshot: TextFileSnapshot) {
    const previous=this.snapshot.handle;this.snapshot = snapshot; this.originalSource = snapshot.source; this.originalJSON = JSON.stringify(this.editor.getJSON());
    if(previous!==snapshot.handle)for(const image of this.editor.view.dom.querySelectorAll<HTMLImageElement>('img[src^="md-asset:"]')){const url=new URL(image.src);if(url.pathname.startsWith('/'+previous+'/')){url.pathname='/'+snapshot.handle+url.pathname.slice(previous.length+1);image.src=url.href;}}
  }
  setSearch(query: string, options: SearchOptions = {}) { this.matcher = searchPattern(query, options); this.editor.view.dispatch(this.editor.state.tr.setMeta('md-search', true)); }
  search(query: string, options: SearchOptions = {}): { id: number; text: string }[] {
    return searchMarkdownDoc(this.editor.state.doc,query,options);
  }
  focusPosition(pos: number, focus = true) {
    const resolved = Math.max(0, Math.min(this.editor.state.doc.content.size, pos));
    this.editor.view.dispatch(this.editor.state.tr.setSelection(TextSelection.near(this.editor.state.doc.resolve(resolved))).scrollIntoView());
    if (focus) this.editor.view.focus();
    // ProseMirror's selection scrolling can be skipped while a search input owns focus.
    const scroller = this.editor.view.dom.closest<HTMLElement>('.document-scroller');
    if (scroller) {
      const target = this.editor.view.coordsAtPos(resolved), viewport = scroller.getBoundingClientRect();
      if (target.top < viewport.top || target.bottom > viewport.bottom)
        scroller.scrollTop += target.top - viewport.top - 10;
    }
  }
  focusHeading(pos: number) { this.focusPosition(pos + 1); const dom = this.editor.view.nodeDOM(pos); if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start' }); }
  private track<T>(operation: Promise<T>): Promise<T> { this.pending.add(operation); void operation.finally(() => this.pending.delete(operation)).catch(() => {}); return operation; }
  async whenIdle() { while (this.pending.size) await Promise.all([...this.pending]); }
  private target(snapshot = false) { const selection = this.editor.state.selection; const target = new AsyncTarget(selection, new Set(), [], selection.ranges.map(r=>({from:r.$from.pos,to:r.$to.pos})), false, snapshot); this.targets.add(target); return target; }
  private apply(target: AsyncTarget, content: JSONContent[] | string) {
    if (this.destroyed || !target.valid || !this.editor.isEditable) throw new Error('粘贴位置已变化，请重新粘贴。');
    const state = this.editor.state, tr = closeHistory(state.tr), { from, to } = target.selection;
    if(target.selection instanceof MultiTextSelection){const slice=typeof content==='string'?(content?new Slice(Fragment.from(this.editor.schema.text(content)),0,0):Slice.empty):new Slice(Fragment.fromJSON(this.editor.schema,content),0,0);target.selection.replace(tr,slice);}
    else if (typeof content === 'string') tr.insertText(content, from, to);
    else tr.replaceRange(from, to, new Slice(Fragment.fromJSON(this.editor.schema, content), 0, 0));
    if (target.moved) tr.setSelection(state.selection.map(tr.doc, tr.mapping));
    else tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, tr.mapping.map(to, 1))))).scrollIntoView();
    this.applying = true; try { this.editor.view.dispatch(tr); } finally { this.applying = false; }
    this.editor.view.dispatch(closeHistory(this.editor.state.tr));
  }
  private async importImages(content: JSONContent[]) {
    for (const node of content) {
      if (node.type === 'image' && /^data:image\//i.test(node.attrs?.src ?? '')) {
        const match = /^data:image\/[\w+-]+;base64,([\s\S]+)$/i.exec(node.attrs!.src);
        if (match) { const bytes = Uint8Array.from(atob(match[1].replace(/\s/g, '')), c => c.charCodeAt(0)); node.attrs!.src = await this.bridge.asset(bytes, '粘贴图片'); }
      }
      if (node.content) await this.importImages(node.content);
    }
  }
  paste(plain = false, clipboard?: Clipboard): Promise<void> {
    if (!this.editor.isEditable) return Promise.resolve();
    const target = this.target();
    const operation=async () => {
      try {
        const clip = clipboard ?? await window.desktop.readClipboard();
        if (target.selection.$from.parent.type.name === 'codeBlock') { this.apply(target, clip.text); return; }
        let content: JSONContent[];
        if (plain) content = clip.text.split(/\r?\n/).map(text => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }));
        else if (clip.html) {
          const body=new DOMParser().parseFromString(clip.html,'text/html').body;
          const semantic=body.querySelector('h1,h2,h3,h4,h5,h6,strong,b,em,i,del,s,code,pre,table,ul,ol,img,a,math,[data-md-math-inline],[data-md-math-block],[data-md-raw-inline],[data-md-raw-block]');
          content=!semantic&&hasMarkdownFeatures({text:clip.text})?parseMarkdown(clip.text,html=>this.parseHtml(html)).content??[]:this.parseHtml(clip.html);
        }
        else if (clip.text) content = parseMarkdown(clip.text, html => this.parseHtml(html)).content ?? [];
        else {
          const images = clip.images?.length ? clip.images : clip.image ? [{ name: '粘贴图片', data: clip.image }] : [];
          content = []; for (const image of images) content.push({ type: 'paragraph', content: [{ type: 'image', attrs: { src: await this.bridge.asset(image.data, image.name), alt: image.name } }] });
        }
        if (!content.length) return;
        await this.importImages(content); this.apply(target, content);
      } finally { this.targets.delete(target); }
    };
    // A captured clipboard may be handed off by TDE's already-ordered paste.
    // Re-enqueuing that handoff behind itself would deadlock both save queues.
    return this.track(clipboard?operation():orderedClipboard(operation));
  }
  copy(cut = false): Promise<void> {
    const target = this.target(true), selection = this.editor.state.selection;
    if (selection.empty) { this.targets.delete(target); return Promise.resolve(); }
    const slice = selection.content(), container = document.createElement('div');
    container.append(DOMSerializer.fromSchema(this.editor.schema).serializeFragment(slice.content));
    const json = slice.content.toJSON() as JSONContent[], content = json.every(n => this.editor.schema.nodes[n.type!]?.isInline) ? [{ type: 'paragraph', content: json }] : json;
    const text=clipboardPlainText(content);
    return this.track(orderedClipboard(async () => {
      try {
        // Embed document-local images so another document can import its own
        // attachment, even after the source tab is closed or moved.
        for (const image of Array.from(container.querySelectorAll('img'))) {
          const src=image.getAttribute('src')??'';
          if (src&&!/^(https?:|data:)/i.test(src)) image.src=await window.desktop.markdown.readAsset(this.snapshot.handle,src);
        }
        await copyToClipboard({ text, html: container.innerHTML }); if (cut && this.editor.isEditable) this.apply(target, '');
      }
      finally { this.targets.delete(target); }
    }, true));
  }
  insertImages(files: File[]): Promise<void> {
    const target = this.target();
    return this.track((async () => { try {
      const content: JSONContent[] = [];
      for (const file of files) content.push({ type: 'paragraph', content: [{ type: 'image', attrs: { src: await this.bridge.asset(new Uint8Array(await file.arrayBuffer()), file.name), alt: file.name } }] });
      if (content.length) this.apply(target, content);
    } finally { this.targets.delete(target); } })());
  }
  tableAction(action: string) {
    if (action === 'insert') { this.editor.chain().focus().insertContent({ type: 'table', content: Array.from({ length: 3 }, (_, i) => ({ type: 'table_row', content: Array.from({ length: 3 }, () => ({ type: i === 0 ? 'table_header' : 'table_cell', content: [{ type: 'paragraph' }] })) })) }).run(); return; }
    const commands: Record<string, typeof addRowAfter> = { rowBefore: addRowBefore, rowAfter: addRowAfter, columnBefore: addColumnBefore, columnAfter: addColumnAfter, deleteRow, deleteColumn, deleteTable, merge: mergeCells, split: splitCell, header: toggleHeaderRow };
    commands[action]?.(this.editor.state, this.editor.view.dispatch); this.editor.view.focus();
  }
  destroy() { this.destroyed = true; for (const target of this.targets) target.valid = false; window.removeEventListener('keydown', this.modifier); window.removeEventListener('keyup', this.modifier); window.removeEventListener('blur', this.blur); this.editor.destroy(); }
}
