import {SearchWindow} from './SearchWindow';
import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {flushSync} from 'react-dom';
import { Sigma, WrapText, GitCompareArrows, ArrowUpRight, AArrowDown, AArrowUp, ALargeSmall, ArrowUpToLine, BellOff, CalendarDays, ChevronLeft, ChevronUp, GripVertical, Table2, Quote, Code, SquareCode, AlignLeft, AlignCenter, AlignRight, AlignJustify, Pilcrow, Superscript, Subscript, ArrowDownToLine, Bell, Bold, Check, CheckCheck, ChevronDown, ChevronRight, Circle, FilePlus2, FileText, FolderOpen, History, ImagePlus, Italic, Link2, List, ListOrdered, ListTree, Minus, PanelLeftClose, PanelLeftOpen, Plus, Redo2, Search, Settings2, Square, Strikethrough, Undo2, X } from 'lucide-react';
import type { DocumentSnapshot, Notice, SessionData, Settings } from '../shared/types';
import type {NativeDocumentSnapshot} from '../shared/native-document';
import {isDocumentPath} from '../shared/native-document';
import {MarkdownOutline} from './MarkdownOutline';
import {EventNavigation} from './EventNavigation';
import {activeHeading} from './markdown-outline';
import { defaultSettings } from '../shared/types';
import { DocumentTab } from './runtime';
import { exportContents, groups } from './document';
import { formatDate, countdown } from '../shared/deadline';
import { friendlyError } from './errors';
import { EventPanel } from './EventPanel';
import { CalendarPanel } from './CalendarPanel';
import { Tooltip } from './Tooltip';
import { TabRename } from './TabRename';
import { searchPattern, searchTest } from '../shared/search';
import { bulletStyleNames, bulletStyles, isBulletStyle, listStyleNames, orderedStyles, type ListStyle } from './list-style';

// A hit remembers its file, so results can span every open document.
type Hit={id:number;text:string;tab:number};
import {useTabReorder} from './useTabReorder';
import {safeLink} from './codec';
import {linkEndRange,unlinkSelection} from './link-editing';
import {TableRowSelection} from './table-row-selection';
import {inputTraceReport} from './input-trace';
import { eventLists, type EventListKind } from '../shared/event-lists';
import './event-panel.css';

