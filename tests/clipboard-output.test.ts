import {expect,it} from 'vitest';
import {clipboardOutput,clipboardPlainText,eventsClipboardText} from '../src/renderer/clipboard-output';
import {formatDate} from '../src/shared/deadline';
import {newEvent} from '../src/renderer/document';
it('keeps text-only HTML private including bold, lists, tables and literal image markup',()=>{
 for(const html of ['<p><b>加粗</b></p>','<ul><li>一</li></ul>','<table><tr><td>格</td></tr></table>','<pre>&lt;img src="asset:1"&gt;</pre><!-- <img src="asset:1"> -->']){
  const result=clipboardOutput({text:'文字',html});expect(result.html).toBe(html);expect(result.externalHtml).toBeUndefined();
 }
});
it('mixed TDE content embeds portable original image data only in the external HTML',()=>{
 const data=btoa(String.fromCharCode(137,80,78,71,13,10,26,10)),html='<p><b>图片说明</b><img src="asset:7" width="20"></p>',events=JSON.stringify({assets:[{name:'asset:7',data}]});
 const result=clipboardOutput({text:'图片说明[图片]',html,events});expect(new DOMParser().parseFromString(result.externalHtml!,'text/html').querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,'+data);expect(result.html).toBe(html);expect(result.events).toBe(events);
});
it('Markdown image HTML is offered externally and single-image native copy stays an image',()=>{
 const html='<p>正文<img src="data:image/png;base64,AAAA"></p>';expect(clipboardOutput({text:'正文',html}).externalHtml).toBe(html);
 expect(clipboardOutput({text:'[图片]',html,image:new Uint8Array([1])}).externalHtml).toBeUndefined();
});
it('plain Markdown text keeps formula/code content without formatting delimiters',()=>{
 expect(clipboardPlainText([{type:'heading',attrs:{level:1},content:[{type:'text',text:'标题',marks:[{type:'bold'}]}]},{type:'paragraph',content:[{type:'inlineMath',attrs:{latex:'x^2'}}]},{type:'codeBlock',attrs:{language:'js'},content:[{type:'text',text:'a()'}]},{type:'horizontalRule'}])).toBe('标题\nx^2\na()\n====');
});
it('event copy preserves each actual divider and its metadata but adds none to a leading body',()=>{
 const first={...newEvent(),created_at:1700000000,content_text:'正文'},second={...first,id:2,deadline_raw:'1天后',done:1,content_text:'待办'};
 const text=eventsClipboardText([first,second]);expect(text.startsWith('正文\n\n==== ')).toBe(true);expect(text).toContain(formatDate(first.created_at));expect(text).toContain('截止 1天后');expect(text).toContain('已完成');expect(text).toContain('====\n待办');
 expect(eventsClipboardText([{...first,top_divider:1}])).toMatch(/^==== /);
});
