import type { DocumentSnapshot, EventRecord } from '../shared/types';
import { TodoEditor } from './editor';
import {initialLayout} from './initial-layout';
import { friendlyError } from './errors';
import { Selection } from '@tiptap/pm/state';
import {isTdePath,isMarkdownDocument,isTextDocument,type NativeDocumentSnapshot} from '../shared/native-document';
import type {MarkdownEditor} from './markdown-editor';
import type {PlainTextEditor} from './plain-text-editor';
import {hasMarkdownFeatures} from './markdown-detection';
import {searchPattern,searchTest,type SearchOptions} from '../shared/search';

// Each tab owns one editor and one save queue for its entire lifetime.
let serial=0;
export class DocumentTab {
  readonly key=++serial;
  editor?:TodoEditor;
  markdown?:MarkdownEditor;
  plainText?:PlainTextEditor;
  get textEditor(){return this.markdown??this.plainText;}
  get isText(){return isTextDocument(this.snapshot);}
  get encoding(){return isTextDocument(this.snapshot)?({utf8:'UTF-8',utf16le:'UTF-16 LE',utf16be:'UTF-16 BE'}[this.snapshot.encoding??'utf8']):'UTF-8';}
  get isPlainText(){return isTextDocument(this.snapshot)&&this.snapshot.kind==='text';}
  private loading?:Promise<void>;
  private destroyed=false;
  private autoMarkdownEligible:boolean;
  private conversionOrigin?:DocumentSnapshot;
  private conversion?:Promise<boolean>;
  private restoringConversion=false;
  get isMarkdown(){return isMarkdownDocument(this.snapshot);}
  get currentEditor(){return this.textEditor?.editor??this.editor?.editor;}
  dirty=false;
  saving=false;
  private editingHolds=0;
  get fileBusy(){return this.editingHolds>0;}
  error='';
  backup='';
  changes=0;
  scroll=0;
  cursor=1;
  search={query:'',open:false,active:false,highlight:true,whole:true,caseSensitive:false,wholeWord:false,allFiles:false};
  private timer?:ReturnType<typeof setTimeout>;
  private pending?:Promise<void>;
  private fileOperation?:Promise<boolean>;
  private changedTimer?:ReturnType<typeof setTimeout>;
  private element?:HTMLElement;
  constructor(public snapshot:NativeDocumentSnapshot,private notify:()=>void,private report:(s:string)=>void) {this.autoMarkdownEligible=!!snapshot.draft&&!isTextDocument(snapshot);if(snapshot.recovered){this.dirty=true;this.error=snapshot.warning??'已恢复未保存内容';}}
  private change=(history=false)=>{
    if(!this.isText&&!this.blankTde())this.autoMarkdownEligible=false;
    if(history&&this.conversionOrigin&&this.markdown?.editor.isEmpty&&!this.restoringConversion){void Promise.resolve().then(()=>this.undoConversion()).catch(error=>this.report(friendlyError(error)));return;}
    this.dirty=true;this.changes++;clearTimeout(this.timer);
    if(!this.error&&!this.fileBusy)this.timer=setTimeout(()=>void this.flush().catch(()=>{}),500);
    this.scheduleNotify();
  };
  private blankTde(){const events=this.records();return events.length===1&&!events[0].top_divider&&!events[0].deadline_raw&&!events[0].done&&!!this.editor?.editor.isEmpty;}
  private async convertPaste(clipboard:Awaited<ReturnType<import('../shared/types').DesktopAPI['readClipboard']>>):Promise<boolean>{
    if(!this.autoMarkdownEligible||this.fileBusy||!this.element||isTextDocument(this.snapshot)||!this.blankTde()||!hasMarkdownFeatures(clipboard))return false;
    const original=this.snapshot,release=this.holdEditing();let destination:NativeDocumentSnapshot|undefined;
    try{
      // Download/parse failures happen before releasing the original empty tab.
      await import('./markdown-editor');destination=await window.desktop.markdown.create();
      this.editor?.destroy();this.editor=undefined;this.snapshot=destination;this.cursor=1;this.mount(this.element);await this.loading;
      if(!this.markdown)throw new Error('Markdown 编辑器未能启动');
      this.markdown.editor.setEditable(true,false);
      await this.markdown.paste(false,clipboard);this.markdown.editor.setEditable(false,false);
      this.conversionOrigin=original;this.autoMarkdownEligible=false;this.dirty=true;this.changes++;this.notify();return true;
    }catch(error){
      this.markdown?.destroy();this.markdown=undefined;this.snapshot=original;this.dirty=false;this.error='';if(this.element)this.mount(this.element);
      if(destination)await window.desktop.close(destination.handle).catch(()=>{});throw error;
    }finally{release();if(this.element?.closest<HTMLElement>('.document-scroller')?.style.display!=='none')this.currentEditor?.commands.focus();}
  }
  private async undoConversion(){
    const original=this.conversionOrigin;if(!original||!this.markdown?.editor.isEmpty)return;this.restoringConversion=true;const release=this.holdEditing();
    try{
      if(this.pending)await this.pending;
      const converted=this.snapshot;this.markdown?.destroy();this.markdown=undefined;this.snapshot=original;this.conversionOrigin=undefined;this.autoMarkdownEligible=true;this.dirty=false;this.error='';this.changes++;this.cursor=1;
      if(this.element)this.mount(this.element);
      await window.desktop.close(converted.handle);this.notify();
    }finally{this.restoringConversion=false;release();if(this.element?.closest<HTMLElement>('.document-scroller')?.style.display!=='none')this.currentEditor?.commands.focus();}
  }
  async confirmFormat(){this.autoMarkdownEligible=false;const original=this.conversionOrigin;this.conversionOrigin=undefined;if(original)await window.desktop.close(original.handle);}
  mount(element:HTMLElement,initialize=true) {
    this.element=element;
    if(this.editor||this.textEditor||this.loading||!initialize||this.destroyed)return;
    if(isTextDocument(this.snapshot)&&this.snapshot.kind==='text'){
      const snapshot=this.snapshot;
      this.loading=import('./plain-text-editor').then(({PlainTextEditor})=>{
        if(this.destroyed||this.snapshot!==snapshot)return;
        initialLayout(element,()=>{
          this.plainText=new PlainTextEditor(element,snapshot,{change:this.change,selection:()=>this.scheduleNotify(),error:this.report});
          const ed=this.plainText.editor,p=Math.max(0,Math.min(this.cursor,ed.state.doc.content.size));
          ed.view.dispatch(ed.state.tr.setSelection(Selection.near(ed.state.doc.resolve(p))));
          if(this.fileBusy)ed.setEditable(false,false);
          this.plainText.setSearch(this.search.active&&this.search.highlight?this.search.query:'',this.search);
        });
      }).catch(error=>{this.error=friendlyError(error);this.report(this.error);throw error;}).finally(()=>{this.loading=undefined;this.notify();});
      void this.loading.catch(()=>{});return;
    }
    if(isTextDocument(this.snapshot)){
      const snapshot=this.snapshot;
      this.loading=import('./markdown-editor').then(({MarkdownEditor})=>{
        if(this.destroyed||this.snapshot!==snapshot)return;
        initialLayout(element,()=>{
        this.markdown=new MarkdownEditor(element,snapshot,{change:this.change,selection:()=>this.scheduleNotify(),error:this.report,asset:(data,name)=>window.desktop.markdown.addAsset(this.snapshot.handle,data,name)});
        if(this.fileBusy)this.markdown.editor.setEditable(false,false);
        const ed=this.markdown.editor,p=Math.max(0,Math.min(this.cursor,ed.state.doc.content.size));ed.view.dispatch(ed.state.tr.setSelection(Selection.near(ed.state.doc.resolve(p))));
        this.markdown.setSearch(this.search.active&&this.search.highlight?this.search.query:'',this.search);this.scheduleNotify();
        });
      }).catch(error=>{this.error=friendlyError(error);this.report(this.error);throw error;}).finally(()=>{this.loading=undefined;this.notify();});
      void this.loading.catch(()=>{});return;
    }
    const snapshot=this.snapshot;
    initialLayout(element,()=>{
    this.editor=new TodoEditor(element,snapshot,{
      change:this.change,selection:()=>this.scheduleNotify(),error:this.report,
      interceptPaste:clipboard=>{
        const operation=this.convertPaste(clipboard);this.conversion=operation;
        void operation.finally(()=>{if(this.conversion===operation)this.conversion=undefined;}).catch(()=>{});return operation;
      },
      asset:(data,w,h)=>window.desktop.addAsset(this.snapshot.handle,data,w,h),
      assets:assets=>window.desktop.addAssets(this.snapshot.handle,assets),
      imageInfo:window.desktop.imageInfo?data=>window.desktop.imageInfo(data):undefined,
    });
    if(this.fileBusy)this.editor.editor.setEditable(false,false);
    const ed=this.editor.editor,p=Math.max(0,Math.min(this.cursor,ed.state.doc.content.size));
    ed.view.dispatch(ed.state.tr.setSelection(Selection.near(ed.state.doc.resolve(p))));
    this.scheduleNotify();
    });
  }
  // Background reminders may edit a tab before the user first visits it.
  ensureEditor(){
    if(!this.editor&&this.element)this.mount(this.element);
    return this.editor;
  }
  private scheduleNotify(){if(!this.changedTimer)this.changedTimer=setTimeout(()=>{this.changedTimer=undefined;this.notify();},150);}
  holdEditing(){
    this.editingHolds++;clearTimeout(this.timer);this.currentEditor?.setEditable(false,false);this.notify();
    let released=false;
    return ()=>{
      if(released)return;released=true;this.editingHolds--;
      if(!this.currentEditor?.isDestroyed)this.currentEditor?.setEditable(!this.fileBusy&&!this.snapshot.readOnly,false);
      if(!this.fileBusy&&this.dirty&&!this.error)this.timer=setTimeout(()=>void this.flush().catch(()=>{}),500);
      this.notify();
    };
  }
  records():EventRecord[]{return this.editor?.records()??(isTextDocument(this.snapshot)?[]:this.snapshot.events);}
  source(){return this.textEditor?.source()??(isTextDocument(this.snapshot)?this.snapshot.source:'');}
  async whenReady(){if(this.loading)await this.loading;}
  async searchHits(query:string,options:SearchOptions={}){
    if(isTextDocument(this.snapshot)&&this.snapshot.kind==='text')return this.plainText?this.plainText.search(query,options):(await import('./plain-text-editor')).searchPlainText(this.snapshot.source,query,options);
    if(isMarkdownDocument(this.snapshot))return this.markdown?this.markdown.search(query,options):(await import('./markdown-search')).searchMarkdownSource(this.snapshot.source,query,options);
    const pattern=searchPattern(query,options);return pattern?this.records().filter(event=>searchTest(event.content_text+' '+event.deadline_raw,pattern)).map(event=>({id:event.id,text:event.content_text})):[];
  }
  private markdownRequest(){const assets:string[]=[];this.markdown?.editor.state.doc.descendants(node=>{if(node.type.name==='image')assets.push(node.attrs.src);});return {handle:this.snapshot.handle,revision:this.snapshot.revision,source:this.source(),assets};}
  async flush():Promise<void> {
    clearTimeout(this.timer);
    if(this.conversion)await this.conversion;
    if(this.fileOperation)await this.fileOperation;
    if(this.loading)await this.loading;
    if(this.editor)await this.editor.whenIdle();
    if(this.textEditor)await this.textEditor.whenIdle();
    return this.writePending();
  }
  private async writePending():Promise<void>{
    if(this.pending)return this.pending;
    if(!this.dirty)return;
    this.pending=(async()=>{
      this.saving=true;this.error='';this.notify();
      try {
        while(this.dirty){
          const version=this.changes,events=this.records();
          if(isTextDocument(this.snapshot)){
            const request=this.markdownRequest(),result=await window.desktop.markdown.save(request);
            this.snapshot.revision=result.revision;this.snapshot.source=request.source;this.snapshot.recovered=false;this.snapshot.warning=result.warning;this.dirty=version!==this.changes;continue;
          }
          const result=await window.desktop.save({handle:this.snapshot.handle,revision:this.snapshot.revision,events});
          this.snapshot.revision=result.revision;
          this.snapshot.recovered=false;this.snapshot.warning=result.warning;
          this.editor?.remap(result.idMap);
          this.snapshot.events=events.map(e=>({...e,id:result.idMap[e.id]??e.id}));
          this.backup=result.backup??this.backup;
          this.dirty=version!==this.changes;
        }
      } catch(error){this.error=friendlyError(error);this.report(this.error);throw error;}
      finally {this.saving=false;this.notify();}
    })();
    try {await this.pending;}finally{this.pending=undefined;}
  }
  async relocate(kind:'saveAs'|'rename'|'reload',name?:string):Promise<boolean>{
    if(this.conversion)await this.conversion;
    if(this.fileOperation)return this.fileOperation;
    const release=this.holdEditing();
    this.fileOperation=Promise.resolve().then(async()=>{
      try{
        if(this.loading)await this.loading;
        await this.editor?.whenIdle();
        await this.textEditor?.whenIdle();
        if(this.pending)await this.pending.catch(error=>{if(kind==='rename')throw error;});
        if(kind==='rename'){
          // A brand-new TDE has a visible empty paragraph but no stored event yet.
          // Persist it before rename so the returned snapshot can retarget that paragraph.
          if(!isTextDocument(this.snapshot)&&!this.snapshot.events.length&&this.records().length)this.dirty=true;
          await this.writePending();
        }
        const source=this.snapshot,exported=this.records();
        if(kind==='rename'&&name&&isTdePath(name)===isTextDocument(source)){
          const {conversionRequest}=await import('./format-conversion');
          // Ensure the destination editor can load before committing a file conversion.
          if(!isTdePath(name))await import('./markdown-editor');
          const destination=await window.desktop.renameFormat(await conversionRequest(this,name));
          this.editor?.destroy();this.textEditor?.destroy();this.editor=undefined;this.markdown=undefined;this.plainText=undefined;
          this.snapshot=destination;this.cursor=1;this.scroll=0;this.dirty=false;this.error='';this.changes++;
          if(this.element){this.mount(this.element);await this.loading;const scroller=this.element.closest('.document-scroller');if(scroller)scroller.scrollTop=0;}
          await this.confirmFormat();return true;
        }

        if(isTextDocument(source)){
          const request=this.markdownRequest();
          const destination=kind==='saveAs'?await window.desktop.markdown.saveAs(request):kind==='reload'?await window.desktop.markdown.reload(request):await window.desktop.markdown.rename(source.handle,name??source.name);
          if(!destination)return false;
          if(kind==='reload'||destination.kind!==source.kind){this.textEditor?.destroy();this.markdown=undefined;this.plainText=undefined;this.snapshot=destination;if(this.element)this.mount(this.element);await this.loading;}
          else{this.textEditor?.retarget(destination);this.snapshot=destination;}
          this.dirty=false;this.error='';this.backup='';this.changes++;
          if(kind!=='reload')await this.confirmFormat();
          if(kind==='saveAs'&&source.handle!==destination.handle)await window.desktop.close(source.handle).catch(error=>this.report('新文件已保存；旧文件连接释放失败：'+friendlyError(error)));
          return true;
        }
        const request={handle:source.handle,revision:source.revision,events:exported};
        const destination=kind==='saveAs'?await window.desktop.saveAs(request):kind==='reload'?await window.desktop.reload(request):await window.desktop.rename(source.handle,name);
        if(!destination)return false;
        if(kind==='reload'){
          this.editor?.destroy();this.editor=undefined;this.snapshot=destination;
          if(this.element)this.mount(this.element);
          (this.editor as TodoEditor|undefined)?.setSearch(this.search.active&&this.search.highlight?this.search.query:'',this.search.whole);
        }else{this.editor?.retarget(destination,exported);this.snapshot=destination;}
        this.dirty=false;this.error='';this.backup='';this.changes++;
        if(kind!=='reload')await this.confirmFormat();
        // Adopt the acknowledged copy before releasing the old connection. A
        // cleanup failure cannot leave the visible tab pointing at a closed file.
        if(kind==='saveAs'&&source.handle!==destination.handle)await window.desktop.close(source.handle).catch(error=>this.report('新文件已保存；旧文件连接释放失败：'+friendlyError(error)));
        return true;
      }finally{release();}
    });
    try{return await this.fileOperation;}finally{this.fileOperation=undefined;}
  }
  destroy(){this.destroyed=true;clearTimeout(this.timer);clearTimeout(this.changedTimer);this.editor?.destroy();this.textEditor?.destroy();}
}
