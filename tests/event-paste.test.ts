// @vitest-environment jsdom
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {TodoEditor} from '../src/renderer/editor';
import {newEvent} from '../src/renderer/document';
const owners:TodoEditor[]=[];
function setup(texts=['甲','乙','丙','丁']){
  const el=document.createElement('div');document.body.append(el);const error=vi.fn(),asset=vi.fn().mockResolvedValue(81);
  const owner=new TodoEditor(el,{handle:'events',path:'test.tde',name:'test',revision:0,events:texts.map((text,i)=>({...newEvent(),id:i+1,pos:i*1024,created_at:100+i,done:i%2,top_divider:1,content_html:`<p>${text}</p>`,content_text:text}))},{change:vi.fn(),selection:vi.fn(),error,asset});owners.push(owner);owner.editor.view.setProps({handleScrollToSelection:()=>true});return {owner,editor:owner.editor,error,asset};
}
beforeAll(()=>{Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>({left:0,top:0,right:0,bottom:0,width:0,height:0} as DOMRect);});
afterEach(()=>{for(const owner of owners.splice(0))owner.destroy();document.body.innerHTML='';vi.unstubAllGlobals();});
function clipboard(text='新内容'){window.desktop={readClipboard:vi.fn().mockResolvedValue({text,html:'',events:''})} as any;}
it('plain multiline paste replaces contiguous events once and preserves surrounding metadata',async()=>{
  clipboard('新\r\n内容');const {owner,editor,error}=setup();const before=structuredClone(owner.records());owner.selectEvents([2,3]);await owner.paste();const rows=owner.records();expect(rows.map(e=>e.content_text)).toEqual(['甲','新\n内容','丁']);expect(rows[0]).toEqual(before[0]);expect(rows[2]).toEqual({...before[3],pos:rows[2].pos});expect(rows[1].done).toBe(0);expect(owner.selectedEvents.size).toBe(0);expect(error).not.toHaveBeenCalled();editor.commands.undo();expect(owner.records()).toEqual(before);editor.commands.redo();expect(owner.records().map(e=>e.content_text)).toEqual(['甲','新\n内容','丁']);
});
it('noncontiguous paste inserts before the last event without deleting selected events',async()=>{
  clipboard();const {owner}=setup();owner.selectEvents([1,3]);await owner.paste();expect(owner.records().map(e=>e.content_text)).toEqual(['甲','乙','丙','新内容','丁']);
});
it('noncontiguous paste replaces a genuinely empty last event',async()=>{
  clipboard();const {owner}=setup(['甲','乙','丙','']);owner.selectEvents([1,3]);await owner.paste();expect(owner.records().map(e=>e.content_text)).toEqual(['甲','乙','丙','新内容']);
});
it('internal fragments use the event envelope when complete events are selected',async()=>{
  const payload={fragment:[{type:'paragraph',content:[{type:'text',text:'新内容',marks:[{type:'bold'}]}]}],events:[{created_at:123,deadline_raw:'明天',deadline_ts:456,done:true,top_divider:true,html:'<p><b>新内容</b></p>',text:'新内容'}],assets:[]};window.desktop={readClipboard:vi.fn().mockResolvedValue({events:JSON.stringify(payload)})} as any;
  const {owner}=setup();owner.selectEvents([2,3]);await owner.paste();expect(owner.records().map(e=>e.content_text)).toEqual(['甲','新内容','丁']);expect(owner.records()[1]).toMatchObject({created_at:123,deadline_raw:'明天',deadline_ts:456,done:1});expect(owner.records()[1].content_html).toMatch(/<(b|strong)>/);
});
it('a file-picker image batch replaces events as one event and one undo step',async()=>{
  vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:800,height:600,close:vi.fn()}));const {owner,editor,asset}=setup();asset.mockImplementation(async(bytes:Uint8Array)=>80+bytes[0]);const before=structuredClone(owner.records());owner.selectEvents([2,3]);await owner.insertImages([new Uint8Array([1]),new Uint8Array([2])]);const rows=owner.records();expect(rows).toHaveLength(3);expect(rows[1].content_html).toMatch(/asset:81[\s\S]*asset:82/);expect(rows[0]).toEqual(before[0]);expect(rows[2]).toEqual({...before[3],pos:rows[2].pos});editor.commands.undo();expect(owner.records()).toEqual(before);
});
it('native image paste replaces the selected first event and keeps following bodies',async()=>{
  vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:800,height:600,close:vi.fn()}));window.desktop={readClipboard:vi.fn().mockResolvedValue({image:new Uint8Array([1]),text:'',events:''})} as any;
  const {owner}=setup();owner.selectEvents([1]);await owner.paste();const rows=owner.records();expect(rows).toHaveLength(4);expect(rows[0].content_html).toContain('asset:81');expect(rows[0].content_html).not.toContain('甲');expect(rows[0].top_divider).toBe(1);expect(rows.slice(1).map(e=>e.content_text)).toEqual(['乙','丙','丁']);
});
it('an image-only final event is never mistaken for an empty placeholder',async()=>{
  clipboard();const {owner}=setup(['甲','乙','丙','<img src="asset:9" width="20" height="10" />']);const last=structuredClone(owner.records()[3]);owner.selectEvents([1,3]);await owner.paste();expect(owner.records()).toHaveLength(5);expect(owner.records().at(-1)).toEqual({...last,pos:4096});
});
it('multiple empty paragraphs remain content rather than an empty placeholder',async()=>{
  clipboard();const {owner,editor}=setup(['甲','乙','丙','']);editor.commands.setTextSelection(editor.state.doc.content.size-1);editor.commands.splitBlock();expect(owner.records().at(-1)?.content_text).toBe('\n');owner.selectEvents([1,3]);await owner.paste();expect(owner.records().map(e=>e.content_text)).toEqual(['甲','乙','丙','新内容','\n']);
});
it('queued pastes replace a selected event range only once and then append',async()=>{
  let release!:(value:any)=>void;const first=new Promise(r=>{release=r;});window.desktop={readClipboard:vi.fn().mockImplementationOnce(()=>first).mockResolvedValue({text:'后',events:''})} as any;
  const {owner,editor}=setup();owner.selectEvents([2,3]);const one=owner.paste(),two=owner.paste();release({text:'先',events:''});await Promise.all([one,two]);expect(owner.records().map(e=>e.content_text)).toEqual(['甲','先后','丁']);editor.commands.undo();expect(owner.records().map(e=>e.content_text)).toEqual(['甲','先','丁']);editor.commands.undo();expect(owner.records().map(e=>e.content_text)).toEqual(['甲','乙','丙','丁']);
});
it('noncontiguous pending paste keeps its original destination when another event is appended',async()=>{
  let release!:(value:any)=>void;window.desktop={readClipboard:vi.fn(()=>new Promise(r=>{release=r;}))} as any;const {owner,editor}=setup();owner.selectEvents([1,3]);const pending=owner.paste();owner.insertEventBelow(4);editor.commands.insertContent('末尾新增');release({text:'新内容',events:''});await pending;expect(owner.records().map(e=>e.content_text)).toEqual(['甲','乙','丙','新内容','丁','末尾新增']);expect(editor.state.selection.$from.parent.textContent).toBe('末尾新增');
});
it('filling the empty replacement destination while waiting preserves the new content',async()=>{
  let release!:(value:any)=>void;window.desktop={readClipboard:vi.fn(()=>new Promise(r=>{release=r;}))} as any;const {owner,editor,error}=setup(['甲','乙','丙','']);owner.selectEvents([1,3]);const pending=owner.paste();owner.selectedEvents.clear();editor.commands.setTextSelection(editor.state.doc.content.size-1);editor.commands.insertContent('用户输入');release({text:'新内容',events:''});await pending;expect(owner.records().map(e=>e.content_text)).toEqual(['甲','乙','丙','用户输入']);expect(error).toHaveBeenCalled();
});
it.each([2,4])('pending replacement restores only still-existing later event selections (%s)',async later=>{
  let release!:(value:any)=>void;window.desktop={readClipboard:vi.fn(()=>new Promise(r=>{release=r;}))} as any;const {owner}=setup();owner.selectEvents([2,3]);const pending=owner.paste();owner.selectEvents([later]);release({text:'新内容',events:''});await pending;expect(owner.records().map(e=>e.content_text)).toEqual(['甲','新内容','丁']);expect([...owner.selectedEvents]).toEqual(later===4?[4]:[]);
});
