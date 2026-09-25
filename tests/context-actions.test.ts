// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {DividerRangeSelection} from '../src/renderer/divider-selection';
import {TodoEditor} from '../src/renderer/editor';
import {newEvent} from '../src/renderer/document';
let owner:TodoEditor;
function setup(bodies:string[],top=0){
  const el=document.createElement('div');document.body.append(el);
  owner=new TodoEditor(el,{handle:'context',path:'context.tde',name:'context.tde',revision:0,events:bodies.map((html,i)=>({...newEvent(),id:i+10,pos:i*1024,created_at:1750000000+i,deadline_raw:i?'明天':'',deadline_ts:i?1750086400:null,done:i===1?1:0,top_divider:i?0:top,content_html:html,content_text:html.replace(/<[^>]*>/g,'')}))},{change:vi.fn(),selection:vi.fn(),error:vi.fn(),asset:vi.fn()});
  owner.editor.view.setProps({handleScrollToSelection:()=>true});return owner.editor;
}
function caret(text:string){let at=-1;owner.editor.state.doc.descendants((n,pos)=>{if(n.isText&&n.text===text)at=pos;});if(at<0)throw new Error('missing text');owner.editor.commands.setTextSelection(at);}
afterEach(()=>{owner?.destroy();document.body.innerHTML='';});
describe('event move to top',()=>{
  it.each([0,1])('preserves event IDs, raw HTML and metadata; undo restores head divider %i',top=>{
    const ed=setup(['<p><b>第一</b></p>','<ol start="5"><li>第二</li></ol>','<p>第三<img src="asset:5" width="20" height="10" /></p>'],top);
    const before=owner.records(),json=ed.state.doc.toJSON();expect(owner.moveEventToTop(11)).toBe(true);
    const after=owner.records();expect(after.map(e=>e.id)).toEqual([11,10,12]);
    for(const record of after){const old=before.find(e=>e.id===record.id)!;expect(record).toMatchObject({content_html:old.content_html,done:old.done,created_at:old.created_at,deadline_raw:old.deadline_raw,deadline_ts:old.deadline_ts});}
    expect(new Set(after.map(e=>e.pos)).size).toBe(3);expect(owner.moveEventToTop(11)).toBe(false);
    ed.commands.undo();expect(ed.state.doc.toJSON()).toEqual(json);ed.commands.redo();expect(owner.records().map(e=>e.id)).toEqual([11,10,12]);
  });
  it('moves opaque HTML without altering it',()=>{const ed=setup(['<p>第一</p>','<table style="float:right"><tr><td>旧格式</td></tr></table>']);const raw=owner.records()[1].content_html;expect(owner.moveEventToTop(11)).toBe(true);expect(owner.records()[0].content_html).toBe(raw);ed.commands.undo();expect(owner.records()[1].content_html).toBe(raw);});
  it('refuses changes in a read-only editor',()=>{const ed=setup(['<p>第一</p>','<p>第二</p>']);ed.setEditable(false);expect(owner.moveEventToTop(11)).toBe(false);expect(owner.records().map(e=>e.id)).toEqual([10,11]);});
});
describe('restart numbering',()=>{
  it('splits at the current item, retaining earlier numbers and supporting undo',()=>{
    const ed=setup(['<ol start="7"><li>甲</li><li>乙</li><li>丙</li></ol>']);caret('乙');const before=ed.state.doc.toJSON();expect(owner.restartNumbering()).toBe(true);
    expect(ed.state.doc.content.toJSON().map((n:{attrs?:{start?:number}})=>n.attrs?.start)).toEqual([7,1]);expect(owner.records()[0].content_text).toBe('7. 甲\n1. 乙\n2. 丙');
    ed.commands.undo();expect(ed.state.doc.toJSON()).toEqual(before);
  });
  it('restarts the innermost list and keeps nested content and style',()=>{
    const ed=setup(['<ol start="3"><li>外层<ol start="5" type="a"><li>甲</li><li>乙<ul><li>子项</li></ul></li></ol></li><li>外层二</li></ol>']);caret('乙');owner.restartNumbering();
    const outer=ed.state.doc.firstChild!;expect(outer.attrs.start).toBe(3);expect(outer.childCount).toBe(2);
    const inner=outer.firstChild!.lastChild!;expect(inner.attrs).toMatchObject({start:1,listStyle:'lower-alpha'});expect(inner.textContent).toBe('乙子项');ed.state.doc.check();
  });
  it('can continue again after restarting',()=>{setup(['<ol start="3"><li>甲</li></ol><p>间隔</p><ol start="8"><li>乙</li></ol>']);caret('乙');owner.restartNumbering();expect(owner.canContinueNumbering()).toBe(true);owner.continueNumbering();expect(owner.records()[0].content_text).toContain('4. 乙');});
});

