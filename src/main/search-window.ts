import {BrowserWindow,Menu,screen} from 'electron';

export function installSearchWindow(owner:BrowserWindow){
  let search:BrowserWindow|undefined;
  owner.webContents.setWindowOpenHandler(({url,frameName})=>{
    if(url!=='about:blank'||frameName!=='todoline-search'||search&&!search.isDestroyed())return {action:'deny'};
    return {action:'allow',overrideBrowserWindowOptions:{parent:owner,frame:false,show:false,width:620,height:96,resizable:false,maximizable:false,minimizable:false,fullscreenable:false,skipTaskbar:true,backgroundColor:'#1d2128',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,spellcheck:false,backgroundThrottling:false}}};
  });
  owner.webContents.on('did-create-window',(child,{frameName})=>{
    if(frameName!=='todoline-search'){child.destroy();return;}
    search=child;child.setParentWindow(owner);child.setMenu(Menu.getApplicationMenu());child.setMenuBarVisibility(false);
    const bounds=child.getBounds(),area=screen.getDisplayNearestPoint({x:bounds.x,y:bounds.y}).workArea;
    child.setPosition(Math.round(Math.max(area.x,Math.min(bounds.x,area.x+area.width-bounds.width))),Math.round(Math.max(area.y,Math.min(bounds.y,area.y+area.height-bounds.height))));
    child.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    child.webContents.on('will-navigate',event=>event.preventDefault());
    const focused=(value:boolean)=>{if(!owner.isDestroyed())owner.webContents.send('tl:searchFocus',value);};
    child.on('focus',()=>focused(true));child.on('blur',()=>focused(false));
    const hide=()=>child.hide(),show=()=>{if(!owner.isMinimized())child.showInactive();};
    owner.on('hide',hide);owner.on('minimize',hide);owner.on('show',show);owner.on('restore',show);
    child.on('closed',()=>{if(search===child)search=undefined;owner.removeListener('hide',hide);owner.removeListener('minimize',hide);owner.removeListener('show',show);owner.removeListener('restore',show);});
  });
  return ()=>{if(search&&!search.isDestroyed()){search.show();search.focus();}};
}
