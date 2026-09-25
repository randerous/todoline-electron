import {useEffect,useRef,type RefObject} from 'react';
/** Pointer dragging keeps the editor DOM stationary; only the tab order commits on drop. */
export function useTabReorder(ref:RefObject<HTMLDivElement|null>,enabled:boolean,onMove:(source:number,before:number|null)=>void){
  const current=useRef({enabled,onMove});current.current={enabled,onMove};
  useEffect(()=>{
    const root=ref.current;if(!root)return;
    let drag:{key:number;pointer:number;x:number;y:number;startX:number;startY:number;active:boolean;before:number|null;button:HTMLElement}|undefined;
    let frame=0,suppress=false;
    const items=()=>Array.from(root.querySelectorAll<HTMLElement>('[data-tab-key]'));
    const clearMarks=()=>{delete root.dataset.dropping;for(const el of items()){delete el.dataset.drop;delete el.dataset.dragging;}};
    const locate=()=>{
      if(!drag)return;clearMarks();
      const bounds=root.getBoundingClientRect();
      if(drag.y<bounds.top-20||drag.y>bounds.bottom+20){drag.before=null;return;}
      const other=items().filter(el=>Number(el.dataset.tabKey)!==drag!.key);
      const next=other.find(el=>{const r=el.getBoundingClientRect();return drag!.x<r.left+r.width/2;});
      drag.before=next?Number(next.dataset.tabKey):null;
      if(next)next.dataset.drop='before';else if(other.length)other[other.length-1].dataset.drop='after';
      if(other.length){
        const edge=next?next.getBoundingClientRect().left:other[other.length-1].getBoundingClientRect().right;
        root.dataset.dropping='true';
        root.style.setProperty('--drop-x',`${Math.max(bounds.left+1,Math.min(bounds.right-3,edge))}px`);
        root.style.setProperty('--drop-y',`${bounds.top+5}px`);
        root.style.setProperty('--drop-height',`${Math.max(8,root.clientHeight-10)}px`);
      }
      items().find(el=>Number(el.dataset.tabKey)===drag!.key)?.setAttribute('data-dragging','true');
    };
    const scroll=()=>{
      if(!drag?.active)return;const b=root.getBoundingClientRect();
      if(drag.y>=b.top-20&&drag.y<=b.bottom+20){const speed=drag.x<b.left+28?-12:drag.x>b.right-28?12:0;root.scrollLeft+=speed;locate();}
      frame=requestAnimationFrame(scroll);
    };
    const finish=(commit:boolean)=>{
      if(!drag)return;const ended=drag;drag=undefined;cancelAnimationFrame(frame);clearMarks();
      if(ended.button.hasPointerCapture(ended.pointer))ended.button.releasePointerCapture(ended.pointer);
      if(ended.active)suppress=true;
      const b=root.getBoundingClientRect();
      if(commit&&ended.active&&current.current.enabled&&ended.y>=b.top-20&&ended.y<=b.bottom+20)current.current.onMove(ended.key,ended.before);
    };
    const down=(e:PointerEvent)=>{
      suppress=false;
      if(!current.current.enabled||e.button!==0)return;
      const button=(e.target as Element).closest<HTMLElement>('.tab-name'),tab=button?.closest<HTMLElement>('[data-tab-key]');
      if(!button||!tab||!root.contains(tab))return;
      e.preventDefault(); // Keep typing focus and the DOM selection in the active editor.
      drag={key:Number(tab.dataset.tabKey),pointer:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,active:false,before:null,button};
    };
    const move=(e:PointerEvent)=>{
      if(!drag||e.pointerId!==drag.pointer)return;
      if(!current.current.enabled){finish(false);return;}
      drag.x=e.clientX;drag.y=e.clientY;
      if(!drag.active&&Math.hypot(drag.x-drag.startX,drag.y-drag.startY)>=6){drag.active=true;drag.button.setPointerCapture(drag.pointer);frame=requestAnimationFrame(scroll);}
      if(drag.active){e.preventDefault();locate();}
    };
    const up=(e:PointerEvent)=>{if(drag?.pointer===e.pointerId)finish(true);};
    const cancel=()=>finish(false);
    const escape=(e:KeyboardEvent)=>{if(drag?.active&&e.key==='Escape'){e.preventDefault();e.stopPropagation();finish(false);}};
    const click=(e:MouseEvent)=>{if(suppress&&e.detail>0){e.preventDefault();e.stopPropagation();suppress=false;}};
    const nativeDrag=(e:DragEvent)=>{if(drag)e.preventDefault();};
    root.addEventListener('pointerdown',down);root.addEventListener('click',click,true);root.addEventListener('dragstart',nativeDrag);
    window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);window.addEventListener('keydown',escape,true);
    return()=>{finish(false);root.removeEventListener('pointerdown',down);root.removeEventListener('click',click,true);root.removeEventListener('dragstart',nativeDrag);window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);window.removeEventListener('keydown',escape,true);};
  },[ref]);
}
