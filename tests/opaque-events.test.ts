// @vitest-environment jsdom
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {TodoEditor} from '../src/renderer/editor';
import {newEvent,DocumentCodec} from '../src/renderer/document';
import type {EventRecord} from '../src/shared/types';
import {Fragment} from '@tiptap/pm/model';
const opaque='<table style="float:left"><tr><td>原格式</td></tr></table>';
const owners:TodoEditor[]=[];
function setup(events:Partial<EventRecord>[]=[{content_html:'<p>abcdef</p>',content_text:'abcdef'}]){
  const el=document.createElement('div');document.body.append(el);const error=vi.fn(),assets=vi.fn().mockResolvedValue([81]);
  const owner=new TodoEditor(el,{handle:'opaque',path:'test.tde',name:'test',revision:0,events:events.map((e,i)=>({...newEvent(),id:i+1,...e}))},{change:vi.fn(),selection:vi.fn(),error,asset:vi.fn(),assets,imageInfo:vi.fn().mockResolvedValue({width:32,height:24})});owners.push(owner);owner.editor.view.setProps({handleScrollToSelection:()=>true});return {owner,editor:owner.editor,error,assets};
}
function clip(html=opaque,top_divider=true){window.desktop={readClipboard:vi.fn().mockResolvedValue({text:'',html:'',events:JSON.stringify({events:[{created_at:123,html,text:'原格式',top_divider}],assets:[]})})} as any;}
beforeAll(()=>{Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>({left:0,top:0,right:0,bottom:0,width:0,height:0} as DOMRect);});
afterEach(()=>{owners.splice(0).forEach(o=>o.destroy());document.body.innerHTML='';});
it('undoes and redoes an opaque event pasted over an editable document, including persisted IDs',async()=>{
  const {owner,editor,error}=setup();editor.commands.selectAll();clip();await owner.paste();expect(error).not.toHaveBeenCalled();const rows=owner.records();expect(rows).toHaveLength(1);expect(rows[0].content_html).toBe(opaque);owner.remap({[rows[0].id]:91});editor.commands.undo();expect(owner.records().map(e=>e.content_text)).toEqual(['abcdef']);editor.commands.redo();expect(owner.records()[0]).toMatchObject({id:91,content_html:opaque});
});
it('keeps the editable suffix when pasting an opaque event at a text caret',async()=>{
  const {owner,editor,error}=setup();editor.commands.setTextSelection(3);clip();await owner.paste();expect(error).not.toHaveBeenCalled();expect(owner.records().map(e=>e.content_text)).toEqual(['ab','原格式','cdef']);expect(owner.records()[1].content_html).toBe(opaque);editor.commands.undo();expect(owner.records().map(e=>e.content_text)).toEqual(['abcdef']);
});
it('can add an opaque event next to an existing opaque event without changing its raw body',async()=>{
  const {owner,editor,error}=setup([{content_html:opaque,content_text:'原格式',top_divider:1},{content_html:'<p>editable</p>',content_text:'editable'}]);editor.commands.setTextSelection(editor.state.doc.content.size-1);clip();await owner.paste();expect(error).not.toHaveBeenCalled();expect(owner.records().filter(e=>e.content_html===opaque)).toHaveLength(2);editor.commands.undo();expect(owner.records().map(e=>e.content_text)).toEqual(['原格式','editable']);
});
it.each(['<blockquote><p>abcdef</p></blockquote>','<ol start="4"><li><p>abcdef</p></li></ol>','<table><tr><td><p>abcdef</p></td></tr></table>'])('keeps nested surrounding text outside the opaque event: %s',async html=>{
  const {owner,editor,error}=setup([{content_html:html,content_text:'abcdef'}]);let pos=0;editor.state.doc.descendants((n,p)=>{if(n.isText)pos=p+2;});editor.commands.setTextSelection(pos);clip();await owner.paste();expect(error).not.toHaveBeenCalled();const prefix=html.startsWith('<ol')?'4. ':'';expect(owner.records().map(e=>e.content_text)).toEqual([prefix+'ab','原格式',prefix+'cdef']);editor.state.doc.forEach(n=>{if(n.type.name!=='legacy')n.descendants(child=>expect(child.type.name).not.toBe('legacy'));});editor.commands.undo();expect(owner.records()[0].content_html).toBe(html);
});
it('rejects replacing an existing opaque body before importing referenced images',async()=>{
  const {owner,editor,error,assets}=setup([{content_html:opaque,content_text:'原格式'}]);editor.commands.selectAll();window.desktop={readClipboard:vi.fn().mockResolvedValue({text:'',html:'',events:JSON.stringify({events:[{created_at:123,html:'<p><img src="asset:1" /></p>',text:'[图片]'}],assets:[{name:'asset:1',data:'AQI='}]})})} as any;await owner.paste();expect(error).toHaveBeenCalledWith(expect.stringContaining('只读'));expect(assets).not.toHaveBeenCalled();expect(owner.records()[0].content_html).toBe(opaque);
});
it('refuses to serialize a malformed mixed opaque group instead of silently dropping text',()=>{
  const {editor}=setup([{content_html:opaque,content_text:'原格式'}]);const tail=editor.state.schema.nodes.paragraph.create(null,editor.state.schema.text('不能丢')),malformed=editor.state.doc.copy(editor.state.doc.content.append(Fragment.from(tail)));expect(()=>new DocumentCodec([]).records(malformed)).toThrow('边界无效');
});
it.each([true,false])('retains incoming metadata when a whole-document opaque paste has top_divider=%s',async top=>{
  const {owner,editor,error}=setup();editor.commands.selectAll();clip(opaque,top);await owner.paste();expect(error).not.toHaveBeenCalled();expect(owner.records()).toHaveLength(1);expect(owner.records()[0]).toMatchObject({content_html:opaque,created_at:123,top_divider:Number(top)});editor.commands.undo();expect(owner.records()[0].content_text).toBe('abcdef');editor.commands.redo();expect(owner.records()[0].content_html).toBe(opaque);
});
it.each([1,3,7])('isolates an opaque event without a leading divider at caret %s',async position=>{
  const {owner,editor,error}=setup();editor.commands.setTextSelection(position);clip(opaque,false);await owner.paste();expect(error).not.toHaveBeenCalled();const rows=owner.records();expect(rows.filter(e=>e.content_html===opaque)).toHaveLength(1);expect(rows.map(e=>e.content_text).join('')).toBe('abcdef'.slice(0,position-1)+'原格式'+'abcdef'.slice(position-1));expect(new Set(rows.map(e=>e.id)).size).toBe(rows.length);editor.commands.undo();expect(owner.records()[0].content_text).toBe('abcdef');
});
it('keeps suffix metadata without reusing an existing event ID',async()=>{
  const {owner,editor}=setup([{content_html:'<p>abcdef</p>',content_text:'abcdef',created_at:12,deadline_raw:'明天',deadline_ts:55,done:1}]);editor.commands.setTextSelection(3);clip();await owner.paste();const rows=owner.records();expect(rows[2]).toMatchObject({created_at:12,deadline_raw:'明天',deadline_ts:55,done:1,content_text:'cdef'});expect(new Set(rows.map(e=>e.id)).size).toBe(3);
});
it('continues to block raw body mutation and merging an opaque event with adjacent text',()=>{
  const {owner,editor,error}=setup([{content_html:opaque,content_text:'原格式',top_divider:1},{content_html:'<p>tail</p>',content_text:'tail'}]);const before=owner.records();editor.view.dispatch(editor.state.tr.setNodeMarkup(1,undefined,{...editor.state.doc.nodeAt(1)!.attrs,html:'changed'}));expect(owner.records()).toEqual(before);editor.view.dispatch(editor.state.tr.delete(2,3));expect(owner.records()).toEqual(before);expect(error).toHaveBeenCalledTimes(2);
});
it('blocks nesting an opaque body inside an editable block and refuses to serialize it',()=>{
  const {editor,error}=setup([{content_html:opaque,content_text:'原格式'}]);const nested=editor.state.schema.nodes.blockquote.create(null,editor.state.doc.firstChild),doc=editor.state.doc.copy(Fragment.from(nested));editor.view.dispatch(editor.state.tr.replaceWith(0,editor.state.doc.content.size,nested));expect(error).toHaveBeenCalled();expect(editor.state.doc.firstChild!.type.name).toBe('legacy');expect(()=>new DocumentCodec([]).records(doc)).toThrow('边界无效');
});
it.each(['c','x','v'])('routes Ctrl+%s exactly once even when the document has no editable text node',async key=>{
  const {owner,editor}=setup([{content_html:opaque,content_text:'原格式'}]);clip();const copy=vi.fn(),read=window.desktop.readClipboard;window.desktop.copy=copy;editor.commands.selectAll();const event=new KeyboardEvent('keydown',{key,ctrlKey:true,bubbles:true,cancelable:true});editor.view.dom.dispatchEvent(event);await owner.whenIdle();expect(event.defaultPrevented).toBe(true);if(key==='v')expect(read).toHaveBeenCalledOnce();else expect(copy).toHaveBeenCalledOnce();expect(owner.records()[0].content_html).toBe(opaque);
});