const DiffView=React.lazy(()=>import('./DiffView'));
const ImageViewer=React.lazy(()=>import('./ImageViewer'));
const Pane=memo(function Pane({tab,active}:{tab:DocumentTab;active:boolean}){
  const ref=useRef<HTMLDivElement>(null);
  // Keep visited editors mounted for undo/async edits, but don't build hidden ones at startup.
  useLayoutEffect(()=>{
    const scroll=tab.scroll;let cancelled=false;tab.mount(ref.current!,active);
    if(active){
      if(tab.currentEditor)ref.current!.parentElement!.scrollTop=scroll;
      else void tab.whenReady().then(()=>{if(!cancelled&&ref.current)ref.current.parentElement!.scrollTop=scroll;}).catch(()=>{});
    }
    return()=>{cancelled=true;};
  },[tab,active]);
  return <div ref={ref} className="editor-mount"/>;
});
function Tool({title,children,onClick,active=false,disabled=false}:{title:string;children:React.ReactNode;onClick:()=>void;active?:boolean;disabled?:boolean}){
  return <button title={title} aria-label={title} className={'tool '+(active?'active':'')} disabled={disabled} onMouseDown={e=>e.preventDefault()} onClick={onClick}>{children}</button>;
}
export function App(){
  const tabs=useRef<DocumentTab[]>([]),activeRef=useRef(0),ready=useRef(false);
  const [tick,setTick]=useState(0),[active,setActive]=useState(0),[settings,setSettings]=useState<Settings>(defaultSettings),[recent,setRecent]=useState<string[]>([]);
  const [toast,setToast]=useState(''),[exported,setExported]=useState(''),[searchOpen,setSearchOpen]=useState(false),[query,setQuery]=useState(''),[searchResult,setSearchResult]=useState<{key:string;hits:Hit[]}>({key:'',hits:[]}),[onlyPending,setOnlyPending]=useState(false);
  const [searchActivation,setSearchActivation]=useState(0);
  const [popup,setPopup]=useState<'export'|'settings'|'events'|'link'|'format'|'table'|'file'|'event'|'recent'|'calendar'|'text'|'listStyle'|null>(null),[link,setLink]=useState('https://'),[notices,setNotices]=useState<Notice[]>([]),[loading,setLoading]=useState(true);
  const [recentQuery,setRecentQuery]=useState('');
  const [settingsAtBrand,setSettingsAtBrand]=useState(false);
  const toggleSettings=(atBrand=false)=>{setSettingsAtBrand(atBrand);setPopup(popup==='settings'&&settingsAtBrand===atBrand?null:'settings');};
  const [searchSource,setSearchSource]=useState<'quick'|'window'|null>(null);
  const quickSearchRef=useRef<HTMLInputElement>(null),selectQuickOnMouseUp=useRef(false);
  const [diffPair,setDiffPair]=useState<{left:DocumentTab;right:DocumentTab}|null>(null);
  const [imageSource,setImageSource]=useState<string|null>(null);
  const [defaultDirectory,setDefaultDirectory]=useState('应用文档目录');
  const [systemDark,setSystemDark]=useState(false);
  const [renaming,setRenaming]=useState<number|null>(null);
  const [eventKind,setEventKind]=useState<EventListKind>('all'),[highlight,setHighlight]=useState(true),[wholeEvent,setWholeEvent]=useState(true),[caseSensitive,setCaseSensitive]=useState(false),[wholeWord,setWholeWord]=useState(false),[allFiles,setAllFiles]=useState(false),[now,setNow]=useState(Date.now()),[snoozed,setSnoozed]=useState<number[]>([]);
  const [eventMenu,setEventMenu]=useState({id:0,x:0,y:0}),[textMenu,setTextMenu]=useState<{x:number;y:number;selected:boolean;list:ListStyle|null;continues:boolean;href:string|null;eventId:number|null}>({x:0,y:0,selected:false,list:null,continues:false,href:null,eventId:null}),[listMenu,setListMenu]=useState({x:0,y:0});
  const listMenuRef=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const el=listMenuRef.current;if(popup!=='listStyle'||!el)return;
    const x=Math.max(8,Math.min(listMenu.x,innerWidth-el.offsetWidth-8)),y=Math.max(8,Math.min(listMenu.y,innerHeight-el.offsetHeight-8));
    if(x!==listMenu.x||y!==listMenu.y)setListMenu({x,y});
  },[popup,listMenu]);
  const textMenuRef=useRef<HTMLDivElement>(null);
  // Clamp with the menu's rendered size, so it never runs off an edge.
  useLayoutEffect(()=>{
    const el=textMenuRef.current;if(popup!=='text'||!el)return;
    const x=Math.max(8,Math.min(textMenu.x,innerWidth-el.offsetWidth-8)),y=Math.max(8,Math.min(textMenu.y,innerHeight-el.offsetHeight-8));
    if(x!==textMenu.x||y!==textMenu.y)setTextMenu(menu=>({...menu,x,y}));
  },[popup,textMenu]);
  const hoverTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  const pinnedEvents=useRef(false);
  const closingTabs=useRef(new Set<DocumentTab>());
  const closingWindow=useRef(false);
  const matchIndex=useRef(-1);
  const tabStrip=useRef<HTMLDivElement>(null);
  const [scrolled,setScrolled]=useState(false);
  const [markdownPosition,setMarkdownPosition]=useState(0);
  const autoJumped=useRef(''),pointer=useRef({x:0,y:0});
  const imageInput=useRef<HTMLInputElement>(null),searchRef=useRef<HTMLInputElement>(null),settingsRef=useRef(settings),commandsRef=useRef<(c:string)=>void>(()=>{});
  const update=()=>setTick(t=>t+1);
  const report=(s:string)=>setToast(friendlyError(s));
  const tab=tabs.current[active];
  const previousTab=tabs.current[active-1];
  const canDiff=!!tab&&!!previousTab&&tab.isText===previousTab.isText&&tab.isMarkdown===previousTab.isMarkdown;
  const searchActive=searchSource!==null;
  const searchKey=JSON.stringify([tab?.key,query,caseSensitive,wholeWord,allFiles,tab?.changes]);
  const hits=searchResult.key===searchKey?searchResult.hits:[];
  const editor=tab?.currentEditor;
  const paragraphAlignment=popup==='format'?tab?.editor?.paragraphAlignment():undefined;
  const selectionFontSize=popup==='format'?tab?.editor?.fontSize():undefined;
  // The toolbar stepper follows the selection when there is one, else the canvas size.
  const sizedSelection=!!tab?.editor?.sizedSelection();
  const toolbarFontSize=sizedSelection?tab?.editor?.fontSize():settings.fontSize;
  const stepFontSize=(delta:number)=>{const target=tab?.editor;if(target?.sizedSelection())target.changeFontSize(delta);else changeSetting('fontSize',Math.max(10,Math.min(30,settings.fontSize+delta)));};
  settingsRef.current=settings;
  const persist=async()=>{
    if(!ready.current)return;
    const data:Partial<SessionData>={tabs:tabs.current.map(t=>({path:t.snapshot.path,cursor:t.currentEditor?.state.selection.from??t.cursor,scroll:t.scroll})),active:activeRef.current,settings:settingsRef.current};
    await window.desktop.updateSession(data);
  };
  const activate=(index:number)=>{setRenaming(null);activeRef.current=index;setActive(index);const s=tabs.current[index]?.search;setQuery(s?.query??'');setSearchOpen(s?.open??false);setSearchSource(quickSearchRef.current&&document.activeElement===quickSearchRef.current?'quick':s?.open?'window':null);setHighlight(s?.highlight??true);setWholeEvent(s?.whole??true);setCaseSensitive(!!s?.caseSensitive);setWholeWord(!!s?.wholeWord);setAllFiles(!!s?.allFiles);setScrolled((tabs.current[index]?.scroll??0)>240);setPopup(null);void persist().catch(report);};
  const moveTab=(key:number,before:number|null)=>{
    if(renaming!==null||closingWindow.current||closingTabs.current.size)return;
    const source=tabs.current.find(t=>t.key===key),selected=tabs.current[activeRef.current];if(!source)return;
    const next=tabs.current.filter(t=>t!==source),index=before===null?next.length:next.findIndex(t=>t.key===before);if(index<0)return;
    next.splice(index,0,source);if(next.every((t,i)=>t===tabs.current[i]))return;
    tabs.current=next;activeRef.current=next.indexOf(selected);setActive(activeRef.current);update();void persist().catch(report);
  };
  useTabReorder(tabStrip,renaming===null&&!closingWindow.current&&!closingTabs.current.size,moveTab);
  const add=(doc:NativeDocumentSnapshot|null,restore?:{cursor:number;scroll:number},select=true)=>{
    if(!doc)return;
    if(!restore)setRecent(r=>[doc.path,...r.filter(x=>x.toLowerCase()!==doc.path.toLowerCase())].slice(0,12));
    const exists=tabs.current.findIndex(t=>t.snapshot.path.toLowerCase()===doc.path.toLowerCase());
    if(exists>=0){if(select)activate(exists);return;}
    const runtime=new DocumentTab(doc,update,report);if(restore){runtime.cursor=restore.cursor;runtime.scroll=restore.scroll;}
    tabs.current.push(runtime);if(select){activate(tabs.current.length-1);update();}
  };
  useEffect(()=>{
    let alive=true;
    void (async()=>{
      const session=await window.desktop.session();if(!alive)return;
      setSettings(session.settings);settingsRef.current=session.settings;setRecent(session.recent);
      setDefaultDirectory(session.defaultNewFileDirectory??'应用文档目录');
      setSystemDark(!!session.systemDark);
      if(session.warning)report(session.warning);
      // Collect snapshots before rendering: restoring a session must not activate and
      // construct every intermediate tab. allSettled keeps failures isolated and order stable.
      const restored=await window.desktop.restoreSession();
      if(!alive)return;
      restored.forEach((result,i)=>{if(result.status==='fulfilled')add(result.value,session.tabs[i],false);else report('无法恢复 '+session.tabs[i].path+'：'+String(result.reason));});
      const selectedPath=session.tabs[session.active]?.path.toLowerCase();
      activeRef.current=Math.max(0,tabs.current.findIndex(t=>t.snapshot.path.toLowerCase()===selectedPath));setActive(activeRef.current);
      ready.current=true;setLoading(false);await window.desktop.ready();
    })().catch(e=>{setLoading(false);report(String(e));});
    const uncommand=window.desktop.onCommand(c=>commandsRef.current(c));
    const unopened=window.desktop.onOpened(doc=>add(doc));
    const unerror=window.desktop.onError(report);
    const untheme=window.desktop.onTheme(setSystemDark);
    const unrecent=window.desktop.onRecentChanged(setRecent);
    const unclose=window.desktop.onClose(()=>{void (async()=>{
      if(closingWindow.current)return;closingWindow.current=true;
      const release=tabs.current.map(t=>t.holdEditing());update();
      try{await Promise.all(tabs.current.map(t=>t.flush()));await persist();window.desktop.confirmClose(true);}
      catch{closingWindow.current=false;for(const unlock of release)unlock();update();window.desktop.confirmClose(false);report('还有内容未能保存，窗口已保持打开。请重试保存或另存为。');}
    })();});
    const unnotice=window.desktop.onNotices(setNotices);
    const undonereminder=window.desktop.onReminderEdit(n=>{void (async()=>{
      try{
        const t=tabs.current.find(t=>t.snapshot.handle===n.handle);
        if(!t||t.fileBusy)throw new Error('文件正在处理或尚未准备好，请稍后重试。');
        if(t.snapshot.readOnly)throw new Error('该文档为只读，无法修改提醒事件。');
        const target=t.ensureEditor();if(!target)throw new Error('编辑器尚未准备好，请稍后重试。');
        const e=t.records().find(e=>e.id===n.eventId);
        if(!e||e.deadline_ts!==n.due)throw new Error('事件已删除或截止时间已更改。');
        if(n.deadline){
          if(e.done)throw new Error('事件已完成，无法推迟提醒。');
          target.setEventDeadline(n.eventId,n.deadline.raw,n.deadline.ts);
          try{await t.flush();}catch(error){
            const latest=t.records().find(e=>e.id===n.eventId);
            if(latest?.deadline_ts===n.deadline.ts&&latest.deadline_raw===n.deadline.raw)target.setEventDeadline(n.eventId,e.deadline_raw,e.deadline_ts);
            throw error;
          }
        }else{if(!e.done)target.setEventDone(n.eventId,true);await t.flush();}
        await window.desktop.reminderEdited(n.id);
      }catch(error){await window.desktop.reminderEdited(n.id,String(error));}
    })().catch(report);});
    const unreveal=window.desktop.onReveal(({handle,eventId})=>{const i=tabs.current.findIndex(t=>t.snapshot.handle===handle);if(i>=0){flushSync(()=>activate(i));tabs.current[i].editor?.focusEvent(eventId);}});
    const timer=setInterval(()=>void persist().catch(()=>{}),5000);
    return()=>{alive=false;uncommand();unopened();unerror();untheme();unrecent();unclose();unnotice();undonereminder();unreveal();clearInterval(timer);};
  },[]);
  useEffect(()=>{document.documentElement.dataset.theme=settings.theme==='system'?(systemDark?'dark':'light'):settings.theme;document.documentElement.style.setProperty('--editor-size',settings.fontSize+'px');document.documentElement.style.setProperty('--editor-line-spacing',String(settings.lineSpacing));},[settings,systemDark]);
  useEffect(()=>{if(ready.current)void persist().catch(report);},[settings]);
  useEffect(()=>{if(ready.current)void persist().catch(report);},[tab?.snapshot.handle]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),9000);return()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{
    const modifiers=(e:KeyboardEvent|PointerEvent)=>document.documentElement.classList.toggle('ctrl-link-mode',e.ctrlKey);
    const reset=()=>document.documentElement.classList.remove('ctrl-link-mode');
    addEventListener('keydown',modifiers,true);addEventListener('keyup',modifiers,true);addEventListener('pointermove',modifiers,true);addEventListener('blur',reset);
    return()=>{removeEventListener('keydown',modifiers,true);removeEventListener('keyup',modifiers,true);removeEventListener('pointermove',modifiers,true);removeEventListener('blur',reset);reset();};
  },[]);
  useEffect(()=>{const track=(e:PointerEvent)=>{pointer.current={x:e.clientX,y:e.clientY};};addEventListener('pointermove',track,true);return()=>removeEventListener('pointermove',track,true);},[]);
  // A native window can lose focus while its input remains document.activeElement.
  useEffect(()=>{
    const blur=()=>setSearchSource(source=>source==='quick'?null:source);
    const focus=()=>{const input=quickSearchRef.current;if(input&&document.activeElement===input){input.select();setSearchSource('quick');selectQuickOnMouseUp.current=true;}};
    addEventListener('blur',blur);addEventListener('focus',focus);
    return()=>{removeEventListener('blur',blur);removeEventListener('focus',focus);};
  },[]);
  useEffect(()=>{if(!settings.sidebar)setSearchSource(source=>source==='quick'?null:source);},[settings.sidebar]);
  // Typing a query lands on its first event without a manual step.
  useEffect(()=>{
    if(!searchActive||!query.trim()){autoJumped.current='';return;}
    if(imageSource||!hits.length)return;
    const key=JSON.stringify([allFiles?'all':tab?.key,query,caseSensitive,wholeWord,allFiles,searchActivation]);if(autoJumped.current===key)return;
    autoJumped.current=key;matchIndex.current=0;focusHit(hits[0],false);
  },[hits,query,searchActive,caseSensitive,wholeWord,allFiles,searchActivation,imageSource,tab?.key]);
  useEffect(()=>{
    if(tab)tab.search={query,open:searchOpen,active:searchActive,highlight,whole:wholeEvent,caseSensitive,wholeWord,allFiles};
    const shown=searchActive&&highlight?query:'';
    for(const open of tabs.current){open.editor?.setSearch(open===tab||allFiles?shown:'',wholeEvent,{caseSensitive,wholeWord});open.textEditor?.setSearch(open===tab||allFiles?shown:'',{caseSensitive,wholeWord});}
  },[query,searchOpen,searchActive,highlight,wholeEvent,caseSensitive,wholeWord,allFiles,active]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(popup!=='events')pinnedEvents.current=false;},[popup]);
  useEffect(()=>()=>clearTimeout(hoverTimer.current),[]);
  useEffect(()=>{
    const area=document.querySelector('.document-area');
    const zoom=(e:Event)=>{const wheel=e as WheelEvent;if(!wheel.ctrlKey||!wheel.deltaY)return;wheel.preventDefault();setSettings(s=>({...s,fontSize:Math.max(10,Math.min(30,s.fontSize+(wheel.deltaY<0?1:-1)))}));};
    area?.addEventListener('wheel',zoom,{passive:false});return()=>area?.removeEventListener('wheel',zoom);
  },[]);
  useEffect(()=>{let alive=true;setSnoozed([]);if(tab&&!tab.isText)void window.desktop.snoozedEvents(tab.snapshot.handle).then(ids=>{if(alive)setSnoozed(ids);}).catch(report);return()=>{alive=false;};},[tab?.snapshot.handle,tab?.snapshot.revision,now,notices]);
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{if(e.key!=='Escape'||e.isComposing||renaming||imageSource)return;if(diffPair){e.preventDefault();e.stopPropagation();setDiffPair(null);return;}if(popup){e.preventDefault();e.stopPropagation();flushSync(()=>setPopup(null));if(popup==='link'||popup==='format'||popup==='table'||popup==='text'||popup==='listStyle')editor?.view.focus();}else if(exported){e.preventDefault();e.stopPropagation();setExported('');}else if(searchOpen){e.preventDefault();e.stopPropagation();setSearchOpen(false);setSearchSource(null);setQuery('');editor?.commands.focus();}};
    document.addEventListener('keydown',key,true);return()=>document.removeEventListener('keydown',key,true);
  },[popup,searchOpen,editor,renaming,exported,imageSource,diffPair]);
  useEffect(()=>{
    const pattern=searchPattern(query,{caseSensitive,wholeWord});
    if(!tab||!pattern){setSearchResult({key:searchKey,hits:[]});return;}
    let alive=true;const timer=setTimeout(()=>{
      // The database index only knows saved text and cannot express the match
      // options, so anything but a plain search of this file is scanned here.
      const scan=async(t:DocumentTab)=>(await t.searchHits(query,{caseSensitive,wholeWord})).map(hit=>({...hit,tab:t.key}));
      const find=tab.isText||allFiles||caseSensitive||wholeWord||tab.dirty
        ?Promise.all((allFiles?tabs.current:[tab]).map(scan)).then(results=>results.flat())
        :window.desktop.search(tab.snapshot.handle,query).then(found=>found.map(h=>({...h,tab:tab.key})));
      void find.then(h=>{if(alive)setSearchResult({key:searchKey,hits:h});}).catch(report);
    },120);return()=>{alive=false;clearTimeout(timer);};
  },[query,active,tab?.changes,caseSensitive,wholeWord,allFiles]);
  const safely=(fn:()=>void|Promise<unknown>)=>{try{void Promise.resolve(fn()).catch(e=>report(String(e)));}catch(e){report(String(e));}};
  const open=()=>safely(async()=>add(await window.desktop.open()));
  const create=()=>safely(async()=>add(await window.desktop.create()));
  const closeTab=async(index:number)=>{
    const t=tabs.current[index];if(!t||closingTabs.current.has(t))return;
    closingTabs.current.add(t);const release=t.holdEditing();
    try{await t.flush();await t.confirmFormat();await window.desktop.close(t.snapshot.handle,true);
      const current=tabs.current[activeRef.current],removed=tabs.current.indexOf(t);
      if(removed<0)return;
      t.destroy();tabs.current.splice(removed,1);
      activate(current!==t?Math.max(0,tabs.current.indexOf(current)):Math.max(0,Math.min(removed,tabs.current.length-1)));update();await persist();
    }finally{release();closingTabs.current.delete(t);}
  };
  const saveAs=async()=>{
    if(!tab)return;
    if(await tab.relocate('saveAs')){setRecent(r=>[tab.snapshot.path,...r.filter(p=>p!==tab.snapshot.path)].slice(0,12));update();await persist();}
  };
  const run=(c:string)=>{
    if(closingWindow.current||imageSource||diffPair)return;
    if(c==='nextMatch'||c==='previousMatch'){if(!hits.length)return;const delta=c==='nextMatch'?1:-1;matchIndex.current=((matchIndex.current<0?(delta>0?-1:0):matchIndex.current)+delta+hits.length)%hits.length;focusHit(hits[matchIndex.current],false);return;}
    if(c==='zoomIn'||c==='zoomOut'||c==='zoomReset'){setSettings(s=>({...s,fontSize:c==='zoomReset'?15:Math.max(10,Math.min(30,s.fontSize+(c==='zoomIn'?1:-1)))}));return;}
    switch(c){case'pinEvent':{const id=popup==='text'?textMenu.eventId:popup==='event'?eventMenu.id:null;if(id!=null)tab?.editor?.moveEventToTop(id);else tab?.editor?.moveCurrentEventToTop();setPopup(null);break;}case'new':create();break;case'open':open();break;case'save':safely(async()=>{if(tab){if(tab.isMarkdown&&tab.snapshot.draft)await saveAs();else{await tab.flush();await tab.confirmFormat();}}});break;case'saveAs':safely(saveAs);break;case'closeTab':if(tab)safely(()=>closeTab(active));break;case'search':setSearchSource('window');setSearchActivation(n=>n+1);setSearchOpen(true);if(searchOpen)safely(()=>window.desktop.showSearch());searchRef.current?.focus();searchRef.current?.select();break;case'inputTrace':safely(async()=>setToast('已导出输入诊断记录：'+await window.desktop.saveDiagnostics(inputTraceReport())));break;}
  };
  commandsRef.current=run;
  const exportFile=async(format:'md'|'txt'|'pdf')=>{
    setPopup(null);if(!tab)return;await tab.flush();const records=tab.records();const file=await window.desktop.exportFile(tab.snapshot.handle,format,format==='pdf'?(tab.textEditor?await tab.textEditor.printHtml():exportContents(records,format,tab.snapshot.handle)):'',format==='pdf'?'':tab.isText?(format==='md'?tab.source():tab.textEditor?.text()??tab.source()):exportContents(records,format,tab.snapshot.handle));if(file)setExported(file);
  };
  const reload=async()=>{if(tab&&await tab.relocate('reload')){update();await persist();}};
  const rename=async(target:DocumentTab,name:string)=>{const before=target.snapshot.path;if(await target.relocate('rename',name)){setRecent(r=>[target.snapshot.path,...r.filter(p=>p!==before&&p!==target.snapshot.path)].slice(0,12));update();await persist();}flushSync(()=>setRenaming(current=>current===target.key?null:current));if(tabs.current[activeRef.current]===target)target.currentEditor?.view.focus();};
  const beginRename=(target:DocumentTab)=>{if(target.fileBusy||closingTabs.current.has(target))return;setPopup(null);setRenaming(target.key);};
  const events=useMemo(()=>tab?.records()??[],[tab,tab?.editor,tab?.changes,tab?.snapshot.revision]);
  const actualEvents=events;
  const lists=useMemo(()=>eventLists(events,now,snoozed),[events,now,snoozed]);
  const showEvents=(kind:EventListKind)=>{clearTimeout(hoverTimer.current);pinnedEvents.current=true;setEventKind(kind);setPopup(popup==='events'&&eventKind===kind?null:'events');};
  // Pointing at a status counter opens its list only after a deliberate dwell.
  const hoverEvents=(kind:EventListKind)=>{if(popup&&popup!=='events')return;clearTimeout(hoverTimer.current);hoverTimer.current=setTimeout(()=>{pinnedEvents.current=false;setEventKind(kind);setPopup('events');},300);};
  const keepEvents=()=>clearTimeout(hoverTimer.current);
  const leaveEvents=()=>{clearTimeout(hoverTimer.current);hoverTimer.current=setTimeout(()=>{if(!pinnedEvents.current)setPopup(p=>p==='events'?null:p);},300);};
  const setDone=(id:number,done:boolean)=>{tab?.editor?.setEventDone(id,done);update();};
  const complete=actualEvents.filter(e=>e.done).length;
  const selectedText=tab?.editor?.selectedRanges.length?tab.editor.selectedRanges.map(r=>editor!.state.doc.textBetween(r.from,r.to,'\n')).join('\n'):editor?.state.selection.ranges.map(r=>editor.state.doc.textBetween(r.$from.pos,r.$to.pos,'\n')).join('\n')??'';
  const localHits=useMemo(()=>hits.filter(h=>h.tab===tab?.key),[hits,tab]);
  const navigationMatches=useMemo(()=>new Set(searchActive&&query.trim()?localHits.map(hit=>hit.id):[]),[searchActive,query,localHits]);
  // A hit may live in another open file; the search itself travels with it.
  const focusHit=(hit:Hit,focus=true)=>{
    const index=tabs.current.findIndex(t=>t.key===hit.tab);if(index<0)return;
    if(index!==activeRef.current){tabs.current[index].search={query,open:searchOpen,active:searchActive,highlight,whole:wholeEvent,caseSensitive,wholeWord,allFiles};flushSync(()=>activate(index));}
    const target=tabs.current[index];if(target.isText)void target.whenReady().then(()=>{if(tabs.current[activeRef.current]===target)target.textEditor?.focusPosition(hit.id,focus);}).catch(report);else target.editor?.focusEvent(hit.id,focus);
  };
  // Right-clicking the body keeps a selection it lands inside; anywhere else it
  // moves the caret first, so the menu acts on what was pointed at.
  const openTextMenu=(e:React.MouseEvent)=>{
    if(tab?.textEditor&&(e.target as HTMLElement).closest('.markdown-document,.plain-text-document')){
      e.preventDefault();const ed=tab.textEditor.editor,at=ed.view.posAtCoords({left:e.clientX,top:e.clientY});
      if(at&&(ed.state.selection.empty||!ed.state.selection.ranges.some(r=>at.pos>=r.$from.pos&&at.pos<=r.$to.pos)))ed.commands.setTextSelection(at.pos);
      ed.view.focus();setTextMenu({x:e.clientX,y:e.clientY,list:null,continues:false,href:safeLink((e.target as HTMLElement).closest('a[href]')?.getAttribute('href')??''),eventId:null,selected:!ed.state.selection.empty});setPopup('text');return;
    }
    const target=tab?.editor;if(!target||!(e.target as HTMLElement).closest('.todo-document'))return;
    e.preventDefault();
    const view=target.editor.view,{from,to,empty}=view.state.selection,at=view.posAtCoords({left:e.clientX,top:e.clientY});
    const kept=target.selectedEvents.size>0||target.selectedRanges.length>0||(!empty&&!!at&&at.pos>=from&&at.pos<=to);
    if(!kept&&at)target.editor.commands.setTextSelection(at.pos);
    view.focus();
    const selection=view.state.selection;
    setTextMenu({x:e.clientX,y:e.clientY,list:target.listStyle(),continues:target.canContinueNumbering(),href:safeLink((e.target as HTMLElement).closest('a[href]')?.getAttribute('href')??''),eventId:target.eventAt(at?.pos??selection.from),selected:!selection.empty||target.selectedEvents.size>0||target.selectedRanges.some(r=>r.from<r.to)});
    setPopup('text');
  };
  // One grid of markers serves the toolbar menu and the right-click menu.
  const chooseListStyle=(style:ListStyle)=>{flushSync(()=>setPopup(null));tab?.editor?.setListStyle(style);};
  const listOptions=(current:ListStyle|null)=><>
    <span className="menu-caption">有序列表</span><div className="list-style-options">{orderedStyles.map(style=><button key={style} role="menuitemradio" aria-checked={current===style} className={current===style?'active':''} onClick={()=>chooseListStyle(style)}>{listStyleNames[style]}</button>)}</div>
    <span className="menu-caption">无序列表</span><div className="list-style-options bullets">{bulletStyles.map(style=><button key={style} role="menuitemradio" aria-label={bulletStyleNames[style]} aria-checked={current===style} className={current===style?'active':''} onClick={()=>chooseListStyle(style)}>{style==='disc'||style==='circle'?<span aria-hidden="true" className={'list-bullet-circle'+(style==='disc'?' filled':'')}/>:listStyleNames[style]}</button>)}</div>
  </>;
  const openListMenu=()=>{
    if(popup==='listStyle'){setPopup(null);return;}
    const anchor=document.querySelector('.toolbar button[aria-label="列表样式"]')?.getBoundingClientRect();
    setListMenu({x:anchor?.left??420,y:(anchor?.bottom??111)+4});setPopup('listStyle');
  };
  const textAction=(action:()=>unknown)=>{flushSync(()=>setPopup(null));editor?.view.focus();safely(async()=>{await action();});};
  const selectEvent=(id:number,multi=false)=>{if(multi)tab?.editor?.selectEvent(id,true);else tab?.editor?.focusEvent(id);};
  const applyLink=(event:React.FormEvent)=>{
    event.preventDefault();const href=safeLink(link);
    if(!href){report('请输入有效的 http、https 或 mailto 地址');return;}
    if(!editor)return;
    const existing=editor.isActive('link')||!!linkEndRange(editor.state);
    const {from,to,empty}=editor.state.selection;
    flushSync(()=>setPopup(null));
    if(empty&&!existing)editor.chain().focus().insertContent({type:'text',text:href,marks:[...(editor.state.storedMarks??editor.state.selection.$from.marks()).map(m=>m.toJSON()),{type:'link',attrs:{href}}]}).run();
    else editor.chain().focus().extendMarkRange('link').setLink({href}).setTextSelection({from,to}).run();
  };
  const removeLink=()=>{
    if(!editor)return;const {from,to}=editor.state.selection;
    flushSync(()=>setPopup(null));
    editor.chain().focus().extendMarkRange('link').command(({tr})=>{unlinkSelection(tr);return true;}).setTextSelection({from,to}).run();
  };
  const changeSetting=<K extends keyof Settings>(key:K,value:Settings[K])=>setSettings(s=>({...s,[key]:value}));
  const backToTop=()=>{const scroller=document.querySelector<HTMLElement>('.document-scroller[data-active]');if(!scroller)return;scroller.scrollTo({top:0,behavior:'smooth'});if(tab)tab.scroll=0;setScrolled(false);};
  return <><main onDoubleClickCapture={e=>{const target=e.target;if(target instanceof HTMLImageElement&&target.closest('.todo-document .image-view,.markdown-document .md-image')){e.preventDefault();e.stopPropagation();setImageSource(target.src);}}} onDragOver={e=>{if(Array.from(e.dataTransfer.items).some(item=>item.kind==='file'))e.preventDefault();}} onDropCapture={e=>{const files=Array.from(e.dataTransfer.files).filter(file=>isDocumentPath(file.name)&&(tab?.isPlainText||!/^image\//i.test(file.type))); if(!files.length)return;e.preventDefault();e.stopPropagation();safely(async()=>{for(const doc of await window.desktop.openDroppedFiles(files))add(doc);});}} inert={closingWindow.current} aria-busy={closingWindow.current} className={'app '+(!settings.wordWrap?'no-word-wrap ':'')+(!settings.lineNumbers?'hide-line-numbers ':'')+(settings.autoHideToolbar?'hide-toolbar':'')}>
    {imageSource&&<React.Suspense fallback={null}><ImageViewer source={imageSource} onClose={()=>setImageSource(null)}/></React.Suspense>}
    <header className="titlebar"><div className="brand"><button className="brand-icon" aria-label="打开设置菜单" title="外观与设置" aria-haspopup="dialog" aria-expanded={popup==='settings'&&settingsAtBrand} onClick={()=>toggleSettings(true)}><AlignLeft size={17}/></button>TodoLine</div><div className="title-drag"/><div className="window-actions"><button aria-label="最小化" onClick={()=>window.desktop.minimize()}><Minus size={14}/></button><button aria-label="最大化" onClick={()=>window.desktop.maximize()}><Square size={12}/></button><button aria-label="关闭窗口" className="window-close" onClick={()=>window.desktop.requestClose()}><X size={16}/></button></div></header>
    <div className="tabs"><div className="tabs-scroll" ref={tabStrip}>{tabs.current.map((t,i)=><div key={t.key} data-tab-key={t.key} onContextMenu={e=>{e.preventDefault();activate(i);setPopup('file');}} className={'file-tab '+(i===active?'active':'')}><div className="tab-label">{renaming===t.key&&<TabRename name={t.snapshot.name} onSubmit={name=>rename(t,name)} onCancel={focus=>{if(focus){flushSync(()=>setRenaming(null));t.currentEditor?.view.focus();}else setRenaming(null);}}/>}<button className="tab-name" style={renaming===t.key?{visibility:'hidden'}:undefined} onClick={()=>activate(i)} onDoubleClick={()=>beginRename(t)} title={t.snapshot.path}><FileText size={14}/><span>{t.snapshot.name.replace(/\.tde$/i,'')}</span><span className={'dirty-dot'+(t.dirty?'':' saved')} aria-hidden={!t.dirty}/></button></div><button className="tab-close" aria-label={'关闭 '+t.snapshot.name} onClick={()=>safely(()=>closeTab(i))}><X size={13}/></button></div>)}</div><Tool title="新建文档 · Ctrl+N" onClick={create}><Plus size={16}/></Tool></div>
    <div className="toolbar-zone" data-open={popup&&!(popup==='settings'&&settingsAtBrand)&&['export','settings','link','format','table','recent','listStyle'].includes(popup)?'':undefined}>
    <nav className="toolbar" aria-label="编辑工具栏">
      <Tool title="切换导航" active={settings.sidebar} onClick={()=>changeSetting('sidebar',!settings.sidebar)}>{settings.sidebar?<PanelLeftClose/>:<PanelLeftOpen/>}</Tool><Tool title="打开文档 · Ctrl+O" onClick={open}><FolderOpen/></Tool><Tool title="最近打开的文档" active={popup==='recent'} onClick={()=>{setRecentQuery('');setPopup(popup==='recent'?null:'recent');}}><History/></Tool><span className="toolbar-separator"/>
      <Tool title="撤销 · Ctrl+Z" disabled={!editor||!editor.isEditable} onClick={()=>editor?.chain().focus().undo().run()}><Undo2/></Tool><Tool title="重做 · Ctrl+Y" disabled={!editor||!editor.isEditable} onClick={()=>editor?.chain().focus().redo().run()}><Redo2/></Tool><span className="toolbar-separator"/>
      <div className="toolbar-size" title={sizedSelection?'调整选中文字的字号':'调整正文字号（未选中内容时作用于全文）'}><button aria-label="减小字号" disabled={!editor||!editor.isEditable} onMouseDown={e=>e.preventDefault()} onClick={()=>stepFontSize(-1)}>−</button><span>{toolbarFontSize?toolbarFontSize+' px':'混合'}</span><button aria-label="增大字号" disabled={!editor||!editor.isEditable} onMouseDown={e=>e.preventDefault()} onClick={()=>stepFontSize(1)}>+</button></div><span className="toolbar-separator"/><Tool title="加粗 · Ctrl+B" active={editor?.isActive('bold')} disabled={tab?.isPlainText||!editor||!editor.isEditable} onClick={()=>editor?.chain().focus().toggleBold().run()}><Bold/></Tool><Tool title="斜体 · Ctrl+I" active={editor?.isActive('italic')} disabled={tab?.isPlainText||!editor||!editor.isEditable} onClick={()=>editor?.chain().focus().toggleItalic().run()}><Italic/></Tool><Tool title="删除线" active={editor?.isActive('strike')} disabled={tab?.isPlainText||!editor||!editor.isEditable} onClick={()=>editor?.chain().focus().toggleStrike().run()}><Strikethrough/></Tool><Tool title="有序列表 · Ctrl+L" disabled={tab?.isPlainText||!editor||!editor.isEditable} onClick={()=>tab?.markdown?editor?.chain().focus().toggleOrderedList().run():tab?.editor?.toggleListLines('orderedList')}><ListOrdered/></Tool><Tool title="无序列表" disabled={tab?.isPlainText||!editor||!editor.isEditable} onClick={()=>tab?.markdown?editor?.chain().focus().toggleBulletList().run():tab?.editor?.toggleListLines('bulletList')}><List/></Tool>{!tab?.isText&&<Tool title="列表样式" active={popup==='listStyle'} disabled={tab?.isPlainText||!editor||!editor.isEditable} onClick={openListMenu}><ListTree/></Tool>}<Tool title="插入链接" disabled={tab?.isPlainText||!editor||!editor.isEditable} onClick={()=>{setLink(editor?.getAttributes('link').href??(editor&&linkEndRange(editor.state)?editor.state.selection.$from.nodeBefore?.marks.find(m=>m.type.name==='link')?.attrs.href:undefined)??'https://');setPopup(popup==='link'?null:'link');}}><Link2/></Tool>{!tab?.isText&&<Tool title="段落与字符格式" active={popup==='format'} disabled={tab?.isPlainText||!editor||!editor.isEditable} onClick={()=>setPopup(popup==='format'?null:'format')}><Pilcrow/></Tool>}<Tool title="插入图片" disabled={tab?.isPlainText||!editor||!editor.isEditable} onClick={()=>imageInput.current?.click()}><ImagePlus/></Tool><span className="toolbar-separator"/>
      {tab?.isMarkdown?<><select className="themed-select heading-select" disabled={!editor?.isEditable} aria-label="标题级别" title="Ctrl+1～6 设置标题，再按相同快捷键恢复正文" value={editor?.isActive('heading')?editor.getAttributes('heading').level:0} onChange={e=>{const level=Number(e.target.value);if(level)editor?.chain().focus().setHeading({level:level as 1|2|3|4|5|6}).run();else editor?.chain().focus().setParagraph().run();}}><option value={0}>正文</option>{[1,2,3,4,5,6].map(level=><option key={level} value={level}>标题 {level}</option>)}</select><Tool title="插入公式" disabled={!editor?.isEditable} onClick={()=>editor?.chain().focus().insertContent({type:'blockMath',attrs:{latex:'x^2'}}).run()}><Sigma/></Tool><Tool title="代码块" disabled={!editor?.isEditable} onClick={()=>editor?.chain().focus().toggleCodeBlock().run()}><SquareCode/></Tool><Tool title="插入表格" disabled={!editor?.isEditable} onClick={()=>setPopup('table')}><Table2/></Tool></>:!tab?.isPlainText&&<button className="divider-tool" disabled={tab?.isPlainText||!editor||!editor.isEditable} title="插入分隔线 · Ctrl+H" onMouseDown={e=>e.preventDefault()} onClick={()=>tab?.editor?.split()}><span>—</span> 分隔线 <kbd>Ctrl H</kbd></button>}
      <div className="toolbar-spacer"/><button className={'tool '+(settings.wordWrap?'active':'')} aria-label="自动换行" title="自动换行" aria-pressed={settings.wordWrap} onMouseDown={e=>e.preventDefault()} onClick={()=>changeSetting('wordWrap',!settings.wordWrap)}><WrapText/></button><button className="tool" aria-label="与前一个标签比较" title="与前一个标签比较" disabled={!canDiff} onMouseDown={e=>e.preventDefault()} onClick={()=>{if(canDiff){setPopup(null);setSearchOpen(false);setSearchSource(null);setDiffPair({left:previousTab,right:tab});}}}><GitCompareArrows/></button><Tool title="搜索 · Ctrl+F" active={searchOpen} onClick={()=>{setSearchSource(searchOpen?null:'window');setSearchOpen(v=>!v);}}><Search/></Tool><button className="export-button" disabled={!tab} onClick={()=>setPopup(popup==='export'?null:'export')}><ArrowDownToLine size={15}/><span>导出</span><ChevronDown size={12}/></button><Tool title="外观与设置" active={popup==='settings'} onClick={()=>toggleSettings()}><Settings2/></Tool>
    </nav>
    </div>
    <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={e=>{const files=Array.from(e.target.files??[]);if(files.length&&tab)safely(()=>tab.markdown?tab.markdown.insertImages(files):tab.editor?.insertImages(files));e.target.value='';}}/>
    <div className="workspace">
      {settings.sidebar&&<><aside className={'sidebar'+(tab?.isMarkdown?' markdown-sidebar':'')} style={{width:settings.sidebarWidth}}>{tab?.isPlainText?<nav className="markdown-outline" aria-label="文本文件信息"><div className="markdown-outline-title">纯文本</div></nav>:tab?.isMarkdown?<MarkdownOutline key={tab.key} headings={tab.markdown?.headings()??[]} active={activeHeading(tab.markdown?.headings()??[],markdownPosition)} onNavigate={pos=>{tab.markdown?.focusHeading(pos);setMarkdownPosition(pos);}}/>:<><div className="sidebar-section"><span>事件导航 <b>{actualEvents.length}</b></span><button title="仅看未完成" className={onlyPending?'accent':''} onClick={()=>setOnlyPending(v=>!v)}><CheckCheck size={15}/></button></div>{tab&&<EventNavigation key={tab.key} tab={tab} events={events} matches={navigationMatches} onlyPending={onlyPending} onNavigate={selectEvent}/>}</>}<div className="sidebar-bottom"><div className="event-filter sidebar-filter"><Search size={14}/><input ref={quickSearchRef} aria-label="快速搜索导航" placeholder={tab?.isText?'搜索正文…':'搜索正文或截止时间…'} disabled={!tab} value={query}
        onChange={e=>setQuery(e.target.value)}
        onMouseDown={e=>{selectQuickOnMouseUp.current=document.activeElement!==e.currentTarget||searchSource!=='quick';setSearchSource('quick');}}
        onFocus={e=>{setSearchSource('quick');e.currentTarget.select();selectQuickOnMouseUp.current=true;}}
        onMouseUp={e=>{if(selectQuickOnMouseUp.current){e.preventDefault();e.currentTarget.select();selectQuickOnMouseUp.current=false;}}}
        onKeyDown={e=>{selectQuickOnMouseUp.current=false;if(e.nativeEvent.isComposing)return;if(e.key==='Escape'){e.stopPropagation();setQuery('');}else if(e.key==='Enter'){e.preventDefault();run(e.shiftKey?'previousMatch':'nextMatch');}}}
        onBlur={()=>{selectQuickOnMouseUp.current=false;setSearchSource(source=>source==='quick'?null:source);}}/>
        <span className="sidebar-search-steps">{(['previousMatch','nextMatch'] as const).map((command,index)=><button key={command} type="button" aria-label={index?'下一个快速搜索结果':'上一个快速搜索结果'} title={index?'下一个匹配 · Enter':'上一个匹配 · Shift+Enter'} disabled={!hits.length}
          onMouseDown={e=>e.preventDefault()} onClick={()=>{quickSearchRef.current?.focus();autoJumped.current=JSON.stringify([allFiles?'all':tab?.key,query,caseSensitive,wholeWord,allFiles,searchActivation]);run(command);}}>{index?<ChevronDown size={13}/>:<ChevronUp size={13}/>}</button>)}</span></div><button className="sidebar-calendar" disabled={!tab} title="打开所在文件夹" aria-label="打开所在文件夹" onClick={()=>{if(tab)safely(()=>window.desktop.reveal(tab.snapshot.handle));}}><FolderOpen size={15}/></button>{!tab?.isText&&<button className="sidebar-calendar" disabled={!tab} title="按截止时间查看日历" aria-label="事件日历" onClick={()=>setPopup(popup==='calendar'?null:'calendar')}><CalendarDays size={15}/></button>}</div></aside><div className="sidebar-resize" onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))changeSetting('sidebarWidth',Math.max(180,Math.min(440,e.clientX)));}} onPointerUp={e=>e.currentTarget.releasePointerCapture(e.pointerId)}/></>}
      <section className="document-area" onContextMenu={e=>{const divider=(e.target as HTMLElement).closest<HTMLElement>('.event-divider');if(!divider){openTextMenu(e);return;}if(!tab?.editor)return;e.preventDefault();const raw=Number(divider.dataset.id),id=tab.editor.codec.resolveId(raw);if(!tab.editor.selectedEvents.has(raw))tab.editor.selectEvent(id);setEventMenu({id,x:Math.max(8,Math.min(e.clientX,innerWidth-250)),y:Math.max(8,Math.min(e.clientY,innerHeight-330))});setPopup('event');}}>
        {searchOpen&&<SearchWindow theme={settings.theme==='system'?(systemDark?'dark':'light'):settings.theme} origin={{x:Math.max(8,pointer.current.x-60),y:pointer.current.y+20}} onReady={()=>{setSearchSource('window');searchRef.current?.focus();searchRef.current?.select();}} onClose={()=>{setSearchOpen(false);setSearchSource(null);setQuery('');editor?.commands.focus();}}><div className="search-bar" onFocusCapture={()=>setSearchSource('window')} onMouseDownCapture={()=>setSearchSource('window')}><div className="search-main"><span className="search-grip" title="拖动调整搜索框位置"><GripVertical size={14}/></span><label className="search-field"><Search size={15}/><input ref={searchRef} onFocus={()=>setSearchSource('window')} aria-label="搜索内容" placeholder="搜索正文或截止时间…" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')run(e.shiftKey?'previousMatch':'nextMatch');}}/>{query&&<button className="search-clear" aria-label="清除搜索" title="清除搜索内容" onClick={()=>{setQuery('');searchRef.current?.focus();}}><X size={13}/></button>}</label><span className="search-count">{query?hits.length+(tab?.isText?' 处匹配':' 个事件')+(allFiles&&hits.length?' · '+new Set(hits.map(h=>h.tab)).size+' 个文件':''):''}</span><button className="search-step" aria-label="上一个搜索结果" disabled={!hits.length} onClick={()=>run('previousMatch')}><ChevronUp size={15}/></button><button className="search-step" aria-label="下一个搜索结果" disabled={!hits.length} onClick={()=>run('nextMatch')}><ChevronDown size={15}/></button><button aria-label="关闭搜索" onClick={()=>{setSearchOpen(false);setSearchSource(null);setQuery('');editor?.commands.focus();}}><X size={15}/></button></div><div className="search-options"><button className={'search-toggle'+(caseSensitive?' on':'')} aria-pressed={caseSensitive} aria-label="区分大小写" title="区分大小写" onClick={()=>setCaseSensitive(v=>!v)}>Aa</button><button className={'search-toggle'+(wholeWord?' on':'')} aria-pressed={wholeWord} aria-label="全词匹配" title="全词匹配：命中文字前后不能是字母、数字或汉字" onClick={()=>setWholeWord(v=>!v)}>全词</button><button className={'search-toggle'+(highlight?' on':'')} aria-pressed={highlight} title="高亮命中文字" onClick={()=>setHighlight(v=>!v)}>高亮</button><button className={'search-toggle'+(wholeEvent?' on':'')} aria-pressed={wholeEvent} disabled={!highlight||tab?.isText} aria-label="整个事件" title="整段高亮命中的事件" onClick={()=>setWholeEvent(v=>!v)}>整段</button><span className="search-scope"><button className={allFiles?'':'on'} aria-pressed={!allFiles} onClick={()=>setAllFiles(false)}>当前文件</button><button className={allFiles?'on':''} aria-pressed={allFiles} onClick={()=>setAllFiles(true)}>所有打开文件</button></span><button className="search-select" aria-label="全选命中事件" title="选中当前文件里所有命中的事件" disabled={!localHits.length||tab?.isText} onClick={()=>{tab?.editor?.selectEvents(localHits.map(h=>h.id));editor?.view.focus();}}>全选命中</button></div></div></SearchWindow>}
        {(tab?.error||tab?.snapshot.warning)&&<div className="document-warning"><span>{tab.error||tab.snapshot.warning}</span>{tab.snapshot.recoveryBackup&&<button onClick={()=>safely(()=>window.desktop.revealRecovery(tab.snapshot.handle))}>查看恢复文档</button>}{tab.error&&<><button disabled={tab.fileBusy} onClick={()=>safely(()=>tab.flush())}>重试保存</button><button disabled={tab.fileBusy} onClick={()=>safely(saveAs)}>另存为</button><button disabled={tab.fileBusy} title="先保留完整恢复文档，再加载磁盘版本" onClick={()=>safely(reload)}>重新加载</button></>}</div>}
        {[...tabs.current].sort((a,b)=>a.key-b.key).map(t=><div key={t.key} className="document-scroller" data-active={t===tab?'':undefined} inert={t.fileBusy} aria-busy={t.fileBusy} style={{display:t===tab?'block':'none'}} onScroll={e=>{t.scroll=e.currentTarget.scrollTop;if(t===tab){setScrolled(e.currentTarget.scrollTop>240);if(t.markdown){const bounds=e.currentTarget.getBoundingClientRect(),atEnd=e.currentTarget.scrollTop+e.currentTarget.clientHeight>=e.currentTarget.scrollHeight-2;const top=atEnd?bounds.bottom:bounds.top+35;let pos=0;for(const heading of t.markdown.headings()){const node=t.markdown.editor.view.nodeDOM(heading.pos);if(node instanceof HTMLElement&&node.getBoundingClientRect().top<=top)pos=heading.pos;else break;}setMarkdownPosition(pos);}}}}><Pane tab={t} active={t===tab}/></div>)}
        {tab&&scrolled&&!popup&&<button className="scroll-top" title="回到顶部" aria-label="回到顶部" onMouseDown={e=>e.preventDefault()} onClick={backToTop}><ArrowUpToLine size={16}/></button>}
        {!tab&&<div className="welcome"><div className="welcome-mark"><AlignLeft size={32}/></div><h1>TodoLine</h1><p>Ctrl + H 插入分隔线，感受新式待办的便利</p><div className="welcome-actions"><button className="primary" onClick={create}><FilePlus2 size={16}/>新建文档 <kbd>Ctrl N</kbd></button><button onClick={open}><FolderOpen size={16}/>打开文档 <kbd>Ctrl O</kbd></button></div>{loading?<p>正在恢复工作区…</p>:recent.length>0&&<div className="recent"><h3>最近打开</h3>{recent.slice(0,5).map(file=><button key={file} onClick={()=>safely(async()=>add(await window.desktop.openRecent(file)))}><FileText size={15}/><span>{file.split(/[\\/]/).pop()}</span><small>{file}</small><ChevronRight size={14}/></button>)}</div>}</div>}
      </section>
    </div>
    <footer className="statusbar"><button className={tab?.error?'save-error':''} title={tab?.backup?'已生成备份：'+tab.backup:tab?.snapshot.path} onClick={()=>tab&&safely(()=>tab.flush())}><span className={'save-dot '+(tab?.dirty?'pending':'')}/>{tab?.error?'保存失败 · 点击重试':tab?.fileBusy?'正在处理文件…':tab?.editor?.importingImages?'正在导入 '+tab.editor.importingImages+' 张图片…':tab?.saving?'正在保存…':tab?.dirty?'等待保存…':tab?'已保存到本地':'就绪'}</button>{tab?.snapshot.readOnly&&<span className="readonly-badge">只读</span>}<span className="status-divider"/>{editor?.state.selection instanceof TableRowSelection?<span className="table-row-count">已选 {editor.state.selection.rows.length} 行 · {Array.from(selectedText.replace(/\n/g,"")).length} 字</span>:selectedText?<span>已选 {Array.from(selectedText).length} 字</span>:tab&&<span>{(tab.isText?Array.from(tab.textEditor?.text()??tab.source()).length:events.reduce((n,e)=>n+Array.from(e.content_text).length,0)).toLocaleString()} 字</span>}{(tab?.editor?.selectedEvents.size??0)>0&&<span className="selection-count">已选 {tab!.editor!.selectedEvents.size} 个事件</span>}<div className="toolbar-spacer"/>{tab&&!tab.isText&&<button aria-label="全部事件" onMouseEnter={()=>hoverEvents('all')} onMouseLeave={leaveEvents} onClick={()=>showEvents('all')}><CheckCheck size={13}/>{complete} / {actualEvents.length}<span className="progress-track"><span style={{width:(actualEvents.length?complete/actualEvents.length*100:0)+'%'}}/></span></button>}{tab&&!tab.isText&&<><button aria-label="本周事件" onMouseEnter={()=>hoverEvents('week')} onMouseLeave={leaveEvents} onClick={()=>showEvents('week')}>本周 <b>{lists.week.length}</b></button><button aria-label="待提醒事件" onMouseEnter={()=>hoverEvents('pending')} onMouseLeave={leaveEvents} onClick={()=>showEvents('pending')}>待提醒 <b>{lists.pending.filter(e=>!e.done).length}</b></button><button aria-label="到期未完成事件" className={lists.overdue.length?'overdue-status':''} onMouseEnter={()=>hoverEvents('overdue')} onMouseLeave={leaveEvents} onClick={()=>showEvents('overdue')}>逾期 <b>{lists.overdue.length}</b></button></>}<button className="reminder-status" title={settings.advanceMinutes<0?'提醒已关闭，点击打开设置':'点击查看提醒设置'} onClick={()=>notices.length?safely(()=>window.desktop.showReminders()):toggleSettings()}>{settings.advanceMinutes<0?<BellOff size={12}/>:<Bell size={12}/>}{notices.length?notices.length+' 条提醒':settings.advanceMinutes<0?'提醒已关闭':'提醒已开启'}</button><button onClick={()=>changeSetting('fontSize',settings.fontSize>=22?12:settings.fontSize+1)}>{Math.round(settings.fontSize/15*100)}%</button><span className="encoding">{tab?.encoding??'UTF-8'}</span></footer>
    {popup&&<div className={"popup-backdrop"+(popup==='settings'&&settingsAtBrand?" brand-settings-backdrop":"")} onClick={()=>setPopup(null)} onContextMenu={e=>{e.preventDefault();setPopup(null);}}/>}
    {popup==='file'&&<div className="menu file-menu" aria-label="标签操作"><button onClick={()=>{setPopup(null);run('save');}}>立即保存 <small>Ctrl S</small></button><button onClick={()=>{setPopup(null);safely(saveAs);}}>另存为… <small>Ctrl Shift S</small></button><button onClick={()=>{if(tab)beginRename(tab);}}>重命名…</button><div className="menu-rule"/><button onClick={()=>{setPopup(null);if(tab)safely(()=>window.desktop.reveal(tab.snapshot.handle));}}>打开所在文件夹</button><button onClick={()=>{setPopup(null);if(tab)safely(()=>closeTab(active));}}>关闭标签 <small>Ctrl W</small></button></div>}
    {popup==='listStyle'&&<div ref={listMenuRef} className="menu list-style-menu" role="menu" aria-label="列表样式菜单" style={{left:listMenu.x,top:listMenu.y}}>{listOptions(tab?.editor?.listStyle()??null)}</div>}
    {popup==='text'&&<div ref={textMenuRef} className="menu event-context-menu text-context-menu" role="menu" aria-label="正文操作" style={{left:textMenu.x,top:textMenu.y}}><>{textMenu.href&&<button role="menuitem" onClick={()=>textAction(()=>window.desktop.openLink(textMenu.href!))}>打开链接 <ArrowUpRight size={14}/></button>}</><button role="menuitem" disabled={!editor?.isEditable||!editor?.can().undo()} onClick={()=>textAction(()=>editor?.chain().focus().undo().run())}>撤销 <small>Ctrl Z</small></button><button role="menuitem" disabled={!editor?.isEditable||!editor?.can().redo()} onClick={()=>textAction(()=>editor?.chain().focus().redo().run())}>重做 <small>Ctrl Y</small></button><div className="menu-rule"/><button role="menuitem" disabled={!editor?.isEditable||!textMenu.selected} onClick={()=>textAction(()=>tab?.textEditor?tab.textEditor.copy(true):tab?.editor?.copy(false,true))}>剪切 <small>Ctrl X</small></button><button role="menuitem" disabled={!textMenu.selected} onClick={()=>textAction(()=>tab?.textEditor?tab.textEditor.copy():tab?.editor?.copy())}>复制 <small>Ctrl C</small></button><button role="menuitem" disabled={!editor?.isEditable} onClick={()=>textAction(()=>tab?.textEditor?tab.textEditor.paste():tab?.editor?.paste())}>粘贴 <small>Ctrl V</small></button><div className="menu-rule"/><button role="menuitem" disabled={tab?.isPlainText||!editor?.isEditable} onClick={()=>textAction(()=>tab?.markdown?editor?.chain().focus().toggleOrderedList().run():tab?.editor?.toggleListLines('orderedList'))}>有序列表 <small>Ctrl L</small></button><button role="menuitem" disabled={tab?.isPlainText||!editor?.isEditable} onClick={()=>textAction(()=>tab?.markdown?editor?.chain().focus().toggleBulletList().run():tab?.editor?.toggleListLines('bulletList'))}>无序列表</button><div className="menu-rule"/>{!tab?.isText&&<button role="menuitem" disabled={!editor?.isEditable||textMenu.eventId===null||events[0]?.id===textMenu.eventId} onClick={()=>textAction(()=>tab?.editor?.moveEventToTop(textMenu.eventId!))}>置顶事件 <small>Ctrl T</small></button>}{tab?.isMarkdown&&<button role="menuitem" disabled={!editor?.isEditable} onClick={()=>textAction(()=>tab.markdown?.paste(true))}>粘贴为纯文本</button>}<button role="menuitem" onClick={()=>textAction(()=>editor?.chain().focus().selectAll().run())}>全选 <small>Ctrl A</small></button>{textMenu.list&&<><div className="menu-rule"/>{!isBulletStyle(textMenu.list)&&<div className="numbering-actions"><button role="menuitem" disabled={!editor?.isEditable||!textMenu.continues} title={textMenu.continues?'接着上一个同级列表编号':'上方没有同级的有序列表'} onClick={()=>textAction(()=>tab?.editor?.continueNumbering())}>继续编号</button><button role="menuitem" disabled={!editor?.isEditable} title="从当前项重新从 1 编号" onClick={()=>textAction(()=>tab?.editor?.restartNumbering())}>重新编号</button></div>}{listOptions(textMenu.list)}</>}</div>}
    {popup==='event'&&<div className="menu event-context-menu" role="menu" aria-label="事件操作" style={{left:eventMenu.x,top:eventMenu.y}}><span className="menu-caption">{tab?.editor?.selectedEvents.size??1} 个选中事件</span><button disabled={!editor?.isEditable||events[0]?.id===eventMenu.id} onClick={()=>{tab?.editor?.moveEventToTop(eventMenu.id);setPopup(null);}}>置顶事件 <small>Ctrl T</small></button><button disabled={!editor?.isEditable} onClick={()=>{tab?.editor?.insertEventBelow(eventMenu.id);setPopup(null);}}>在此下方插入分隔线</button><button disabled={!editor?.isEditable} onClick={()=>{setDone(eventMenu.id,!events.find(e=>e.id===eventMenu.id)?.done);setPopup(null);}}>{events.find(e=>e.id===eventMenu.id)?.done?'取消完成':'标记完成'}</button><button onClick={()=>{tab?.editor?.selectEvent(eventMenu.id);setPopup(null);}}>仅选择此事件</button><div className="menu-rule"/><button onClick={()=>{safely(()=>tab?.editor?.copy(true));setPopup(null);}}>复制事件 <small>Ctrl Shift C</small></button><button disabled={!editor?.isEditable} onClick={()=>{safely(()=>tab?.editor?.copy(true,true));setPopup(null);}}>剪切事件 <small>Ctrl Shift X</small></button><button disabled={!editor?.isEditable} onClick={()=>{safely(()=>tab?.editor?.paste());setPopup(null);}}>粘贴事件 <small>Ctrl Shift V</small></button><button className="danger" disabled={!editor?.isEditable} onClick={()=>{tab?.editor?.deleteEvents();setPopup(null);}}>删除选中事件</button></div>}
    {popup==='export'&&<div className="menu export-menu"><span className="menu-caption">导出当前文档</span>{(['md','txt','pdf'] as const).map((f,i)=><button key={f} onClick={()=>safely(()=>exportFile(f))}><FileText size={16}/><span>{['Markdown','纯文本','PDF 文档'][i]}</span><small>.{f}</small></button>)}</div>}
    {popup==='link'&&<form className="menu link-menu" onKeyDown={e=>{if(e.key==='Enter'&&e.nativeEvent.isComposing)e.preventDefault();if(e.key==='Escape'&&!e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();flushSync(()=>setPopup(null));editor?.view.focus();}}} onSubmit={applyLink}><label>链接地址<input aria-label="链接地址" autoFocus value={link} onChange={e=>setLink(e.target.value)}/></label><div><button type="button" onClick={removeLink}>移除链接</button><button className="primary">应用</button></div></form>}
    {popup==='format'&&<div className="menu format-menu" aria-label="段落与字符格式"><span className="menu-caption">段落对齐</span><div className="format-row">{([['left','左对齐',AlignLeft],['center','居中',AlignCenter],['right','右对齐',AlignRight],['justify','两端对齐',AlignJustify]] as const).map(([value,label,Icon])=><button key={value} aria-label={label} title={label} className={paragraphAlignment===value?'active':''} onMouseDown={e=>e.preventDefault()} onClick={()=>tab?.editor?.formatParagraphs(format=>({...format,textAlign:value}))}><Icon size={17}/></button>)}</div><div className="menu-rule"/><span className="menu-caption">段落缩进</span><div className="format-row"><button onMouseDown={e=>e.preventDefault()} onClick={()=>tab?.editor?.formatParagraphs(format=>({...format,qtIndent:Math.max(0,Number(format.qtIndent??0)-1)}))}>减少缩进</button><button onMouseDown={e=>e.preventDefault()} onClick={()=>tab?.editor?.formatParagraphs(format=>({...format,qtIndent:Number(format.qtIndent??0)+1}))}>增加缩进</button></div><div className="menu-rule"/><span className="menu-caption">字符位置</span><div className="format-row"><button aria-label="上标" className={editor?.isActive('superscript')?'active':''} onMouseDown={e=>e.preventDefault()} onClick={()=>editor?.chain().focus().toggleMark('superscript').run()}><Superscript size={17}/>上标</button><button aria-label="下标" className={editor?.isActive('subscript')?'active':''} onMouseDown={e=>e.preventDefault()} onClick={()=>editor?.chain().focus().toggleMark('subscript').run()}><Subscript size={17}/>下标</button></div><div className="menu-rule"/><span className="menu-caption">文字字号 {selectionFontSize?<b>{selectionFontSize} px</b>:null}</span><div className="format-row"><button aria-label="减小选中文字字号" onMouseDown={e=>e.preventDefault()} onClick={()=>tab?.editor?.changeFontSize(-1)}><AArrowDown size={17}/>减小</button><button aria-label="恢复默认字号" onMouseDown={e=>e.preventDefault()} onClick={()=>tab?.editor?.changeFontSize(null)}><ALargeSmall size={17}/>默认</button><button aria-label="增大选中文字字号" onMouseDown={e=>e.preventDefault()} onClick={()=>tab?.editor?.changeFontSize(1)}><AArrowUp size={17}/>增大</button></div><div className="menu-rule"/><span className="menu-caption">内容结构</span><div className="format-row"><button onMouseDown={e=>e.preventDefault()} className={editor?.isActive('blockquote')?'active':''} onClick={()=>editor?.chain().focus().toggleBlockquote().run()}><Quote size={17}/>引用</button><button onMouseDown={e=>e.preventDefault()} className={editor?.isActive('codeBlock')?'active':''} onClick={()=>editor?.chain().focus().toggleCodeBlock().run()}><SquareCode size={17}/>代码块</button></div><div className="format-row"><button onMouseDown={e=>e.preventDefault()} className={editor?.isActive('code')?'active':''} onClick={()=>editor?.chain().focus().toggleCode().run()}><Code size={17}/>行内代码</button><button onMouseDown={e=>e.preventDefault()} onClick={()=>setPopup('table')}><Table2 size={17}/>表格…</button></div></div>}
    {popup==='table'&&<div className="menu table-menu" aria-label="表格操作"><span className="menu-caption">表格 · Tab 切换单元格</span><button disabled={!editor?.isEditable} onMouseDown={e=>e.preventDefault()} onClick={()=>{tab?.markdown?tab.markdown.tableAction('insert'):tab?.editor?.tableAction('insert');setPopup(null);}}>插入 3 × 3 表格</button><div className="menu-rule"/>{([['rowBefore','在上方插入行'],['rowAfter','在下方插入行'],['columnBefore','在左侧插入列'],['columnAfter','在右侧插入列'],['merge','合并选中单元格'],['split','拆分单元格'],['header','切换首行表头'],['deleteRow','删除选中行'],['deleteColumn','删除选中列'],['deleteTable','删除表格']] as const).map(([action,label])=><button key={action} disabled={!editor?.isEditable||!editor.isActive('table')} className={action.startsWith('delete')?'danger':''} onMouseDown={e=>e.preventDefault()} onClick={()=>tab?.markdown?tab.markdown.tableAction(action):tab?.editor?.tableAction(action)}>{label}</button>)}</div>}
    {popup==='settings'&&<div className={"menu settings-menu"+(settingsAtBrand?" brand-settings-menu":"")} role="dialog" aria-label="外观与偏好"><h3>外观与偏好</h3><section className="new-file-directory"><div><strong>新文件保存位置</strong><button onClick={()=>safely(async()=>{const directory=await window.desktop.chooseNewFileDirectory();if(directory!==null)changeSetting('newFileDirectory',directory);})}>选择文件夹</button><button disabled={!settings.newFileDirectory} onClick={()=>changeSetting('newFileDirectory','')}>恢复默认</button></div><p title={settings.newFileDirectory}>{settings.newFileDirectory||defaultDirectory}</p></section><label>画布主题</label><div className="theme-choices">{(['dark','light','green','system'] as const).map((theme,i)=><button className={'theme-chip '+theme+' '+(settings.theme===theme?'chosen':'')} key={theme} onClick={()=>changeSetting('theme',theme)}><span/>{['深色','浅色','绿色','系统'][i]}</button>)}</div><label className="setting-row">正文字号 <div><button onClick={()=>changeSetting('fontSize',Math.max(10,settings.fontSize-1))}>−</button><span>{settings.fontSize} px</span><button onClick={()=>changeSetting('fontSize',Math.min(30,settings.fontSize+1))}>+</button><button className="setting-apply" title="清除粘贴文字自带的字号，让全部内容使用该字号" disabled={!tab||!editor?.isEditable} onClick={()=>{tab?.editor?.changeFontSize(null,'document');setPopup(null);}}>应用到全部</button></div></label><label className="setting-row">正文行距<input className="line-spacing-input" aria-label="正文行距" type="number" min="1" max="3" step="0.1" value={settings.lineSpacing} onChange={e=>{const value=e.target.valueAsNumber;if(Number.isFinite(value))changeSetting('lineSpacing',Math.round(Math.max(1,Math.min(3,value))*10)/10);}}/></label><label className="setting-row">显示行号<input type="checkbox" checked={settings.lineNumbers} onChange={e=>changeSetting('lineNumbers',e.target.checked)}/></label><label className="setting-row">工具栏自动隐藏<input type="checkbox" checked={settings.autoHideToolbar} onChange={e=>changeSetting('autoHideToolbar',e.target.checked)}/></label><label className="setting-row">关闭窗口后留在托盘<input type="checkbox" checked={settings.closeToTray} onChange={e=>changeSetting('closeToTray',e.target.checked)}/></label><label className="setting-row">提前提醒<select className="themed-select" value={settings.advanceMinutes} onChange={e=>changeSetting('advanceMinutes',Number(e.target.value))}>{[-1,0,5,10,15,30,60].map(n=><option key={n} value={n}>{n<0?'关闭提醒':n?`${n} 分钟`:'到期时'}</option>)}</select></label><div className="shortcut-note"><b>常用快捷键</b><span>分隔线 <kbd>Ctrl H</kbd></span><span>事件复制 / 剪切 / 粘贴 <kbd>Ctrl Shift C / X / V</kbd></span><span>列选择 <kbd>Alt + 拖动</kbd></span></div></div>}
    {popup==='recent'&&<div className="menu recent-menu" aria-label="最近文档" onKeyDown={e=>{
      if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key)||e.nativeEvent.isComposing)return;
      if(e.target instanceof HTMLInputElement&&e.key!=='ArrowDown')return;
      const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));if(!buttons.length)return;
      e.preventDefault();const i=buttons.indexOf(document.activeElement as HTMLButtonElement),next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next].focus();
    }}><span className="menu-caption">最近打开</span><input autoFocus aria-label="筛选最近文档" placeholder="按文件名或路径筛选" value={recentQuery} onChange={e=>setRecentQuery(e.target.value)}/><div className="recent-items">{recent.filter(file=>file.toLocaleLowerCase().includes(recentQuery.toLocaleLowerCase())).map(file=><button key={file} title={file} onContextMenu={e=>{e.preventDefault();safely(()=>window.desktop.revealRecent(file));}} onClick={()=>{setPopup(null);safely(async()=>add(await window.desktop.openRecent(file)));}}><FileText size={16}/><span><b>{file.split(/[\\/]/).at(-1)}</b><small>{file}</small></span></button>)}</div>{!recent.some(file=>file.toLocaleLowerCase().includes(recentQuery.toLocaleLowerCase()))&&<p className="recent-empty">{recent.length?'没有匹配的文档':'尚未打开文档'}</p>}</div>}
    {popup==='calendar'&&tab&&<CalendarPanel key={tab.key} events={events} now={now} onReveal={id=>{selectEvent(id);setPopup(null);}} onClose={()=>setPopup(null)}/>}
    {popup==='events'&&tab&&<EventPanel key={tab.key} events={events} kind={eventKind} now={now} snoozed={snoozed} readOnly={!!tab.snapshot.readOnly||tab.fileBusy} onDone={setDone} onReveal={id=>{selectEvent(id);setPopup(null);}} onClose={()=>setPopup(null)} onHover={keepEvents} onLeave={leaveEvents}/>}
    <Tooltip/>
    {exported&&<div className="export-done" role="dialog" aria-label="导出完成"><header><span className="export-done-mark"><Check size={15}/></span><strong>导出完成</strong><button aria-label="关闭导出提示" onClick={()=>setExported('')}><X size={15}/></button></header><p title={exported}>{exported.split(/[\\/]/).at(-1)}</p><small>{exported}</small><footer><button onClick={()=>setExported('')}>知道了</button><button className="open" onClick={()=>{setExported('');safely(()=>window.desktop.revealExport());}}><FolderOpen size={14}/>打开所在文件夹</button></footer></div>}
    {toast&&<div className="toast" role="status"><span>{toast}</span><button aria-label="关闭消息" onClick={()=>setToast('')}><X size={14}/></button></div>}
  </main>{diffPair&&<React.Suspense fallback={null}><DiffView left={diffPair.left} right={diffPair.right} fontSize={settings.fontSize} onClose={()=>setDiffPair(null)}/></React.Suspense>}</>;
}
