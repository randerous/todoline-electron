/** Markers a list can carry. Qt stores all but `circled` natively. */
export type ListStyle='decimal'|'paren'|'circled'|'lower-alpha'|'upper-alpha'|'lower-roman'|'upper-roman'|'disc'|'circle'|'square';

export const MAX_LIST_DEPTH=5;
export const orderedStyles:readonly ListStyle[]=['decimal','paren','circled','lower-alpha'];
export const bulletStyles:readonly ListStyle[]=['square','disc','circle'];
export const listStyleNames:Record<ListStyle,string>={
  decimal:'1. 2. 3.',paren:'(1) (2) (3)',circled:'① ② ③','lower-alpha':'a. b. c.','upper-alpha':'A. B. C.',
  'lower-roman':'i. ii. iii.','upper-roman':'I. II. III.',square:'■',disc:'●',circle:'○',
};
/** Spoken names for the bullet glyphs, which show no text of their own. */
export const bulletStyleNames:Partial<Record<ListStyle,string>>={square:'实心方块',disc:'实心圆点',circle:'空心圆点'};
const known=new Set<string>(Object.keys(listStyleNames));

export const isListStyle=(value:unknown):value is ListStyle=>typeof value==='string'&&known.has(value);
export const isBulletStyle=(style:ListStyle)=>style==='disc'||style==='circle'||style==='square';

/** Tab opens each new level with the next marker in this sequence. */
export function levelStyle(level:number):ListStyle{
  return (['decimal','paren','circled','square','disc'] as const)[Math.min(Math.max(level,1),MAX_LIST_DEPTH)-1];
}

/** Bullet lists cycle ● ○ ■ by level, the way word processors nest them. */
export function bulletLevelStyle(level:number):ListStyle{
  return (['disc','circle','square'] as const)[(Math.max(level,1)-1)%3];
}

/** The marker a list actually shows; a missing style means the Qt default. */
export function effectiveStyle(type:'orderedList'|'bulletList',style:unknown):ListStyle{
  if(isListStyle(style)&&isBulletStyle(style)===(type==='bulletList'))return style;
  return type==='bulletList'?'disc':'decimal';
}

/** Stored attribute value: defaults stay absent so existing documents keep identical JSON. */
export function storedStyle(type:'orderedList'|'bulletList',style:ListStyle):ListStyle|null{
  return style===effectiveStyle(type,null)?null:style;
}

const roman=(n:number)=>{
  if(n<1||n>3999)return String(n);
  const table:[number,string][]=[[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],[50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']];
  let rest=n,out='';for(const [value,text] of table)while(rest>=value){out+=text;rest-=value;}
  return out;
};
const alpha=(n:number)=>{
  if(n<1)return String(n);
  let rest=n,out='';while(rest>0){rest--;out=String.fromCharCode(97+rest%26)+out;rest=Math.floor(rest/26);}
  return out;
};

/** Plain-text marker, including the trailing space. Circled numbers stop at ⑳ like the canvas. */
export function listMarker(style:ListStyle,n:number,prefix?:string|null,suffix?:string|null):string{
  switch(style){
    case 'paren':return `(${n}) `;
    case 'circled':return n>=1&&n<=20?String.fromCharCode(0x245f+n)+' ':`${n}. `;
    case 'lower-alpha':return `${alpha(n)}. `;
    case 'upper-alpha':return `${alpha(n).toUpperCase()}. `;
    case 'lower-roman':return `${roman(n)}. `;
    case 'upper-roman':return `${roman(n).toUpperCase()}. `;
    case 'square':return '■ ';
    case 'circle':return '○ ';
    case 'disc':return '- ';
    default:return `${prefix??''}${n}${suffix??'.'} `;
  }
}
