import React,{useEffect,useRef,useState} from 'react';
import {documentFileName} from '../shared/file-name';
import {friendlyError} from './errors';
export function TabRename({name,onSubmit,onCancel}:{name:string;onSubmit:(name:string)=>Promise<void>;onCancel:(focus?:boolean)=>void}){
  const extension=/[^.]\.([^.]+)$/.exec(name)?.[1]??'';
  const [value,setValue]=useState(name),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const input=useRef<HTMLInputElement>(null),pending=useRef(false);
  useEffect(()=>{input.current?.focus();input.current?.setSelectionRange(0,extension?name.length-extension.length-1:name.length);},[]);
  useEffect(()=>{if(!busy&&error)input.current?.focus();},[busy,error]);
  const submit=async()=>{
    if(pending.current)return;
    try{
      const file=documentFileName(value,'');pending.current=true;setBusy(true);setError('');await onSubmit(file);
    }catch(e){setError(friendlyError(e));}
    finally{pending.current=false;setBusy(false);}
  };
  return <div className={'tab-rename '+(error?'invalid':'')} aria-busy={busy}>
    <input ref={input} aria-label="新文件名" aria-invalid={!!error} aria-describedby={error?'tab-rename-error':undefined} title={error||'回车确认 · Esc 或失焦取消'} disabled={busy} value={value} onChange={e=>{setValue(e.target.value);setError('');}} onBlur={()=>{if(!pending.current)onCancel();}} onKeyDown={e=>{
      e.stopPropagation();if(e.nativeEvent.isComposing||e.keyCode===229)return;
      if(e.key==='Enter'){e.preventDefault();void submit();}else if(e.key==='Escape'){e.preventDefault();onCancel(true);}
    }}/>
    {error&&<span id="tab-rename-error" className="tab-rename-error" role="alert">{error}</span>}
  </div>;
}
