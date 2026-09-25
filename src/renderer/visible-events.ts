import type {Node as PMNode} from '@tiptap/pm/model';
import type {TodoEditor} from './editor';

export interface EventSpan {id:number;start:number;last:number}
/** Cache positions only when the document changes; never walk its nodes on scroll. */
export function eventSpans(doc:PMNode,headId:number):EventSpan[]{
  const spans:EventSpan[]=[];let current:EventSpan|undefined;
  doc.forEach((node,pos)=>{
    if(node.type.name==='divider'||!current){
      current={id:node.type.name==='divider'?node.attrs.id:(doc.attrs.head?.id??headId),start:pos,last:pos};spans.push(current);
    }else current.last=pos;
  });return spans;
}

/** Event ranges extend to the next divider, including an event whose divider is above view. */
export function visibleEventRange(count:number,topAt:(index:number)=>number,lastBottom:number,top:number,bottom:number):[number,number]{
  if(!count||bottom<=top||lastBottom<=top||topAt(0)>=bottom)return [0,0];
  let low=0,high=count;
  while(low<high){const mid=(low+high)>>>1;if(topAt(mid)<=top)low=mid+1;else high=mid;}
  const first=Math.max(0,low-1);let end=first+1;
  while(end<count&&topAt(end)<bottom)end++;
  return [first,end];
}

export function observeVisibleEvents(owner:TodoEditor,onVisible:(ids:number[])=>void){
  const editor=owner.editor,view=editor.view,scroller=view.dom.closest<HTMLElement>('.document-scroller');
  if(!scroller)return {refresh:()=>{},destroy:()=>{}};
  let spans:EventSpan[]=[],starts:Element[]=[],lastNode:Element|null=null,frame=0,lastIds:number[]=[];
  const rebuild=()=>{
    spans=eventSpans(view.state.doc,owner.codec.head.id);
    starts=Array.from(view.dom.querySelectorAll<HTMLElement>(':scope > .event-divider'));
    if(spans.length&&view.state.doc.firstChild?.type.name!=='divider'){
      const first=view.nodeDOM(0);if(first instanceof Element)starts.unshift(first);
    }
    const last=spans.length?view.nodeDOM(spans[spans.length-1].last):null;lastNode=last instanceof Element?last:null;
  };
  // Cache actual DOM references too: nodeDOM(position) itself can walk the editor's
  // child descriptions, so repeatedly resolving positions would defeat binary search.
  rebuild();
  const paint=()=>{
    frame=0;if(!view.dom.isConnected||!scroller.clientHeight)return;
    const viewport=scroller.getBoundingClientRect(),cache=new Map<number,number>();
    const topAt=(index:number)=>{let value=cache.get(index);if(value===undefined){value=starts[index]?.getBoundingClientRect().top??Infinity;cache.set(index,value);}return value;};
    const lastBottom=lastNode?.getBoundingClientRect().bottom??0;
    const [first,end]=visibleEventRange(spans.length,topAt,lastBottom,viewport.top,viewport.bottom);
    const ids=spans.slice(first,end).map(span=>owner.codec.resolveId(span.id));
    if(ids.length!==lastIds.length||ids.some((id,i)=>id!==lastIds[i])){lastIds=ids;onVisible(ids);}
  };
  const refresh=()=>{if(!frame)frame=requestAnimationFrame(paint);};
  const changed=()=>{rebuild();refresh();};
  editor.on('update',changed);scroller.addEventListener('scroll',refresh,{passive:true});view.dom.addEventListener('load',refresh,true);
  const resize=new ResizeObserver(refresh);resize.observe(scroller);resize.observe(view.dom);refresh();
  return {refresh,destroy:()=>{cancelAnimationFrame(frame);resize.disconnect();editor.off('update',changed);scroller.removeEventListener('scroll',refresh);view.dom.removeEventListener('load',refresh,true);}};
}
