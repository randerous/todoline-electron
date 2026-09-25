import {BrowserWindow,ipcMain,screen} from 'electron';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import type {Notice,ReminderAction,ReminderView} from '../shared/types';

export class ReminderWindow {
  private window?:BrowserWindow;
  private loaded=false;
  private notices:Notice[]=[];
  private theme:ReminderView['theme']='dark';
  private error='';
  private busy=false;
  private blocked=false;
  private hover=false;
  private focused=false;
  private remaining=45000;
  private started=0;
  private timer?:ReturnType<typeof setTimeout>;
  private destroyed=false;
  private loading?:Promise<void>;
  constructor(private action:(notice:Notice,action:ReminderAction,snoozeText?:string)=>Promise<void>,private report:(message:string)=>void){
    const handle=(name:string,fn:(...args:any[])=>unknown)=>ipcMain.handle(`tl:reminder:${name}`,(event,...args)=>{
      if(!this.window||event.sender!==this.window.webContents||event.senderFrame!==this.window.webContents.mainFrame)throw new Error('无效提醒窗口来源');
      return fn(...args);
    });
    handle('ready',()=>{this.loaded=true;this.render();});
    handle('action',(id:string,action:ReminderAction,snoozeText?:string)=>this.perform(id,action,snoozeText));
    handle('pause',(value:boolean)=>{this.hover=value===true;this.clock();});
    screen.on('display-removed',this.position);screen.on('display-metrics-changed',this.position);
  }
  private position=()=>{
    if(!this.window||this.window.isDestroyed())return;
    const area=screen.getPrimaryDisplay().workArea,width=Math.min(420,area.width-24),height=Math.min(256,area.height-24);
    this.window.setBounds({x:area.x+area.width-width-12,y:area.y+12,width,height});
  };
  private async ensure(){
    if(this.window&&!this.window.isDestroyed())return;
    if(this.loading)return this.loading;
    this.loading=(async()=>{
      const win=new BrowserWindow({width:420,height:256,show:false,frame:false,resizable:false,maximizable:false,minimizable:false,skipTaskbar:true,alwaysOnTop:true,backgroundColor:'#242a34',title:'TodoLine 提醒',webPreferences:{preload:path.join(__dirname,'reminder-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
      this.window=win;this.loaded=false;this.position();
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
      win.on('focus',()=>{this.focused=true;this.clock();});win.on('blur',()=>{this.focused=false;this.clock();});
      win.on('close',event=>{if(!this.destroyed){event.preventDefault();const first=this.notices[0];if(first)void this.perform(first.id,'dismiss');else win.hide();}});
      win.webContents.on('render-process-gone',()=>{this.stop();win.destroy();this.window=undefined;this.loaded=false;this.report('提醒窗口意外关闭，未处理提醒已保留，将重新显示。');});
      await win.loadFile(path.join(__dirname,'../renderer/reminder.html'));
    })().finally(()=>{this.loading=undefined;});
    return this.loading;
  }
  async update(notices:Notice[],theme:ReminderView['theme']){
    if(this.destroyed)return;
    if(notices[0]?.id!==this.notices[0]?.id){this.stop();this.remaining=45000;this.error='';}
    if(!notices.length){this.hover=false;this.focused=false;}
    this.notices=notices;this.theme=theme;
    if(notices.length)await this.ensure();
    this.render();
  }
  private render(){
    if(!this.window||this.window.isDestroyed()||!this.loaded)return;
    this.window.webContents.send('tl:reminder:state',{notice:this.notices[0],count:this.notices.length,theme:this.theme,error:this.error,busy:this.busy} satisfies ReminderView);
    if(this.notices.length&&!this.blocked){if(!this.window.isVisible()){this.position();this.window.showInactive();}}else this.window.hide();
    this.clock();
  }
  private stop(){if(this.timer){clearTimeout(this.timer);this.timer=undefined;this.remaining=Math.max(0,this.remaining-(performance.now()-this.started));}}
  private clock(){
    this.stop();if(!this.loaded||!this.notices.length||this.blocked||this.hover||this.focused||this.busy||this.error)return;
    this.started=performance.now();this.timer=setTimeout(()=>{this.timer=undefined;void this.perform(this.notices[0].id,'dismiss');},this.remaining);
  }
  block(value:boolean){this.blocked=value;this.render();}
  show(){if(this.notices.length&&!this.blocked){this.window?.show();this.window?.focus();}}
  private async perform(id:string,action:ReminderAction,snoozeText?:string){
    if(this.busy)return;
    const notice=this.notices[0];if(!notice||notice.id!==id)return;
    if(!['open','done','snooze','dismiss'].includes(action))throw new Error('无效提醒操作');
    this.busy=true;this.error='';this.render();
    try{await this.action(notice,action,snoozeText);}
    catch(error){this.error=error instanceof Error?error.message:String(error);}
    finally{this.busy=false;this.render();}
  }
  destroy(){this.destroyed=true;this.stop();for(const name of ['ready','action','pause'])ipcMain.removeHandler(`tl:reminder:${name}`);screen.removeListener('display-removed',this.position);screen.removeListener('display-metrics-changed',this.position);this.window?.destroy();}
}
