/** A rolling record of the input events that can end a column selection. Input methods and
 *  Windows versions differ in what they send on focus, click and Alt, so a trace exported on the
 *  machine that misbehaves shows what actually arrived. Typed characters are never recorded. */
type Entry={t:number;type:string;detail:string};
export const INPUT_TRACE_LIMIT=400;
const entries:Entry[]=[];
let installed=false;

export function traceInput(type:string,detail=''){
  entries.push({t:performance.now(),type,detail});
  if(entries.length>INPUT_TRACE_LIMIT)entries.splice(0,entries.length-INPUT_TRACE_LIMIT);
}

const describe=(target:EventTarget|null)=>{
  if(!(target instanceof Element))return target===window?'window':target instanceof Document?'document':'';
  const classes=typeof target.className==='string'?target.className.trim().split(/\s+/).filter(Boolean).slice(0,2):[];
  return target.tagName.toLowerCase()+classes.map(c=>'.'+c).join('');
};
const mods=(e:MouseEvent|KeyboardEvent)=>[e.altKey&&'alt',e.ctrlKey&&'ctrl',e.shiftKey&&'shift',e.metaKey&&'meta'].filter(Boolean).join('+')||'-';
/** Printable keys are reduced to "char" so a trace never spells out what was typed. */
export function describeKey(e:KeyboardEvent){
  const printable=e.key.length===1;
  return `key=${printable?'char':e.key} code=${printable?'-':e.code} keyCode=${printable?'-':e.keyCode} mods=${mods(e)}${e.repeat?' repeat':''}${e.isComposing?' composing':''}`;
}
const length=(data:string|null)=>data===null?'null':`${data.length}ch`;

export function installInputTrace(target:Window=window){
  if(installed)return;installed=true;
  const options={capture:true,passive:true};
  for(const type of ['keydown','keyup'] as const)target.addEventListener(type,e=>traceInput(type,describeKey(e)),options);
  for(const type of ['compositionstart','compositionupdate','compositionend'] as const)target.addEventListener(type,e=>traceInput(type,`data=${length(e.data)} target=${describe(e.target)}`),options);
  for(const type of ['mousedown','mouseup'] as const)target.addEventListener(type,e=>traceInput(type,`button=${e.button} detail=${e.detail} mods=${mods(e)} target=${describe(e.target)}`),options);
  target.addEventListener('beforeinput',e=>traceInput('beforeinput',`inputType=${e.inputType} data=${length(e.data)}${e.isComposing?' composing':''}`),options);
  target.addEventListener('focusin',e=>traceInput('focusin',describe(e.target)),options);
  target.addEventListener('focusout',e=>traceInput('focusout',describe(e.target)),options);
  target.addEventListener('focus',e=>{if(e.target===target)traceInput('window-focus');},options);
  target.addEventListener('blur',e=>{if(e.target===target)traceInput('window-blur');},options);
  target.document.addEventListener('selectionchange',()=>{
    const s=target.document.getSelection();
    traceInput('selectionchange',s?`${describe(s.anchorNode?.parentElement??null)}@${s.anchorOffset}${s.isCollapsed?' collapsed':` to ${describe(s.focusNode?.parentElement??null)}@${s.focusOffset}`}`:'none');
  },{passive:true});
}

export function inputTraceReport(){
  const start=entries[0]?.t??0;
  const lines=entries.map(e=>`${(e.t-start).toFixed(1).padStart(10)}ms  ${e.type.padEnd(18)} ${e.detail}`);
  return [`userAgent: ${navigator.userAgent}`,`devicePixelRatio: ${window.devicePixelRatio}`,`language: ${navigator.language}`,`events: ${entries.length} (last ${INPUT_TRACE_LIMIT} kept)`,'',...lines].join('\n');
}
export function clearInputTrace(){entries.length=0;}
