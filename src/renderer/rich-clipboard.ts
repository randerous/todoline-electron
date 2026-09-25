import {inertDocument,parseQtHtml} from './codec';

// This path is only used for Qt-marked rich text or a clipboard without plain
// text. Ordinary external text retains the original application's plain default.
export function parseRichClipboard(html:string){
  if(html.length>160*1024*1024)throw new Error('剪贴板 HTML 过大，请分批复制。');
  const {document,root}=inertDocument(html),images:Uint8Array[]=[];
  for(const element of root.querySelectorAll('img')){
    const src=element.getAttribute('src')??'';
    if(/^asset:/i.test(src))throw new Error('剪贴板只有旧版图片引用，未携带原图。请在旧版中复制整个事件，或单独复制图片后重试。');
    const match=/^data:image\/(?:png|jpe?g|gif|webp|bmp|x-ms-bmp|tiff?|x-icon|vnd\.microsoft\.icon);base64,([a-z0-9+/=\s]+)$/i.exec(src);
    if(!match)throw new Error('剪贴板图片未包含原图数据，未插入不完整内容。请单独复制图片或使用图片文件插入。');
    const encoded=match[1].replace(/\s/g,'');
    if(encoded.length>Math.ceil(100*1024*1024/3)*4)throw new Error('剪贴板图片过大，请分批复制。');
    let binary:string;try{binary=atob(encoded);}catch{throw new Error('剪贴板图片编码无效，未插入内容。');}
    if(!binary.length)throw new Error('剪贴板图片为空。');
    images.push(Uint8Array.from(binary,c=>c.charCodeAt(0)));element.setAttribute('src',`asset:${images.length}`);
  }
  const template=document.createElement('template');template.content.append(root);
  const parsed=parseQtHtml(template.innerHTML);
  if(parsed.readOnly)throw new Error(`剪贴板内容无法完整转换，未修改正文。${parsed.reason}`);
  // Comments, document headers and scripts alone are an empty clipboard, not a
  // request to replace the current selection with an empty paragraph.
  const empty=parsed.content.length===1&&parsed.content[0].type==='paragraph'&&!parsed.content[0].content?.length;
  return {content:parsed.content,images,empty};
}
