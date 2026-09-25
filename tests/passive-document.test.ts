// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {TodoEditor} from '../src/renderer/editor';
import {newEvent} from '../src/renderer/document';
import {GapCursor} from '@tiptap/pm/gapcursor';
let owner:TodoEditor;
const examples=['<ol start="3"><li>first</li></ol>','<blockquote><p>quote</p></blockquote>','<pre>  code\nlast</pre>','<h2 style="margin-top: 0px">heading</h2>','<p><img src="asset:5" width="80" height="60" /></p>'];
function setup(html:string){const element=document.createElement('div');document.body.append(element);const change=vi.fn();owner=new TodoEditor(element,{handle:'test',path:'test.tde',name:'test',revision:0,events:[{...newEvent(),id:17,content_html:html,content_text:'original text'}]},{change,selection:vi.fn(),error:vi.fn(),asset:vi.fn()});owner.editor.view.setProps({handleScrollToSelection:()=>true});return {editor:owner.editor,change};}
afterEach(()=>{owner?.destroy();document.body.innerHTML='';});
describe('passive document navigation and original HTML',()=>{
  it.each(examples)('selection leaves the document and original bytes untouched: %s',html=>{
    const {editor,change}=setup(html),before=editor.state.doc.toJSON();editor.commands.selectAll();owner.selectEvents([17]);editor.commands.setTextSelection(1);expect(editor.state.doc.toJSON()).toEqual(before);expect(change).not.toHaveBeenCalled();expect(owner.records()[0].content_html).toBe(html);
  });
  it.each(examples)('metadata-only edits keep original body bytes: %s',html=>{
    const {editor}=setup(html);owner.setEventDone(17,true);expect(owner.records()[0]).toMatchObject({done:1,content_html:html});editor.commands.undo();expect(owner.records()[0]).toMatchObject({done:0,content_html:html});
  });
  it('undoing all body edits restores original HTML instead of its normalized serialization',()=>{
    const html='<p style="margin: 0px">raw <b>bold</b></p>',{editor}=setup(html);editor.commands.setTextSelection(1);editor.commands.insertContent('edited ');expect(owner.records()[0].content_html).not.toBe(html);editor.commands.undo();expect(owner.records()[0].content_html).toBe(html);editor.commands.redo();expect(owner.records()[0].content_text).toBe('edited raw bold');
  });
  it('restores original HTML after Save As remaps an event ID',()=>{
    const html='<p>raw <b>bold</b></p>',{editor}=setup(html);editor.commands.setTextSelection(1);editor.commands.insertContent('edit ');const exported=owner.records();
    owner.retarget({...owner.snapshot,handle:'copy',events:exported.map(e=>({...e,id:81}))},exported);editor.commands.undo();expect(owner.records()[0]).toMatchObject({id:81,content_html:html});
  });
  it.each(['ctrlEnd','collapseRight'])('keeps an editable gap after a terminal divider using %s',mode=>{
    const {editor}=setup('<p></p>');editor.commands.setContent({type:'doc',content:[{type:'divider',attrs:{id:17}}]});
    if(mode==='collapseRight')editor.commands.selectAll();
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown',{key:mode==='ctrlEnd'?'End':'ArrowRight',ctrlKey:mode==='ctrlEnd',bubbles:true,cancelable:true}));
    expect(editor.state.selection).toBeInstanceOf(GapCursor);expect(editor.state.selection.from).toBe(1);editor.commands.insertContent('after');expect(editor.state.doc.firstChild?.type.name).toBe('divider');expect(editor.state.doc.textContent).toBe('after');
  });
  it('Enter at a terminal gap creates a body only on request and undoes back to the gap',()=>{
    const {editor}=setup('<p></p>');editor.commands.setContent({type:'doc',content:[{type:'divider',attrs:{id:17}}]});editor.view.dispatch(editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(1))));
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));expect(editor.state.doc.childCount).toBe(2);expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');editor.commands.undo();expect(editor.state.doc.childCount).toBe(1);expect(editor.state.selection).toBeInstanceOf(GapCursor);
  });
  it('Backspace after a terminal divider deletes it once and undo restores the gap',()=>{
    const {editor}=setup('<p></p>');editor.commands.setContent({type:'doc',content:[{type:'divider',attrs:{id:17}}]});editor.view.dispatch(editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(1))));
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');editor.commands.undo();expect(editor.state.doc.firstChild?.type.name).toBe('divider');expect(editor.state.selection).toBeInstanceOf(GapCursor);
  });
});