const press=(key:string,extra:KeyboardEventInit={})=>owner.editor.view.dom.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
function emptyCaret(){let at=-1;owner.editor.state.doc.descendants((n,pos)=>{if(at<0&&n.type.name==='paragraph'&&!n.content.size)at=pos+1;});if(at<0)throw new Error('missing empty line');owner.editor.commands.setTextSelection(at);}
it('Ctrl+T pins the caret event and one undo restores the order',()=>{
 const ed=setup(['<p>第一</p>','<p>第二</p>']);caret('第二');press('t',{ctrlKey:true});expect(owner.records().map(e=>e.id)).toEqual([11,10]);ed.commands.undo();expect(owner.records().map(e=>e.id)).toEqual([10,11]);
 ed.setEditable(false);press('t',{ctrlKey:true});expect(owner.records().map(e=>e.id)).toEqual([10,11]);
});
describe('empty list Backspace',()=>{
 it.each(['<ol><li><p></p></li><li>后文</li></ol>','<ul><li>前文</li><li><p></p></li><li>后文</li></ul>','<ol><li>父级<ol><li><p></p></li><li>子项</li></ol></li><li>后文</li></ol>','<ol style="-qt-list-indent:4"><li><p></p></li><li>后文</li></ol>','<ol><li>前文<p></p></li><li>后文</li></ol>'])('removes the marker then each indentation, preserving surrounding content: %s',html=>{
  const ed=setup([html]);emptyCaret();const before=ed.state.doc.toJSON(),text=ed.state.doc.textContent;
  press('Backspace');expect(owner.listStyle()).toBe(null);expect(ed.state.selection.$from.parent.attrs.format.marginLeft).toMatch(/px$/);expect(ed.state.doc.textContent).toBe(text);ed.state.doc.check();
  const lifted=ed.state.doc.toJSON();ed.commands.undo();expect(ed.state.doc.toJSON()).toEqual(before);ed.commands.redo();expect(ed.state.doc.toJSON()).toEqual(lifted);
  let count=0;while(ed.state.selection.$from.parent.attrs.format?.marginLeft&&count++<10)press('Backspace');expect(count).toBeGreaterThan(0);expect(count).toBeLessThan(10);expect(ed.state.selection.$from.parent.attrs.format?.marginLeft).toBeUndefined();expect(ed.state.doc.textContent).toBe(text);expect(owner.records()[0].content_html).toContain('后文');
 });
 it('keeps indentation after saving and reopening and can continue outdenting',()=>{
  setup(['<ol style="-qt-list-indent:3"><li><p></p></li></ol>']);emptyCaret();press('Backspace');const saved=owner.records()[0].content_html;owner.destroy();const ed=setup([saved]);emptyCaret();press('Backspace');expect(ed.state.selection.$from.parent.attrs.format.marginLeft).toBe('57px');
 });
 it('does not change an empty read-only list',()=>{const ed=setup(['<ol><li><p></p></li></ol>']);emptyCaret();ed.setEditable(false);const before=ed.state.doc.toJSON();press('Backspace');expect(ed.state.doc.toJSON()).toEqual(before);});
});

it.each([0,1])('updates event deadlines without losing body edits and supports undo with divider %i',top=>{
 const ed=setup(['<p>正文</p>','<p>其他</p>'],top);const before=owner.records()[0];expect(owner.setEventDeadline(10,'1天后',1800000000)).toBe(true);expect(owner.records()[0]).toMatchObject({deadline_raw:'1天后',deadline_ts:1800000000,content_html:before.content_html});ed.commands.undo();expect(owner.records()[0]).toMatchObject({deadline_raw:before.deadline_raw,deadline_ts:before.deadline_ts});ed.setEditable(false);expect(owner.setEventDeadline(10,'2天后',1800000001)).toBe(false);
});

it.each(['Backspace','Delete'])('a backward text selection highlights and deletes the divider with only selected text using %s',key=>{
 const ed=setup(['<p>甲</p>','<p>乙保留</p>','<p>丙</p>']);let divider=-1,anchor=-1;ed.state.doc.descendants((n,p)=>{if(n.type.name==='divider'&&n.attrs.id===11)divider=p;if(n.isText&&n.text==='乙保留')anchor=p+1;});
 const before=ed.state.doc.toJSON();ed.view.dispatch(ed.state.tr.setSelection(DividerRangeSelection.create(ed.state.doc,anchor,divider)));expect(ed.view.dom.querySelector('.text-selected-divider')).not.toBeNull();
 press(key);expect(owner.records()).toHaveLength(2);expect(ed.state.doc.textContent).toBe('甲保留丙');expect(ed.view.dom.querySelector('.text-selected-divider')).toBeNull();ed.commands.undo();expect(ed.state.doc.toJSON()).toEqual(before);
});
it('can delete a text range up to the first divider and restore it with undo',()=>{
 const ed=setup(['<p>甲保留</p>'],1);const before=ed.state.doc.toJSON();ed.view.dispatch(ed.state.tr.setSelection(DividerRangeSelection.create(ed.state.doc,3,0)));press('Delete');expect(ed.state.doc.textContent).toBe('保留');expect(owner.records()[0].top_divider).toBe(0);ed.commands.undo();expect(ed.state.doc.toJSON()).toEqual(before);
});
