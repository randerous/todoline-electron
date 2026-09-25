import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultSettings, type SessionData } from '../shared/types';

const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const number=(value:unknown,fallback:number,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,Math.round(value))):fallback;
const bool=(value:unknown,fallback:boolean)=>typeof value==='boolean'?value:fallback;
const validPath=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<32768&&!value.includes('\0')&&path.isAbsolute(value);
export function normalizeSession(value:unknown):SessionData{
  const raw=object(value),settings=object(raw.settings),seen=new Set<string>();
  const originalTabs=Array.isArray(raw.tabs)?raw.tabs:[];
  const activePath=object(originalTabs[number(raw.active,0,0,Math.max(0,originalTabs.length-1))]).path;
  const tabs=originalTabs.flatMap(item=>{const t=object(item);if(!validPath(t.path)||seen.has(t.path.toLowerCase()))return [];seen.add(t.path.toLowerCase());return [{path:t.path,cursor:number(t.cursor,1,0,Number.MAX_SAFE_INTEGER),scroll:number(t.scroll,0,0,Number.MAX_SAFE_INTEGER)}];});
  const recent:string[]=[];for(const file of Array.isArray(raw.recent)?raw.recent:[])if(validPath(file)&&!recent.some(p=>p.toLowerCase()===file.toLowerCase()))recent.push(file);
  const b=object(raw.bounds),bounds=typeof b.width==='number'&&Number.isFinite(b.width)&&typeof b.height==='number'&&Number.isFinite(b.height)?{width:number(b.width,1240,300,32768),height:number(b.height,840,240,32768),...(typeof b.x==='number'&&Number.isFinite(b.x)&&typeof b.y==='number'&&Number.isFinite(b.y)?{x:number(b.x,0,-1000000,1000000),y:number(b.y,0,-1000000,1000000)}:{})}:undefined;
  return {settings:{
    newFileDirectory:validPath(settings.newFileDirectory)?path.normalize(settings.newFileDirectory):'',
    theme:['dark','light','green','system'].includes(settings.theme as string)?settings.theme as SessionData['settings']['theme']:defaultSettings.theme,
    lineSpacing:typeof settings.lineSpacing==='number'&&Number.isFinite(settings.lineSpacing)?Math.round(Math.max(1,Math.min(3,settings.lineSpacing))*10)/10:defaultSettings.lineSpacing,
    fontSize:number(settings.fontSize,defaultSettings.fontSize,10,30),sidebarWidth:number(settings.sidebarWidth,defaultSettings.sidebarWidth,180,440),
    sidebar:bool(settings.sidebar,defaultSettings.sidebar),lineNumbers:bool(settings.lineNumbers,defaultSettings.lineNumbers),closeToTray:bool(settings.closeToTray,defaultSettings.closeToTray),advanceMinutes:number(settings.advanceMinutes,defaultSettings.advanceMinutes,-1,1440),autoHideToolbar:bool(settings.autoHideToolbar,defaultSettings.autoHideToolbar),wordWrap:bool(settings.wordWrap,defaultSettings.wordWrap),
  },tabs,recent:recent.slice(0,12),active:validPath(activePath)?Math.max(0,tabs.findIndex(t=>t.path.toLowerCase()===activePath.toLowerCase())):0,bounds,maximized:bool(raw.maximized,false),nextDraft:number(raw.nextDraft,1,1,1000000000),
    newFileSequence:{date:/^\d{8}$/.test(String(object(raw.newFileSequence).date))?String(object(raw.newFileSequence).date):'',next:number(object(raw.newFileSequence).next,0,0,Number.MAX_SAFE_INTEGER-1)},
    autoNamedDocuments:(Array.isArray(raw.autoNamedDocuments)?raw.autoNamedDocuments:[]).flatMap(item=>{const entry=object(item);return validPath(entry.path)&&typeof entry.identity==='string'&&/^\d+:\d+:\d+(?:\.\d+)?$/.test(entry.identity)?[{path:entry.path,identity:entry.identity}]:[];}),
  };
}

export class SessionStore {
  data: SessionData = normalizeSession({});
  firstRun=true;
  warning='';
  private committed?:string;
  private preserveFailed=false;
  constructor(private root: string,private onRecentChanged?:(paths:string[])=>void) {
    try{fs.mkdirSync(root,{recursive:true});}catch{this.firstRun=false;this.warning='配置目录暂时无法写入，请检查目录权限。';}
    for(const name of ['session.json','session.json.bak']){
      let raw:string;
      try{raw=fs.readFileSync(path.join(root,name),'utf8');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){this.firstRun=false;this.warning='无法读取配置文件，将尝试恢复备用会话。';}continue;}
      this.firstRun=false;
      try{
        const saved=JSON.parse(raw);if(saved===null||typeof saved!=='object'||Array.isArray(saved))throw new Error('Invalid session object');
        this.data=normalizeSession(saved);this.committed=JSON.stringify(this.data,null,2);
        if(name.endsWith('.bak'))this.warning='配置文件无法读取，已恢复上一份有效会话。';
        return;
      }catch{
        const preserved=path.join(root,`session.corrupt-${randomUUID()}.json`);
        try{fs.copyFileSync(path.join(root,name),preserved,fs.constants.COPYFILE_EXCL);this.warning=`配置文件已损坏，原内容保留在 ${preserved}。`;}
        catch{this.preserveFailed=true;this.warning='配置文件已损坏，当前使用默认设置。原文件暂时无法另存备份。';}
      }
    }
  }
  update(update: Partial<SessionData>) {
    if(this.preserveFailed)throw new Error('损坏的配置文件尚未备份，暂不覆盖原文件。请检查配置目录权限并重新打开程序。');
    const data=normalizeSession({...this.data,...update,settings:{...this.data.settings,...object(update.settings)}}),serialized=JSON.stringify(data,null,2);
    if(serialized===this.committed&&!this.warning)return;
    if(this.committed)this.write('session.json.bak',this.committed);
    this.write('session.json',serialized);const recentChanged=JSON.stringify(this.data.recent)!==JSON.stringify(data.recent);this.data=data;this.committed=serialized;this.warning='';
    if(recentChanged)this.onRecentChanged?.([...data.recent]);
  }
  private write(name:string,contents:string){
    const file=path.join(this.root,name),temp=file+'.tmp';
    const fd=fs.openSync(temp,'w');try{fs.writeFileSync(fd,contents);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,file);
  }
  recent(file:string) { this.update({recent:[file,...this.data.recent.filter(p=>p.toLowerCase()!==file.toLowerCase())].slice(0,12)}); }
}
