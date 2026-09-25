import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Native tooltips look nothing like the rest of the app, so titles are borrowed
 * while the pointer rests on an element and handed straight back afterwards.
 * The bubble is measured before it is shown so it always opens where there is room.
 */
export function Tooltip(){
  const [tip,setTip]=useState<{text:string;left:number;top:number;right:number;bottom:number}|null>(null);
  const [place,setPlace]=useState<{left:number;top:number}|null>(null);
  const bubble=useRef<HTMLDivElement>(null);
  const held=useRef<{element:HTMLElement;text:string}|null>(null);
  useLayoutEffect(()=>{
    const node=bubble.current;
    if(!tip||!node){setPlace(null);return;}
    const size=node.getBoundingClientRect(),edge=8;
    const left=Math.max(edge,Math.min(tip.left+(tip.right-tip.left)/2-size.width/2,innerWidth-size.width-edge));
    const below=tip.bottom+edge,above=tip.top-size.height-edge;
    setPlace({left,top:below+size.height+edge<=innerHeight||above<edge?below:above});
  },[tip]);
  useEffect(()=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const restore=()=>{
      const holder=held.current;held.current=null;
      if(holder&&!holder.element.getAttribute('title'))holder.element.setAttribute('title',holder.text);
    };
    const hide=()=>{clearTimeout(timer);restore();setTip(null);setPlace(null);};
    const show=(element:HTMLElement,text:string)=>{
      const box=element.getBoundingClientRect();
      if(!box.width&&!box.height)return;
      element.removeAttribute('title');held.current={element,text};
      setTip({text,left:box.left,top:box.top,right:box.right,bottom:box.bottom});
    };
    const over=(event:PointerEvent)=>{
      const target=event.target instanceof Element?event.target.closest<HTMLElement>('[title]'):null;
      if(target&&target===held.current?.element)return;
      hide();
      const text=target?.getAttribute('title')?.trim();
      if(!target||!text)return;
      timer=setTimeout(()=>show(target,text),420);
    };
    const events:[string,EventListener][]=[['pointerover',over as EventListener],['pointerdown',hide],['wheel',hide],['keydown',hide]];
    for(const [name,handler] of events)document.addEventListener(name,handler,true);
    addEventListener('blur',hide);
    return()=>{hide();for(const [name,handler] of events)document.removeEventListener(name,handler,true);removeEventListener('blur',hide);};
  },[]);
  if(!tip)return null;
  return <div className="tooltip" role="tooltip" ref={bubble} style={place?{left:place.left,top:place.top}:{left:0,top:0,visibility:'hidden'}}>{tip.text}</div>;
}
