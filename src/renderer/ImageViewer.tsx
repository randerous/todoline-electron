import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import './image-viewer.css';

export default function ImageViewer({source,onClose}:{source:string;onClose:()=>void}){
  const [size,setSize]=useState({width:0,height:0}),[scale,setScale]=useState(1),[error,setError]=useState(''),[copied,setCopied]=useState(false),[busy,setBusy]=useState(false);
  const viewport=useRef<HTMLDivElement>(null),dialog=useRef<HTMLDivElement>(null),bytes=useRef<Uint8Array|undefined>(undefined),image=useRef<HTMLImageElement>(null);
  const [display,setDisplay]=useState(source);
  const [ready,setReady]=useState(false);
  const pendingCenter=useRef<{x:number;y:number}|null>(null);
  const fitted=useRef(true);
  const fit=(width=size.width,height=size.height)=>{const el=viewport.current;if(el&&width&&height){fitted.current=true;pendingCenter.current=null;el.scrollLeft=el.scrollTop=0;setScale(Math.max(.001,Math.min((el.clientWidth-48)/width,(el.clientHeight-48)/height)));}};
  useEffect(()=>{const el=viewport.current;if(!el||!size.width)return;const observer=new ResizeObserver(()=>{if(fitted.current)fit();});observer.observe(el);return()=>observer.disconnect();},[size.width,size.height]);
  useEffect(()=>{
    let alive=true;const previous=document.activeElement as HTMLElement|null;dialog.current?.focus();
    void(async()=>{
      const url=new URL(source);
      if(url.protocol==='tde-asset:'){
        const [handle,id]=url.pathname.slice(1).split('/');const asset=await window.desktop.asset(handle,Number(id));
        if(!asset)throw new Error('原图不存在');if(alive)bytes.current=asset.data;
      }else{
        let data=source;
        if(url.protocol==='md-asset:'){const [handle,...parts]=url.pathname.slice(1).split('/');data=await window.desktop.markdown.readAsset(handle,decodeURIComponent(parts.join('/')));}
        if(!/^data:image\/[\w+.-]+;base64,/i.test(data))throw new Error('无法读取原图');
        const decoded=Uint8Array.from(atob(data.slice(data.indexOf(',')+1)),c=>c.charCodeAt(0));
        if(alive){bytes.current=decoded;setDisplay(data);}
      }
    })().then(()=>{if(alive)setReady(true);}).catch(e=>{if(alive)setError(String(e));});
    return()=>{alive=false;previous?.isConnected&&previous.focus({preventScroll:true});};
  },[source]);
  const zoom=(next:number)=>{
    const el=viewport.current;if(!el||!size.width)return;
    fitted.current=false;
    pendingCenter.current={x:(el.scrollLeft+el.clientWidth/2)/Math.max(el.scrollWidth,1),y:(el.scrollTop+el.clientHeight/2)/Math.max(el.scrollHeight,1)};
    setScale(Math.min(16,Math.max(.05,next)));
  };
  useLayoutEffect(()=>{const el=viewport.current,p=pendingCenter.current;if(el&&p){el.scrollLeft=p.x*el.scrollWidth-el.clientWidth/2;el.scrollTop=p.y*el.scrollHeight-el.clientHeight/2;pendingCenter.current=null;}},[scale]);
  useEffect(()=>{const el=viewport.current;if(!el)return;const wheel=(e:WheelEvent)=>{e.preventDefault();zoom(scale*(e.deltaY<0?1.15:1/1.15));};el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);},[scale,size.width]);
  const copy=async()=>{if(!bytes.current){setError('原图尚未加载，请稍后重试');return;}setBusy(true);setError('');try{await window.desktop.copy({text:'[图片]',image:bytes.current});setCopied(true);}catch(e){setError(String(e));}finally{setBusy(false);}};
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();onClose();}
      else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='c'){e.preventDefault();e.stopImmediatePropagation();void copy();}
      else if(e.key==='Tab'){
        const buttons=Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),at=buttons.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();buttons[(at+(e.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();
      }
    };window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);
  });
  const drag=useRef<{x:number;y:number;left:number;top:number}|null>(null);
  return <div className="image-viewer-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label="原图查看器" tabIndex={-1} ref={dialog}>
      <header><strong>原图</strong><span>{size.width?`${size.width} × ${size.height}`:'加载中…'}</span><div className="image-viewer-spacer"/>
        <button aria-label="缩小原图" onClick={()=>zoom(scale/1.25)} disabled={!size.width}>−</button><output aria-label="图片缩放比例">{Math.round(scale*100)}%</output><button aria-label="放大原图" onClick={()=>zoom(scale*1.25)} disabled={!size.width}>+</button>
        <button onClick={()=>zoom(1)} disabled={!size.width}>原始大小</button><button onClick={()=>fit()} disabled={!size.width}>适应窗口</button><button onClick={()=>void copy()} disabled={busy||!ready}>{copied?'已复制':'复制原图'}</button><button aria-label="关闭原图" onClick={onClose}>×</button>
      </header>
      <div className="image-viewer-canvas" ref={viewport}
        onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,left:e.currentTarget.scrollLeft,top:e.currentTarget.scrollTop};}}
        onPointerMove={e=>{const d=drag.current;if(d){e.currentTarget.scrollLeft=d.left+d.x-e.clientX;e.currentTarget.scrollTop=d.top+d.y-e.clientY;}}}
        onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{drag.current=null;}}>
        <div className="image-viewer-stage"><img ref={image} src={display} alt="原图" draggable={false} style={size.width?{width:size.width*scale,height:size.height*scale}:undefined} onLoad={e=>{const img=e.currentTarget;setSize({width:img.naturalWidth,height:img.naturalHeight});if(!size.width)fit(img.naturalWidth,img.naturalHeight);}} onError={()=>setError('原图加载失败')}/></div>
      </div>
      {error&&<footer><span role="alert">{error}</span></footer>}
    </div>
  </div>;
}
