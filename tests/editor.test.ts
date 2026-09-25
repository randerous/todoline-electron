import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { TodoEditor } from '../src/renderer/editor';
import { newEvent } from '../src/renderer/document';
import type { EventRecord } from '../src/shared/types';
import { clearInputTrace, inputTraceReport } from '../src/renderer/input-trace';

let ed:TodoEditor;
beforeAll(()=>{
  Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0} as DOMRect);
  Element.prototype.getClientRects=()=>[] as unknown as DOMRectList;
});
function setup(events:Partial<EventRecord>[]=[{top_divider:1,content_html:'<p>你好</p>',content_text:'你好'}]){
  const el=document.createElement('div');document.body.append(el);
  ed=new TodoEditor(el,{handle:'test',name:'test.tde',path:'test.tde',revision:0,events:events.map((e,i)=>({...newEvent(),id:i+1,pos:i*1024,...e}))},{change:vi.fn(),selection:vi.fn(),error:vi.fn(),asset:vi.fn()});return ed.editor;
}
function key(key:string,extra:KeyboardEventInit={}){const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});ed.editor.view.dom.dispatchEvent(event);}
afterEach(()=>{ed?.destroy();document.body.innerHTML='';});
describe('single document interactions',()=>{
  it('Ctrl+A then Left exposes a gap before the first divider; Delete retains body',()=>{
    const e=setup();e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));key('ArrowLeft');expect(e.state.selection).toBeInstanceOf(GapCursor);expect(e.state.selection.from).toBe(0);key('Delete');expect(e.state.doc.firstChild?.type.name).toBe('paragraph');expect(e.state.doc.textContent).toBe('你好');expect(ed.records()[0].top_divider).toBe(0);e.commands.undo();expect(ed.records()[0].top_divider).toBe(1);
  });
  it('Backspace at first body start deletes the first divider',()=>{const e=setup();e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc,2)));key('Backspace');expect(e.state.doc.firstChild?.type.name).toBe('paragraph');expect(e.state.doc.textContent).toBe('你好');});
  it('Backspace at file gap is safe',()=>{const e=setup();e.view.dispatch(e.state.tr.setSelection(new GapCursor(e.state.doc.resolve(0))));expect(()=>key('Backspace')).not.toThrow();});
  it('inserts a divider at the head without creating a spurious event',()=>{const e=setup([{content_html:'<p>你好</p>',content_text:'你好'}]);e.commands.setTextSelection(1);ed.split();expect(ed.records()).toHaveLength(1);expect(ed.records()[0].top_divider).toBe(1);expect(e.state.doc.textContent).toBe('你好');});
  it('splits a paragraph into events and undoes it as one step',()=>{const e=setup([{content_html:'<p>甲乙丙丁</p>',content_text:'甲乙丙丁'}]);e.commands.setTextSelection(3);ed.split();expect(ed.records().map(x=>x.content_text)).toEqual(['甲乙','丙丁']);e.commands.undo();expect(ed.records()).toHaveLength(1);expect(e.state.doc.textContent).toBe('甲乙丙丁');});
  it('preserves original HTML when only a timestamp control changes',()=>{const html='<p style="margin: 0px;">原文<strong>格式</strong></p>';const e=setup([{top_divider:1,content_html:html,content_text:'原文格式'}]);e.view.dispatch(e.state.tr.setNodeMarkup(0,undefined,{...e.state.doc.firstChild!.attrs,done:1}));expect(ed.records()[0].content_html).toBe(html);expect(ed.records()[0].done).toBe(1);});
  it('keeps consecutive empty events',()=>{setup([{top_divider:1},{top_divider:0},{content_html:'<p>末尾</p>',content_text:'末尾'}]);expect(ed.records()).toHaveLength(3);});
  it('does not intercept composition keys or rebuild the document',()=>{const e=setup();const node=e.view.dom;e.commands.setTextSelection(2);node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));key('Backspace',{isComposing:true});expect(e.state.doc.firstChild?.type.name).toBe('divider');expect(e.view.dom).toBe(node);node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));});
  it('tracks persisted IDs across undo and redo without mutating history',()=>{const e=setup([{content_html:'<p>甲乙</p>',content_text:'甲乙'}]);e.commands.setTextSelection(2);ed.split();const id=ed.records()[1].id;ed.remap({[id]:19});expect(ed.records()[1].id).toBe(19);e.commands.undo();e.commands.redo();expect(ed.records()[1].id).toBe(19);});
  it('blocks deletion of unsupported content',()=>{const e=setup([{content_html:'<table style="float:left"><tr><td>不能丢</td></tr></table>',content_text:'不能丢'}]);e.commands.selectAll();e.commands.deleteSelection();expect(ed.records()[0].content_html).toContain('<table style="float:left">');});
  it('typing before an existing leading divider assigns a distinct preamble ID',()=>{const e=setup();e.view.dispatch(e.state.tr.setSelection(new GapCursor(e.state.doc.resolve(0))));e.commands.insertContent({type:'paragraph',content:[{type:'text',text:'前言'}]});const r=ed.records();expect(new Set(r.map(x=>x.id)).size).toBe(r.length);expect(r.at(-1)?.id).toBe(1);e.commands.undo();expect(ed.records()).toHaveLength(1);});
  it('Home and Ctrl+End map to deterministic document selections',()=>{const e=setup();e.commands.setTextSelection(3);key('Home');expect(e.state.selection.from).toBe(2);key('Backspace');expect(ed.records()[0].top_divider).toBe(0);key('End',{ctrlKey:true});expect(e.state.selection.from).toBe(e.state.doc.content.size-1);});
  it('Tab inserts four spaces without moving focus; smart backspace removes an indentation unit',()=>{
    const e=setup([{content_html:'<p>正文</p>'}]);e.commands.setTextSelection(1);key('Tab');expect(e.state.doc.textContent).toBe('    正文');expect(e.state.selection.from).toBe(5);key('Backspace');expect(e.state.doc.textContent).toBe('正文');
  });
  it('Enter preserves indentation in one undo step without doubling a split indent',()=>{
    const e=setup([{content_html:'<p style="white-space:pre-wrap">    正文</p>'}]);e.commands.setTextSelection(3);key('Enter');expect(ed.records()[0].content_text).toBe('  \n    正文');e.commands.undo();expect(e.state.doc.textContent).toBe('    正文');
  });
  it('completion of a leading body event uses document history and preserves original HTML',()=>{
    const html='<p>自由正文</p>',e=setup([{content_html:html}]);ed.setEventDone(1,true);expect(ed.records()[0]).toMatchObject({done:1,content_html:html,top_divider:0});e.commands.undo();expect(ed.records()[0].done).toBe(0);
  });
  it('inserting below an event retains following content and undoes once',()=>{
    const e=setup([{top_divider:1,content_html:'<p>甲</p>',content_text:'甲'},{content_html:'<p>乙</p>',content_text:'乙'}]);ed.insertEventBelow(1);expect(ed.records().map(e=>e.content_text)).toEqual(['甲','','乙']);e.commands.undo();expect(ed.records()).toHaveLength(2);
  });
  it('event multiselection collapses left to the earliest selected boundary',()=>{
    const e=setup([{top_divider:1,content_html:'<p>甲</p>',content_text:'甲'},{content_html:'<p>乙</p>',content_text:'乙'}]);ed.selectEvents([1,2]);key('ArrowLeft');expect(e.state.selection).toBeInstanceOf(GapCursor);expect(ed.selectedEvents.size).toBe(0);key('Delete');expect(ed.records()[0].content_text).toBe('甲');
  });
  it('read-only snapshots reject direct transactions as well as disabled controls',()=>{
    const e=setup();ed.snapshot.readOnly=true;e.setEditable(false);e.commands.selectAll();e.commands.insertContent('不可写入');ed.setEventDone(1,true);ed.insertEventBelow(1);expect(ed.records()).toHaveLength(1);expect(ed.records()[0].done).toBe(0);expect(e.state.doc.textContent).toBe('你好');
  });
  it('event clipboard flags use the Qt boolean JSON schema',async()=>{
    setup([{top_divider:1,done:1,content_html:'<p>完成</p>'}]);const copy=vi.fn();window.desktop={copy} as any;ed.selectEvents([1]);await ed.copy(true);const payload=JSON.parse(copy.mock.calls[0][0].events);expect(payload.events[0]).toMatchObject({done:true,top_divider:true});
  });
  it('copying a later event retains its actual divider and creation time',async()=>{
    setup([{content_html:'<p>前文</p>'},{created_at:1700000000,deadline_raw:'1天后',content_html:'<p>后文</p>',content_text:'后文'}]);
    const copy=vi.fn();window.desktop={copy} as any;ed.selectEvents([2]);await ed.copy(true);
    expect(copy.mock.calls[0][0].text).toMatch(/^==== /);expect(copy.mock.calls[0][0].text).toContain('截止 1天后');expect(JSON.parse(copy.mock.calls[0][0].events).events[0].top_divider).toBe(true);
  });
  it('text fragment clipboard also includes the event envelope understood by Qt',async()=>{
    const e=setup([{content_html:'<p>选中的字</p>',content_text:'选中的字'}]);e.commands.setTextSelection({from:1,to:3});const copy=vi.fn();window.desktop={copy} as any;await ed.copy();const payload=JSON.parse(copy.mock.calls[0][0].events);expect(payload.fragment).toBeDefined();expect(payload.events[0]).toMatchObject({text:'选中',done:false,top_divider:false});
  });
  it('structured paste replaces selected events, preserves the leading-body flag and undoes',async()=>{
    const e=setup([{top_divider:1,content_html:'<p>甲</p>',content_text:'甲'},{content_html:'<p>乙</p>',content_text:'乙'}]);ed.selectEvents([1,2]);
    window.desktop={readClipboard:async()=>({events:JSON.stringify({events:[{created_at:123,done:true,top_divider:false,html:'<p>替换</p>',text:'替换'}],assets:[]})})} as any;
    await ed.paste();expect(ed.records()).toHaveLength(1);expect(ed.records()[0]).toMatchObject({created_at:123,done:1,top_divider:0,content_text:'替换'});e.commands.undo();expect(ed.records().map(e=>e.content_text)).toEqual(['甲','乙']);
  });
});
describe('column selection and an input method', () => {
  it('keeps column carets through an empty composition and leaves column mode once text is composed', () => {
    const e = setup([{ content_html: '<p>abc</p><p>def</p>' }]);
    const starts: number[] = []; e.state.doc.descendants((node, pos) => { if (node.type.name === 'paragraph') starts.push(pos + 2); return true; });
    ed.selectedRanges = starts.map(from => ({ from, to: from }));
    const dom = e.view.dom;
    dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    expect(ed.selectedRanges).toHaveLength(2);
    key('Process', { keyCode: 229 });
    dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    dom.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '中' }));
    expect(ed.selectedRanges).toHaveLength(0);
    dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    expect(e.state.doc.textContent).toBe('abcdef');
  });
});
describe('column selection when the input method composes on its own', () => {
  const columns = (e: ReturnType<typeof setup>) => { const starts: number[] = []; e.state.doc.descendants((node, pos) => { if (node.type.name === 'paragraph') starts.push(pos + 2); return true; }); ed.selectedRanges = starts.map(from => ({ from, to: from })); return e.view.dom; };
  const compose = (dom: HTMLElement, data: string) => { dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })); dom.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data })); dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data })); };

  it('a composition that already carries text but follows no key press keeps the column carets', () => {
    const e = setup([{ content_html: '<p>abc</p><p>def</p>' }]), dom = columns(e);
    compose(dom, '中文');
    expect(ed.selectedRanges).toHaveLength(2);
    expect(e.state.doc.textContent).toBe('abcdef');
  });

  it('keys reported while Alt is held neither leave column mode nor count as typing', () => {
    const e = setup([{ content_html: '<p>abc</p><p>def</p>' }]), dom = columns(e);
    key('Alt', { altKey: true }); key('Process', { altKey: true, keyCode: 229 }); key('Unidentified', { altKey: true });
    expect(ed.selectedRanges).toHaveLength(2);
    compose(dom, '中');
    expect(ed.selectedRanges).toHaveLength(2);
    // The user typing through the input method still composes at a single caret.
    key('Process', { keyCode: 229 }); compose(dom, '中');
    expect(ed.selectedRanges).toHaveLength(0);
  });

  it('the input trace names the path that ended a column selection', () => {
    const e = setup([{ content_html: '<p>abc</p><p>def</p>' }]);
    clearInputTrace(); columns(e); key('Escape');
    const report = inputTraceReport();
    expect(report).toMatch(/column-start\s+2 ranges/);
    expect(report).toMatch(/column-clear\s+\S+/);
    expect(report).toMatch(/keydown\s+key=Escape/);
  });
});
describe('text an input method commits without a key press', () => {
  it('still ends column mode once it changes the document, as voice or handwriting input does', () => {
    const e = setup([{ content_html: '<p>abc</p><p>def</p>' }]);
    const starts: number[] = []; e.state.doc.descendants((node, pos) => { if (node.type.name === 'paragraph') starts.push(pos + 2); return true; });
    ed.selectedRanges = starts.map(from => ({ from, to: from }));
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, starts[0])).setMeta('composition', 7));
    expect(ed.selectedRanges).toHaveLength(2);
    e.view.dispatch(e.state.tr.insertText('中', starts[0]).setMeta('composition', 7));
    expect(ed.selectedRanges).toHaveLength(0);
    expect(e.state.doc.textContent).toBe('a中bcdef');
  });
});
