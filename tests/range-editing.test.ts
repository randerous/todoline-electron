// @vitest-environment jsdom
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {TodoEditor} from '../src/renderer/editor';
import {newEvent} from '../src/renderer/document';
import {leavesRangeMode} from '../src/renderer/range-editing';
const owners:TodoEditor[]=[];
function setup(row=false,html='<p>abcdef</p><p>ghijkl</p>'){
  const el=document.createElement('div');document.body.append(el);const error=vi.fn(),asset=vi.fn().mockResolvedValue(81);const owner=new TodoEditor(el,{handle:'ranges',path:'test.tde',name:'test',revision:0,events:[{...newEvent(),id:1,content_html:html,content_text:'abcdef\nghijkl'}]},{change:vi.fn(),selection:vi.fn(),error,asset});owners.push(owner);const editor=owner.editor;editor.view.setProps({handleScrollToSelection:()=>true});owner.selectedRanges=row?[{from:1,to:7,row:true},{from:9,to:15,row:true}]:[{from:2,to:4},{from:10,to:12}];editor.commands.setTextSelection(row?1:2);return {owner,editor,error,asset};
}
function key(owner:TodoEditor,key:string,extra:KeyboardEventInit={}){owner.editor.view.dom.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));}
function type(owner:TodoEditor,text:string){const view=owner.editor.view;view.someProp('handleTextInput',f=>f(view,view.state.selection.from,view.state.selection.to,text,()=>view.state.tr));}
beforeAll(()=>{Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>({left:0,top:0,right:0,bottom:0,width:0,height:0} as DOMRect);});
afterEach(()=>{for(const owner of owners.splice(0))owner.destroy();document.body.innerHTML='';vi.unstubAllGlobals();});
it.each([false,true])('empty clipboard never deletes selected content (row=%s)',async row=>{
  window.desktop={readClipboard:vi.fn().mockResolvedValue({text:'',html:'',events:''})} as any;const {owner,editor}=setup(row),before=editor.state.doc.toJSON();await owner.paste();expect(editor.state.doc.toJSON()).toEqual(before);expect(owner.selectedRanges).toHaveLength(2);
});
it.each([false,true])('image clipboard exits custom ranges and inserts once without deleting their text (row=%s)',async row=>{
  window.desktop={readClipboard:vi.fn().mockResolvedValue({text:'',events:'',image:new Uint8Array([1])})} as any;vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:80,height:60,close:vi.fn()}));const {owner,editor}=setup(row);await owner.paste();expect(editor.state.doc.textContent).toBe('abcdefghijkl');expect(owner.records()[0].content_html).toContain('asset:81');expect(owner.selectedRanges).toHaveLength(0);editor.commands.undo();expect(editor.state.doc.textContent).toBe('abcdefghijkl');expect(owner.records()[0].content_html).not.toContain('<img');
});
it('internal image clipboard keeps original bytes and display size instead of inserting its text placeholder',async()=>{
  const payload={image:{width:16,height:12},assets:[{name:'asset:4',data:'AQI=',w:80,h:60}],events:[]};window.desktop={readClipboard:vi.fn().mockResolvedValue({text:'[图片]',events:JSON.stringify(payload)})} as any;vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:80,height:60,close:vi.fn()}));const {owner,editor,asset}=setup();await owner.paste();expect(editor.state.doc.textContent).toBe('abcdefghijkl');expect(asset).toHaveBeenCalledWith(new Uint8Array([1,2]),80,60);expect(owner.records()[0].content_html).toContain('width="16" height="12"');
});
it('file-picker images clear old range highlights only after a successful insertion',async()=>{
  vi.stubGlobal('createImageBitmap',vi.fn().mockRejectedValueOnce(new Error('bad image')).mockResolvedValue({width:80,height:60,close:vi.fn()}));const {owner,editor}=setup();await owner.insertImage(new Uint8Array([1]));expect(owner.selectedRanges).toHaveLength(2);await owner.insertImages([new Uint8Array([1]),new Uint8Array([2])]);expect(owner.selectedRanges).toHaveLength(0);expect(editor.state.doc.textContent).toBe('abcdefghijkl');expect(owner.records()[0].content_html.match(/<img/g)).toHaveLength(2);editor.commands.undo();expect(owner.records()[0].content_html).not.toContain('<img');
});
it('column typing continues at every collapsed caret and deletes there in one undo step',()=>{
  const {owner,editor}=setup();type(owner,'X');expect(editor.state.doc.textContent).toBe('aXdefgXjkl');expect(owner.selectedRanges.map(r=>[r.from,r.to])).toEqual([[3,3],[10,10]]);type(owner,'Y');expect(editor.state.doc.textContent).toBe('aXYdefgXYjkl');key(owner,'Backspace');expect(editor.state.doc.textContent).toBe('aXdefgXjkl');editor.commands.undo();expect(editor.state.doc.textContent).toBe('aXYdefgXYjkl');
});
it('column single-line paste retains carets while multiline paste exits and inserts only once',async()=>{
  const read=vi.fn().mockResolvedValueOnce({text:'X',events:''}).mockResolvedValue({text:'A\nB',events:''});window.desktop={readClipboard:read} as any;const {owner,editor}=setup();await owner.paste();expect(owner.selectedRanges).toHaveLength(2);await owner.paste();expect(editor.state.doc.textContent).toBe('aXABdefgXjkl');expect(owner.selectedRanges).toHaveLength(0);editor.commands.undo();expect(editor.state.doc.textContent).toBe('aXdefgXjkl');
});
it.each(['Home','End','Enter','a','z'])('navigation or document command %s exits range mode',command=>{
  const {owner}=setup();key(owner,command,{ctrlKey:command==='a'||command==='z'});expect(owner.selectedRanges).toHaveLength(0);
});
it.each(['Backspace','Delete'])('collapsed column %s removes whole graphemes on every row',command=>{
  const value='A👩‍💻e\u0301B',offset=command==='Delete'?1:8,{owner,editor}=setup(false,`<p>${value}</p><p>${value}</p>`);const a=1+offset,b=value.length+3+offset;owner.selectedRanges=[{from:a,to:a},{from:b,to:b}];editor.commands.setTextSelection(a);key(owner,command);expect(editor.state.doc.textContent).toBe((command==='Delete'?'Ae\u0301B':'A👩‍💻B').repeat(2));key(owner,command);expect(editor.state.doc.textContent).toBe('ABAB');editor.commands.undo();expect(editor.state.doc.textContent).toBe((command==='Delete'?'Ae\u0301B':'A👩‍💻B').repeat(2));
});
it.each(['Backspace','Delete'])('collapsed column %s at paragraph edges never merges rows',command=>{
  const {owner,editor}=setup(),positions=command==='Backspace'?[1,9]:[7,15];owner.selectedRanges=positions.map(from=>({from,to:from}));editor.commands.setTextSelection(positions[0]);key(owner,command);expect(editor.state.doc.childCount).toBe(2);expect(editor.state.doc.textContent).toBe('abcdefghijkl');expect(owner.selectedRanges).toHaveLength(2);
});
it('consecutive queued column pastes retain every caret and append in order',async()=>{
  let release!:(value:any)=>void;window.desktop={readClipboard:vi.fn().mockImplementationOnce(()=>new Promise(r=>{release=r;})).mockResolvedValue({text:'Y',events:''})} as any;const {owner,editor}=setup();const one=owner.paste(),two=owner.paste();release({text:'X',events:''});await Promise.all([one,two]);expect(editor.state.doc.textContent).toBe('aXYdefgXYjkl');expect(owner.selectedRanges).toHaveLength(2);editor.commands.undo();expect(editor.state.doc.textContent).toBe('aXdefgXjkl');
});
it('row paste preserves a deliberately blank replacement line',async()=>{
  window.desktop={readClipboard:vi.fn().mockResolvedValue({text:'X\n',events:''})} as any;const {owner,editor}=setup(true);await owner.paste();expect(editor.state.doc.childCount).toBe(2);expect(owner.records()[0].content_text).toBe('X\n');editor.commands.undo();expect(editor.state.doc.textContent).toBe('abcdefghijkl');
});
it('Ctrl+Backspace exits columns before normal word deletion',()=>{
  const {owner}=setup();key(owner,'Backspace',{ctrlKey:true});expect(owner.selectedRanges).toHaveLength(0);
});
it('adjacent wrapped-line ranges collapse to one caret without duplicating the next input',()=>{
  const {owner,editor}=setup(false,'<p>abcdef</p>');owner.selectedRanges=[{from:1,to:4},{from:4,to:7}];editor.commands.setTextSelection(1);key(owner,'Backspace');expect(editor.state.doc.textContent).toBe('');type(owner,'X');expect(editor.state.doc.textContent).toBe('X');expect(owner.selectedRanges).toHaveLength(1);
});
it('keys an input method or Windows reports while Alt is held never leave column mode; real shortcuts still do',()=>{
  const down=(key:string,extra:KeyboardEventInit={})=>new KeyboardEvent('keydown',{key,...extra});
  for(const event of [down('Alt',{altKey:true}),down('AltGraph',{altKey:true,ctrlKey:true}),down('Process',{altKey:true}),down('Unidentified',{altKey:true}),down('Process'),down('CapsLock'),down('c',{ctrlKey:true})])expect(leavesRangeMode(event)).toBe(false);
  for(const event of [down('a',{altKey:true}),down('ArrowDown'),down('Home'),down('z',{ctrlKey:true})])expect(leavesRangeMode(event)).toBe(true);
});
