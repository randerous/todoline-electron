import {multiTextSelection,plainCanvasCaret,selectedRangesText} from './multi-selection';
import {Editor,Extension,Node,type JSONContent} from '@tiptap/core';
import {Plugin,TextSelection} from '@tiptap/pm/state';
import {Decoration,DecorationSet} from '@tiptap/pm/view';
import {history,undo,redo} from '@tiptap/pm/history';
import {baseKeymap,splitBlock} from '@tiptap/pm/commands';
import {Fragment,Slice} from '@tiptap/pm/model';
import type {TextFileSnapshot} from '../shared/native-document';
import {searchMatches,searchPattern,type SearchOptions} from '../shared/search';
import {AsyncTarget,orderedClipboard} from './async-editing';
import './plain-text-editor.css';

const lines=(text:string)=>text.split(/\r\n|\r|\n/);
const paragraphs=(text:string):JSONContent[]=>lines(text).map(text=>({type:'paragraph',content:text?[{type:'text',text}]:[]}));
export function searchPlainText(source:string,query:string,options:SearchOptions={}){
 const pattern=searchPattern(query,options),hits:{id:number;text:string}[]=[];if(!pattern)return hits;
 let pos=1;for(const text of lines(source)){for(const [offset] of searchMatches(text,pattern))hits.push({id:pos+offset,text});pos+=text.length+2;}return hits;
}

/** A text-only schema: no Markdown parsing, input rules, rich marks or images. */
export class PlainTextEditor {
 readonly editor:Editor;
 private matcher:RegExp|null=null;
 private originalJSON:string;
 private originalSource:string;
 private pending=new Set<Promise<unknown>>();
 private targets=new Set<AsyncTarget>();
 private applying=false;
 constructor(element:HTMLElement,private snapshot:TextFileSnapshot,private bridge:{change():void;selection():void;error(message:string):void}){
  this.originalSource=snapshot.source;
  const owner=this;
  this.editor=new Editor({element,editable:!snapshot.readOnly,content:{type:'doc',content:paragraphs(snapshot.source)},extensions:[
   Node.create({name:'doc',topNode:true,content:'paragraph+'}),
   Node.create({name:'paragraph',group:'block',content:'text*',code:true,whitespace:'pre',parseHTML:()=>[{tag:'p'}],renderHTML:()=>['p',0]}),
   Node.create({name:'text',group:'inline'}),
   Extension.create({name:'plainText',addCommands(){return {undo:()=>({state,dispatch})=>undo(state,dispatch),redo:()=>({state,dispatch})=>redo(state,dispatch)};},
    addKeyboardShortcuts(){return {...Object.fromEntries(Object.entries(baseKeymap).map(([key,command])=>[key,()=>command(this.editor.state,this.editor.view.dispatch,this.editor.view)])),
     'Mod-z':()=>this.editor.commands.undo(),'Mod-Shift-z':()=>this.editor.commands.redo(),'Mod-y':()=>this.editor.commands.redo(),
     Enter:()=>splitBlock(this.editor.state,this.editor.view.dispatch),'Shift-Enter':()=>splitBlock(this.editor.state,this.editor.view.dispatch),
     Tab:()=>{this.editor.commands.insertContent({type:'text',text:'\t'});return true;}};},
    addProseMirrorPlugins(){return [multiTextSelection(),plainCanvasCaret(),history(),new Plugin({props:{decorations(state){
     if(!owner.matcher)return DecorationSet.empty;const found:Decoration[]=[];
     state.doc.descendants((node,pos)=>{if(node.isText)for(const [a,b] of searchMatches(node.text!,owner.matcher!))found.push(Decoration.inline(pos+a,pos+b,{class:'text-search-match'}));});
     return DecorationSet.create(state.doc,found);
    }}})];}}),
  ],editorProps:{attributes:{class:'plain-text-document',spellcheck:'false','aria-label':'纯文本正文'},
   handlePaste:()=>{void this.paste().catch(e=>bridge.error(String(e)));return true;},
   handleDrop:()=>true,
   handleDOMEvents:{copy:(_view,event)=>{event.preventDefault();void this.copy().catch(e=>bridge.error(String(e)));return true;},cut:(_view,event)=>{event.preventDefault();void this.copy(true).catch(e=>bridge.error(String(e)));return true;}},
  },onUpdate:()=>bridge.change(),onSelectionUpdate:()=>bridge.selection(),onTransaction:({transaction})=>{for(const target of this.targets)target.map(transaction,this.applying);}});
  this.originalJSON=JSON.stringify(this.editor.getJSON());
 }
 text(){return this.editor.state.doc.content.content.map(node=>node.textContent).join('\n');}
 source(){return JSON.stringify(this.editor.getJSON())===this.originalJSON?this.originalSource:this.text();}
 html(){const pre=document.createElement('pre');pre.textContent=this.text();return pre.outerHTML;}
 async printHtml(){return this.html();}
 retarget(snapshot:TextFileSnapshot){this.snapshot=snapshot;this.originalSource=snapshot.source;this.originalJSON=JSON.stringify(this.editor.getJSON());}
 setSearch(query:string,options:SearchOptions={}){this.matcher=searchPattern(query,options);this.editor.view.dispatch(this.editor.state.tr.setMeta('text-search',true));}
 search(query:string,options:SearchOptions={}){return searchPlainText(this.text(),query,options);}
 focusPosition(pos:number,focus=true){
  const view=this.editor.view,resolved=Math.max(0,Math.min(view.state.doc.content.size,pos));view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(resolved))));
  if(focus)view.focus();const scroller=view.dom.closest<HTMLElement>('.document-scroller');if(scroller){const rect=view.coordsAtPos(resolved),bounds=scroller.getBoundingClientRect();if(rect.top<bounds.top||rect.bottom>bounds.bottom)scroller.scrollTop+=rect.top-bounds.top-10;}
 }
 private track<T>(promise:Promise<T>){this.pending.add(promise);void promise.finally(()=>this.pending.delete(promise)).catch(()=>{});return promise;}
 async whenIdle(){while(this.pending.size)await Promise.all([...this.pending]);}
 private target(){const selection=this.editor.state.selection,target=new AsyncTarget(selection,new Set(),[],selection.ranges.map(r=>({from:r.$from.pos,to:r.$to.pos})),false);this.targets.add(target);return target;}
 paste(){
  if(!this.editor.isEditable)return Promise.resolve();const target=this.target();
  return this.track(orderedClipboard(async()=>{
   try{const clip=await window.desktop.readClipboard();if(!clip.text||this.editor.isDestroyed||!this.editor.isEditable)return;
    const nodes=paragraphs(clip.text).map(node=>this.editor.schema.nodeFromJSON(node));this.applying=true;
    this.editor.view.dispatch(this.editor.state.tr.setSelection(target.selection).replaceSelection(new Slice(Fragment.fromArray(nodes),1,1)).scrollIntoView());
   }finally{this.applying=false;this.targets.delete(target);}
  }));
 }
 copy(cut=false){
  const selection=this.editor.state.selection;if(selection.empty)return Promise.resolve();const target=this.target(),text=selectedRangesText(this.editor.state.doc,selection);
  return this.track(orderedClipboard(async()=>{try{await window.desktop.copy({text});if(cut&&!this.editor.isDestroyed&&this.editor.isEditable){this.applying=true;this.editor.view.dispatch(this.editor.state.tr.setSelection(target.selection).deleteSelection());}}finally{this.applying=false;this.targets.delete(target);}}));
 }
 destroy(){this.editor.destroy();}
}
