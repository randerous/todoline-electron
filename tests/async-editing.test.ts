// @vitest-environment jsdom
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {TodoEditor} from '../src/renderer/editor';
import {newEvent} from '../src/renderer/document';
const owners:TodoEditor[]=[];
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function setup(html='<p>abcdef</p>'){
  const el=document.createElement('div');document.body.append(el);const error=vi.fn(),asset=vi.fn().mockResolvedValue(81);
  const owner=new TodoEditor(el,{handle:String(owners.length),path:'test.tde',name:'test',revision:0,events:[{...newEvent(),id:1,content_html:html,content_text:'abcdef'}]},{change:vi.fn(),selection:vi.fn(),error,asset});owners.push(owner);owner.editor.view.setProps({handleScrollToSelection:()=>true});return {owner,editor:owner.editor,error,asset};
}
beforeAll(()=>{Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>({left:0,top:0,width:0,height:0,right:0,bottom:0} as DOMRect);});
afterEach(()=>{for(const o of owners.splice(0))o.destroy();document.body.innerHTML='';vi.unstubAllGlobals();});
it('copy then paste in another document waits for the original image and the new clipboard',async()=>{
  vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:800,height:600,close:vi.fn()}));
  const image=deferred<any>();let packet:any={text:'stale',events:'',html:''};const read=vi.fn(async()=>packet);
  window.desktop={asset:vi.fn(()=>image.promise),copy:vi.fn(async data=>{packet=data;}),readClipboard:read} as any;
  const a=setup('<p>a<img src="asset:5" width="80" height="60" />b</p>'),b=setup('<p>target</p>');a.editor.commands.selectAll();b.editor.commands.setTextSelection(1);
  const copying=a.owner.copy(),pasting=b.owner.paste();expect(read).not.toHaveBeenCalled();image.resolve({id:5,data:new Uint8Array([1,2]),w:800,h:600});await Promise.all([copying,pasting]);
  expect(b.editor.state.doc.textContent).not.toContain('stale');expect(b.asset).toHaveBeenCalledWith(new Uint8Array([1,2]),800,600);expect(b.owner.records()[0].content_html).toContain('asset:81');
});
it('delayed paste stays at its invocation caret and preserves a later caret',async()=>{
  const clip=deferred<any>();window.desktop={readClipboard:vi.fn(()=>clip.promise)} as any;const {owner,editor}=setup();editor.commands.setTextSelection(3);const pending=owner.paste();editor.commands.setTextSelection(6);clip.resolve({text:'X',events:'',html:''});await pending;
  expect(editor.state.doc.textContent).toBe('abXcdef');expect(editor.state.selection.from).toBe(7);
});
it('pending paste maps its original position through unrelated typing',async()=>{
  const clip=deferred<any>();window.desktop={readClipboard:vi.fn(()=>clip.promise)} as any;const {owner,editor}=setup();editor.commands.setTextSelection(5);const pending=owner.paste();editor.commands.setTextSelection(1);editor.commands.insertContent('Q');clip.resolve({text:'X',events:'',html:''});await pending;
  expect(editor.state.doc.textContent).toBe('QabcdXef');expect(editor.state.selection.from).toBe(2);
});
it('paste refuses to overwrite a selected range edited while clipboard data was pending',async()=>{
  const clip=deferred<any>();window.desktop={readClipboard:vi.fn(()=>clip.promise)} as any;const {owner,editor,error}=setup();editor.commands.setTextSelection({from:2,to:4});const pending=owner.paste();editor.commands.insertContent('NEW');clip.resolve({text:'X',events:'',html:''});await pending;
  expect(editor.state.doc.textContent).toBe('aNEWdef');expect(error).toHaveBeenCalled();
});
it('cut removes its original selection even after the caret moved and undoes once',async()=>{
  const write=deferred<void>();window.desktop={copy:vi.fn(()=>write.promise)} as any;const {owner,editor}=setup();editor.commands.setTextSelection({from:2,to:4});const pending=owner.copy(false,true);editor.commands.setTextSelection(7);write.resolve();await pending;
  expect(editor.state.doc.textContent).toBe('adef');expect(editor.state.selection.from).toBe(5);editor.commands.undo();expect(editor.state.doc.textContent).toBe('abcdef');
});
it('delayed image import stays at its insertion point and always releases the bitmap',async()=>{
  const imported=deferred<number>(),bitmap={width:800,height:600,close:vi.fn()};vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue(bitmap));const {owner,editor,asset}=setup();asset.mockImplementation(()=>imported.promise);editor.commands.setTextSelection(3);const pending=owner.insertImage(new Uint8Array([1,2]));await vi.waitFor(()=>expect(asset).toHaveBeenCalled());editor.commands.setTextSelection(7);imported.resolve(81);await pending;
  const content=editor.state.doc.firstChild!.content.content;expect(content.map(n=>n.isText?n.text:n.type.name)).toEqual(['ab','image','cdef']);expect(editor.state.selection.from).toBe(8);expect(bitmap.close).toHaveBeenCalled();
});
it('consecutive pastes replace an all-selection once and then append in invocation order',async()=>{
  const first=deferred<any>(),read=vi.fn().mockImplementationOnce(()=>first.promise).mockResolvedValue({text:'second',events:'',html:''});window.desktop={readClipboard:read} as any;
  const {owner,editor}=setup();editor.commands.selectAll();const one=owner.paste(),two=owner.paste();expect(read).toHaveBeenCalledTimes(1);first.resolve({text:'first',events:'',html:''});await Promise.all([one,two]);expect(editor.state.doc.textContent).toBe('firstsecond');editor.commands.undo();expect(editor.state.doc.textContent).toBe('first');editor.commands.undo();expect(editor.state.doc.textContent).toBe('abcdef');
});
it('multiline plain text joins the existing paragraph edges without extra empty paragraphs',async()=>{
  window.desktop={readClipboard:vi.fn().mockResolvedValue({text:'one\r\n\r\ntwo',events:'',html:''})} as any;const {owner,editor}=setup();editor.commands.setTextSelection(3);await owner.paste();expect(owner.records()[0].content_text).toBe('abone\n\ntwocdef');expect(editor.state.doc.childCount).toBe(3);editor.commands.undo();expect(editor.state.doc.textContent).toBe('abcdef');
});
it('a failed copy aborts its already queued paste, and the next copy can retry',async()=>{
  const image=deferred<any>(),read=vi.fn().mockResolvedValue({text:'stale',events:'',html:''}),copy=vi.fn();window.desktop={asset:vi.fn(()=>image.promise),copy,readClipboard:read} as any;
  const a=setup('<p><img src="asset:5" width="80" height="60" /></p>'),b=setup();a.editor.commands.selectAll();const copying=a.owner.copy(),pasting=b.owner.paste();image.resolve(null);await Promise.all([copying,pasting]);expect(read).not.toHaveBeenCalled();expect(copy).not.toHaveBeenCalled();expect(b.editor.state.doc.textContent).toBe('abcdef');b.editor.commands.selectAll();await b.owner.copy();expect(copy).toHaveBeenCalledOnce();
});
it('a new copy already queued behind a failed image copy still replaces the clipboard',async()=>{
  const image=deferred<any>(),copy=vi.fn();window.desktop={asset:vi.fn(()=>image.promise),copy} as any;
  const a=setup('<p><img src="asset:5" width="80" height="60" /></p>'),b=setup();a.editor.commands.selectAll();b.editor.commands.selectAll();const first=a.owner.copy(),second=b.owner.copy();image.resolve(null);await Promise.all([first,second]);expect(copy).toHaveBeenCalledOnce();expect(copy.mock.calls[0][0].text).toBe('abcdef');
});
it('image storage failure releases decoded pixels and leaves the document unchanged',async()=>{
  const bitmap={width:800,height:600,close:vi.fn()};vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue(bitmap));const {owner,editor,asset,error}=setup();asset.mockRejectedValue(new Error('disk full'));await owner.insertImage(new Uint8Array([1]));expect(bitmap.close).toHaveBeenCalledOnce();expect(editor.state.doc.textContent).toBe('abcdef');expect(error).toHaveBeenCalled();
});
it('whole-event cut refuses to remove text changed while the original image was read',async()=>{
  const image=deferred<any>();window.desktop={asset:vi.fn(()=>image.promise),copy:vi.fn()} as any;const {owner,editor,error}=setup('<p>text<img src="asset:5" width="80" height="60" /></p>');editor.commands.setTextSelection(1);const pending=owner.copy(true,true);editor.commands.setTextSelection(3);editor.commands.insertContent('new');image.resolve({id:5,data:new Uint8Array([1]),w:800,h:600});await pending;expect(editor.state.doc.textContent).toBe('tenewxt');expect(error).toHaveBeenCalled();
});
it('an image file read captures the invocation caret before its bytes arrive',async()=>{
  const bytes=deferred<Uint8Array>();vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:80,height:60,close:vi.fn()}));const {owner,editor}=setup();editor.commands.setTextSelection(3);const pending=owner.insertImage(bytes.promise);editor.commands.setTextSelection(7);bytes.resolve(new Uint8Array([1]));await pending;expect(editor.state.doc.firstChild!.content.content.map(n=>n.isText?n.text:n.type.name)).toEqual(['ab','image','cdef']);
});
it('concurrent image imports retain invocation order even if later bytes arrive first',async()=>{
  const first=deferred<Uint8Array>();vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:80,height:60,close:vi.fn()}));const {owner,editor,asset}=setup();asset.mockImplementation(async(bytes:Uint8Array)=>100+bytes[0]);editor.commands.setTextSelection(3);
  const one=owner.insertImage(first.promise),two=owner.insertImage(new Uint8Array([2]));await new Promise(r=>setTimeout(r,20));first.resolve(new Uint8Array([1]));await Promise.all([one,two]);
  const ids:number[]=[];editor.state.doc.descendants(n=>{if(n.type.name==='image')ids.push(n.attrs.assetId);});expect(ids).toEqual([101,102]);editor.commands.undo();expect(owner.records()[0].content_html).toContain('asset:101');expect(owner.records()[0].content_html).not.toContain('asset:102');
});
it('clipboard completion waits for composition to end without replacing its DOM',async()=>{
  const clip=deferred<any>();window.desktop={readClipboard:vi.fn(()=>clip.promise)} as any;const {owner,editor}=setup();editor.commands.setTextSelection(3);const dom=editor.view.dom,pending=owner.paste();dom.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));clip.resolve({text:'X',html:'',events:''});await Promise.resolve();await Promise.resolve();expect(editor.state.doc.textContent).toBe('abcdef');dom.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));await pending;expect(editor.state.doc.textContent).toBe('abXcdef');expect(editor.view.dom).toBe(dom);
});
it('a multi-image batch replaces selected text once and undoes as one operation',async()=>{
  vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:80,height:60,close:vi.fn()}));const {owner,editor,asset}=setup();asset.mockImplementation(async(bytes:Uint8Array)=>100+bytes[0]);editor.commands.setTextSelection({from:2,to:4});await owner.insertImages([new Uint8Array([1]),new Uint8Array([2])]);expect(editor.state.doc.textContent).toBe('adef');expect(owner.records()[0].content_html).toMatch(/asset:101[\s\S]*asset:102/);editor.commands.undo();expect(editor.state.doc.textContent).toBe('abcdef');expect(owner.records()[0].content_html).not.toContain('<img');editor.commands.redo();expect(owner.records()[0].content_html).toMatch(/asset:101[\s\S]*asset:102/);
});
it('validates every image before storing anything, reports the file name and permits a retry',async()=>{
  const close=vi.fn();vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValueOnce({width:80,height:60,close}).mockRejectedValueOnce(new Error('bad image')).mockResolvedValue({width:80,height:60,close}));const {owner,editor,asset,error}=setup();const bad={name:'坏图.png',arrayBuffer:async()=>new Uint8Array([2]).buffer};await owner.insertImages([new Uint8Array([1]),bad]);expect(asset).not.toHaveBeenCalled();expect(editor.state.doc.textContent).toBe('abcdef');expect(error.mock.calls[0][0]).toContain('坏图.png');expect(close).toHaveBeenCalledOnce();expect(owner.importingImages).toBe(0);await owner.insertImage(new Uint8Array([3]));expect(asset).toHaveBeenCalledOnce();
});
it('reads files lazily in order and keeps the original width when the tab becomes hidden',async()=>{
  const first=deferred<ArrayBuffer>(),read=vi.fn(async()=>new Uint8Array([2]).buffer);vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:800,height:600,close:vi.fn()}));const {owner,editor}=setup();Object.defineProperty(editor.view.dom,'clientWidth',{configurable:true,value:600});editor.commands.setTextSelection(3);const pending=owner.insertImages([{name:'first.png',arrayBuffer:()=>first.promise},{name:'second.png',arrayBuffer:read}]);Object.defineProperty(editor.view.dom,'clientWidth',{configurable:true,value:0});editor.commands.setTextSelection(7);expect(read).not.toHaveBeenCalled();first.resolve(new Uint8Array([1]).buffer);await pending;const widths:number[]=[];editor.state.doc.descendants(n=>{if(n.type.name==='image')widths.push(n.attrs.width);});expect(widths).toEqual([432,432]);expect(editor.state.selection.from).toBe(9);
});
it('a later file read rejection is handled while queued, and does not insert a partial batch',async()=>{
  const first=deferred<Uint8Array>();vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:80,height:60,close:vi.fn()}));const {owner,editor,error}=setup();const one=owner.insertImage(first.promise),two=owner.insertImages([new Uint8Array([2]),Promise.reject(new Error('file read failed'))]);await new Promise(r=>setTimeout(r,10));first.resolve(new Uint8Array([1]));await Promise.all([one,two]);const nodes:any[]=[];editor.state.doc.descendants(n=>{if(n.type.name==='image')nodes.push(n);});expect(nodes).toHaveLength(1);expect(error).toHaveBeenCalled();expect(owner.importingImages).toBe(0);
});
it('a changed target aborts the complete batch before its assets are written',async()=>{
  const first=deferred<Uint8Array>();vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:80,height:60,close:vi.fn()}));const {owner,editor,asset,error}=setup();editor.commands.setTextSelection({from:2,to:4});const pending=owner.insertImages([first.promise,new Uint8Array([2])]);editor.commands.insertContent('NEW');first.resolve(new Uint8Array([1]));await pending;expect(asset).not.toHaveBeenCalled();expect(editor.state.doc.textContent).toBe('aNEWdef');expect(error).toHaveBeenCalled();
});
it('paste follows an earlier slow image import at the same caret, with separate undo steps',async()=>{
  const bytes=deferred<Uint8Array>();vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:80,height:60,close:vi.fn()}));window.desktop={readClipboard:vi.fn().mockResolvedValue({text:'X',events:'',html:''})} as any;
  const {owner,editor}=setup();editor.commands.setTextSelection(3);const importing=owner.insertImage(bytes.promise),pasting=owner.paste();bytes.resolve(new Uint8Array([1]));await Promise.all([importing,pasting]);
  expect(editor.state.doc.firstChild!.content.content.map(n=>n.isText?n.text:n.type.name)).toEqual(['ab','image','Xcdef']);editor.commands.undo();expect(editor.state.doc.textContent).toBe('abcdef');expect(owner.records()[0].content_html).toContain('<img');editor.commands.undo();expect(owner.records()[0].content_html).not.toContain('<img');
});
it('image import follows an earlier slow paste and replaces an all-selection only once',async()=>{
  const clip=deferred<any>();vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:80,height:60,close:vi.fn()}));window.desktop={readClipboard:vi.fn(()=>clip.promise)} as any;
  const {owner,editor}=setup();editor.commands.selectAll();const pasting=owner.paste(),importing=owner.insertImage(new Uint8Array([1]));await new Promise(r=>setTimeout(r,10));clip.resolve({text:'X',events:'',html:''});await Promise.all([pasting,importing]);
  expect(editor.state.doc.firstChild!.content.content.map(n=>n.isText?n.text:n.type.name)).toEqual(['X','image']);editor.commands.undo();expect(editor.state.doc.textContent).toBe('X');expect(owner.records()[0].content_html).not.toContain('<img');editor.commands.undo();expect(editor.state.doc.textContent).toBe('abcdef');
});
it('cut excludes a queued image inserted at the end of the copied text range',async()=>{
  const bytes=deferred<Uint8Array>(),copy=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:80,height:60,close:vi.fn()}));window.desktop={copy} as any;
  const {owner,editor,error}=setup();editor.commands.setTextSelection(4);const importing=owner.insertImage(bytes.promise);editor.commands.setTextSelection({from:2,to:4});const cutting=owner.copy(false,true);bytes.resolve(new Uint8Array([1]));await Promise.all([importing,cutting]);
  expect(copy.mock.calls[0][0].text).toBe('bc');expect(editor.state.doc.firstChild!.content.content.map(n=>n.isText?n.text:n.type.name)).toEqual(['a','image','def']);expect(error).not.toHaveBeenCalled();editor.commands.undo();expect(editor.state.doc.textContent).toBe('abcdef');expect(owner.records()[0].content_html).toContain('<img');
});
it('cut never deletes an earlier queued paste that replaced the copied selection',async()=>{
  const clip=deferred<any>(),copy=vi.fn().mockResolvedValue(undefined);window.desktop={readClipboard:vi.fn(()=>clip.promise),copy} as any;
  const {owner,editor,error}=setup();editor.commands.setTextSelection({from:2,to:4});const pasting=owner.paste(),cutting=owner.copy(false,true);clip.resolve({text:'NEW',events:'',html:''});await Promise.all([pasting,cutting]);expect(copy.mock.calls[0][0].text).toBe('bc');expect(editor.state.doc.textContent).toBe('aNEWdef');expect(error).toHaveBeenCalled();
});
it('a failed image import releases later paste and the document idle barrier',async()=>{
  const bytes=deferred<Uint8Array>();vi.stubGlobal('createImageBitmap',vi.fn().mockRejectedValue(new Error('bad image')));window.desktop={readClipboard:vi.fn().mockResolvedValue({text:'X',events:'',html:''})} as any;
  const {owner,editor,error}=setup();editor.commands.setTextSelection(3);const importing=owner.insertImage(bytes.promise),pasting=owner.paste(),idle=owner.whenIdle();bytes.resolve(new Uint8Array([1]));await Promise.all([importing,pasting,idle]);expect(editor.state.doc.textContent).toBe('abXcdef');expect(error).toHaveBeenCalledOnce();expect(owner.importingImages).toBe(0);
});
it('slow images do not block unrelated documents and interleaved clipboard queues drain without cycles',async()=>{
  const bytes=deferred<Uint8Array>();vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:80,height:60,close:vi.fn()}));let packet:any={text:'X',events:'',html:''};window.desktop={readClipboard:vi.fn(async()=>packet),copy:vi.fn(async data=>{packet=data;})} as any;
  const a=setup(),b=setup();a.editor.commands.setTextSelection(3);const importing=a.owner.insertImage(bytes.promise);b.editor.commands.setTextSelection(1);await b.owner.paste();expect(b.editor.state.doc.textContent).toBe('Xabcdef');
  a.editor.commands.setTextSelection({from:4,to:6});const copying=a.owner.copy(),pasteB=b.owner.paste(),imageB=b.owner.insertImage(new Uint8Array([2])),pasteA=a.owner.paste();bytes.resolve(new Uint8Array([1]));await Promise.all([importing,copying,pasteB,imageB,pasteA,a.owner.whenIdle(),b.owner.whenIdle()]);let content='';b.editor.state.doc.descendants(n=>{if(n.isText)content+=n.text;else if(n.type.name==='image')content+='[image]';});expect(content).toBe('Xde[image]abcdef');expect(a.editor.state.doc.textContent).toBe('abcdef');
});
it('row cut refuses to remove new image content outside the copied text range',async()=>{
  const bytes=deferred<Uint8Array>(),copy=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:80,height:60,close:vi.fn()}));window.desktop={copy} as any;
  const {owner,editor,error}=setup();editor.commands.setTextSelection(7);const importing=owner.insertImage(bytes.promise);owner.selectedRanges=[{from:1,to:7,row:true}];editor.commands.setTextSelection(1);const cutting=owner.copy(false,true);owner.selectedRanges=[];editor.commands.setTextSelection(4);bytes.resolve(new Uint8Array([1]));await Promise.all([importing,cutting]);
  expect(copy.mock.calls[0][0].text).toBe('abcdef');expect(editor.state.doc.textContent).toBe('abcdef');expect(owner.records()[0].content_html).toContain('<img');expect(error).toHaveBeenCalled();expect(editor.state.selection.from).toBe(4);expect(owner.selectedRanges).toHaveLength(0);
});
