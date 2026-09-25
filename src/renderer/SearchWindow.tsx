import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

/** The panel shares React state with the editor, but owns a real desktop window. */
export function SearchWindow({children,onClose,onReady,theme,origin}:{children:React.ReactNode;onClose:()=>void;onReady:()=>void;theme:string;origin:{x:number;y:number}}){
  const [host,setHost]=useState<HTMLElement|null>(null);
  const latest=useRef({onClose,onReady});latest.current={onClose,onReady};
  useLayoutEffect(()=>{
    const child=window.open('about:blank','todoline-search',`popup,width=620,height=96,left=${Math.round(window.screenX+origin.x)},top=${Math.round(window.screenY+origin.y)}`);
    if(!child){latest.current.onClose();return;}
    child.document.title='TodoLine 搜索';
    child.document.documentElement.lang='zh-CN';
    const base=child.document.createElement('base');base.href=document.baseURI;child.document.head.append(base);
    for(const style of document.querySelectorAll('link[rel=stylesheet],style'))child.document.head.append(style.cloneNode(true));
    const style=child.document.createElement('style');style.textContent=`
      html,body,#search-root{margin:0;width:100%;height:100%;overflow:hidden;background:var(--surface)}
      .search-bar{position:relative;inset:auto;width:100%;height:100%;box-sizing:border-box;border-radius:0;box-shadow:none;opacity:1;-webkit-app-region:drag}
      .search-bar input,.search-bar button,.search-bar label,.search-bar select{-webkit-app-region:no-drag}
      .search-options{flex-wrap:nowrap}.search-grip{cursor:move}
      html[data-inactive=true] .search-bar{opacity:.8}
    `;child.document.head.append(style);
    const container=child.document.createElement('div');container.id='search-root';child.document.body.append(container);setHost(container);
    let disposed=false;
    const closed=()=>{if(!disposed)latest.current.onClose();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.isComposing){event.preventDefault();latest.current.onClose();}};
    const focus=()=>{child.document.documentElement.dataset.inactive='false';},blur=()=>{child.document.documentElement.dataset.inactive='true';};
    child.addEventListener('focus',focus);child.addEventListener('blur',blur);
    child.addEventListener('beforeunload',closed);child.addEventListener('keydown',key);
    const offFocus=window.desktop.onSearchFocus(value=>{if(!child.closed)child.document.documentElement.dataset.inactive=String(!value);});
    return()=>{disposed=true;offFocus();child.removeEventListener('beforeunload',closed);child.removeEventListener('keydown',key);child.removeEventListener('focus',focus);child.removeEventListener('blur',blur);if(!child.closed)child.close();};
  },[]);
  useEffect(()=>{if(host)host.ownerDocument.documentElement.dataset.theme=theme;},[host,theme]);
  useEffect(()=>{if(host){void window.desktop.showSearch().then(()=>latest.current.onReady());}},[host]);
  return host?createPortal(children,host):null;
}
