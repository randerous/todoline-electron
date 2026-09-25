import {afterEach,expect,it,vi} from 'vitest';
import {Schema} from '@tiptap/pm/model';
import {eventSpans,visibleEventRange,observeVisibleEvents} from '../src/renderer/visible-events';
const schema=new Schema({nodes:{doc:{content:'block*',attrs:{head:{default:null}}},text:{group:'inline'},paragraph:{group:'block',content:'inline*'},divider:{group:'block',atom:true,attrs:{id:{default:0}}}}});
it('indexes the initial event without a divider and consecutive empty events',()=>{
  const p=schema.nodes.paragraph.create(null,schema.text('abc')),d=(id:number)=>schema.nodes.divider.create({id});
  const doc=schema.nodes.doc.create({head:{id:11}},[p,p,d(12),d(13),p]);
  expect(eventSpans(doc,99)).toEqual([{id:11,start:0,last:5},{id:12,start:10,last:10},{id:13,start:11,last:12}]);
  expect(eventSpans(schema.nodes.doc.create(null,[d(14),p]),99)).toEqual([{id:14,start:0,last:1}]);
});
it.each([
  {top:0,bottom:300,result:[0,1]},
  {top:800,bottom:1200,result:[0,3]},
  {top:1000,bottom:1100,result:[1,2]},
  {top:1300,bottom:1500,result:[0,0]},
  {top:-100,bottom:0,result:[0,0]},
])('finds visible event spans for viewport $top..$bottom',({top,bottom,result})=>{
  const starts=[0,1000,1100,1200];expect(visibleEventRange(starts.length,i=>starts[i],1300,top,bottom)).toEqual(result);
});
it('uses logarithmic layout reads even in a million-event document',()=>{
  let reads=0;const count=1000000;
  expect(visibleEventRange(count,i=>{reads++;return i*100;},count*100,95000010,95000410)).toEqual([950000,950005]);
  expect(reads).toBeLessThan(30);
});
it('agrees with overlap tests for varied viewport heights and event lengths',()=>{
  const starts=Array.from({length:200},(_,i)=>i*i+10),lastBottom=starts.at(-1)!+100;
  for(let top=0;top<lastBottom+200;top+=137){
    const bottom=top+511,expected=starts.map((start,i)=>({start,end:starts[i+1]??lastBottom,i})).filter(r=>r.start<bottom&&r.end>top).map(r=>r.i);
    const [first,end]=visibleEventRange(starts.length,i=>starts[i],lastBottom,top,bottom);
    expect(Array.from({length:end-first},(_,i)=>first+i)).toEqual(expected);
  }
});

afterEach(()=>{vi.unstubAllGlobals();});
it('reuses DOM references instead of resolving editor positions again on every scroll frame',()=>{
 const scroller=document.createElement('div'),dom=document.createElement('div');scroller.className='document-scroller';scroller.append(dom);document.body.append(scroller);
 dom.innerHTML='<p>abc</p><div class="event-divider" data-id="2"></div><p>abc</p>';
 Object.defineProperty(scroller,'clientHeight',{value:400});scroller.getBoundingClientRect=()=>new DOMRect(0,0,800,400);
 let offset=0;const elements=Array.from(dom.children);elements.forEach((el,i)=>el.getBoundingClientRect=()=>new DOMRect(0,[0,1000,1040][i]-offset,800,[1000,40,40][i]));
 const p=schema.nodes.paragraph.create(null,schema.text('abc')),doc=schema.nodes.doc.create({head:{id:1}},[p,schema.nodes.divider.create({id:2}),p]);
 const nodeDOM=vi.fn((pos:number)=>elements[pos===0?0:pos===5?1:2]);
 const callbacks=new Map<string,()=>void>(),frameCallbacks:(()=>void)[]=[];
 vi.stubGlobal('requestAnimationFrame',(callback:()=>void)=>{frameCallbacks.push(callback);return frameCallbacks.length;});vi.stubGlobal('cancelAnimationFrame',()=>{});
 vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
 const owner={editor:{view:{dom,state:{doc},nodeDOM},on:(name:string,callback:()=>void)=>callbacks.set(name,callback),off:(name:string)=>callbacks.delete(name)},codec:{head:{id:1},resolveId:(id:number)=>id}};
 const visible=vi.fn(),observer=observeVisibleEvents(owner as any,visible);
 frameCallbacks.shift()!();expect(visible).toHaveBeenLastCalledWith([1]);expect(nodeDOM).toHaveBeenCalledTimes(2);
 nodeDOM.mockClear();offset=900;observer.refresh();observer.refresh();expect(frameCallbacks).toHaveLength(1);frameCallbacks.shift()!();expect(visible).toHaveBeenLastCalledWith([1,2]);expect(nodeDOM).not.toHaveBeenCalled();
 visible.mockClear();observer.refresh();frameCallbacks.shift()!();expect(visible).not.toHaveBeenCalled();
 observer.destroy();expect(callbacks.size).toBe(0);scroller.remove();
});
