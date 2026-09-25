import type {Node} from '@tiptap/pm/model';
import type {EditRange} from './async-editing';
const graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const modifierKeys=['control','meta','alt','altgraph','shift','capslock','numlock','scrolllock','os','fn'];
/** A key that only changes how other keys are read and never types anything. */
export function isModifierKey(event:KeyboardEvent){return modifierKeys.includes(event.key.toLowerCase());}
export function leavesRangeMode(event:KeyboardEvent){
  const key=event.key.toLowerCase();
  // An input method reports the keys it keeps for itself as Process (keyCode 229), and Windows can
  // report Unidentified while Alt is held. Neither is a shortcut, so neither leaves column mode.
  if(isModifierKey(event)||key==='process'||key==='unidentified'||event.keyCode===229)return false;
  return ['home','end','enter','escape','pageup','pagedown'].includes(key)||key.startsWith('arrow')||key==='tab'&&event.shiftKey||event.altKey||(event.ctrlKey||event.metaKey)&&!['c','x','v'].includes(key);
}
export function columnDeleteRange(doc:Node,range:EditRange,direction:-1|1):EditRange{
  if(range.from!==range.to||range.row)return range;
  const pos=doc.resolve(range.from);if(!pos.parent.isTextblock)return range;
  const text=pos.parent.textBetween(0,pos.parent.content.size,'','\uFFFC'),offset=pos.parentOffset;
  let found:{index:number;segment:string}|undefined;
  for(const segment of graphemes.segment(text)){
    if(direction<0){if(segment.index>=offset)break;found=segment;}
    else if(segment.index+segment.segment.length>offset){found=segment;break;}
  }
  if(!found||/[\r\n]/.test(found.segment))return range;
  return {from:pos.start()+found.index,to:pos.start()+found.index+found.segment.length};
}
