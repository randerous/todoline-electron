export interface Rectangle { x:number; y:number; width:number; height:number }
export function fitWindow(saved:Partial<Rectangle>|undefined,areas:Rectangle[]):Rectangle{
  const available=areas.filter(a=>a.width>0&&a.height>0);if(!available.length)available.push({x:0,y:0,width:1240,height:840});
  let area=available[0],best=0;
  if(Number.isFinite(saved?.x)&&Number.isFinite(saved?.y))for(const candidate of available){
    const overlap=Math.max(0,Math.min(saved!.x!+(saved?.width??1240),candidate.x+candidate.width)-Math.max(saved!.x!,candidate.x))*Math.max(0,Math.min(saved!.y!+(saved?.height??840),candidate.y+candidate.height)-Math.max(saved!.y!,candidate.y));
    if(overlap>best){best=overlap;area=candidate;}
  }
  const width=Math.min(area.width,Math.max(760,Number.isFinite(saved?.width)?saved!.width!:1240)),height=Math.min(area.height,Math.max(520,Number.isFinite(saved?.height)?saved!.height!:840));
  const x=best?Math.max(area.x,Math.min(saved!.x!,area.x+area.width-width)):area.x+(area.width-width)/2,y=best?Math.max(area.y,Math.min(saved!.y!,area.y+area.height-height)):area.y+(area.height-height)/2;
  return {x:Math.round(x),y:Math.round(y),width:Math.round(width),height:Math.round(height)};
}
