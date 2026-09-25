import {expect,it,vi} from 'vitest';
import {conversionRequest} from '../src/renderer/format-conversion';
import {newEvent} from '../src/renderer/document';
import type {DocumentTab} from '../src/renderer/runtime';
import type {DesktopAPI} from '../src/shared/types';
const image='data:image/png;base64,AQID';
it('exports embedded TDE images once and retains event metadata in Markdown',async()=>{
 window.desktop={assetPreview:vi.fn().mockResolvedValue(image)} as unknown as DesktopAPI;
 const event={...newEvent(),done:1,deadline_raw:'明天',content_html:'<p><strong>正文</strong><img src="asset:1" /><img src="asset:1" /></p>',content_text:'正文'};
 const result=await conversionRequest({snapshot:{handle:'a',revision:2},records:()=>[event]} as unknown as DocumentTab,'a.md');
 expect(result.source).toContain('**正文**');expect(result.source).toContain(image);expect(result.source).toContain('已完成');expect(result.source).toContain('截止 明天');expect(window.desktop.assetPreview).toHaveBeenCalledTimes(1);
});
it('embeds images in preserved opaque HTML instead of leaving orphaned database references',async()=>{
 window.desktop={assetPreview:vi.fn().mockResolvedValue(image)} as unknown as DesktopAPI;
 const event={...newEvent(),content_html:'<p><ruby>正文<rt>备注</rt></ruby><img src="asset:9" /></p>',content_text:'正文备注'};
 const result=await conversionRequest({snapshot:{handle:'a',revision:0},records:()=>[event]} as unknown as DocumentTab,'a.md');
 expect(result.source).toContain(image);expect(result.source).toContain('<ruby>');expect(result.source).not.toContain('asset:9');
});
it('imports plain text literally and Markdown local images with source-preserving backups',async()=>{
 const plain=await conversionRequest({snapshot:{handle:'t',revision:0},source:()=>'<b>literal</b>\r\n\t  '} as unknown as DocumentTab,'a.tde');
 expect(plain.events![0].content_text).toBe('<b>literal</b>\r\n\t  ');expect(plain.events![0].content_html).toContain('&lt;b&gt;literal&lt;/b&gt;');
 window.desktop={markdown:{readAsset:vi.fn().mockResolvedValue(image)},imageInfo:vi.fn().mockResolvedValue({width:1,height:1})} as unknown as DesktopAPI;
 const result=await conversionRequest({snapshot:{handle:'md',revision:0},markdown:{text:()=> '内容',html:()=>'<p><b>内容</b><img src="pic.png" /></p>'}} as unknown as DocumentTab,'a.tde');
 expect(result.references).toEqual(['pic.png']);expect(result.assets![0].data).toEqual(new Uint8Array([1,2,3]));expect(result.events![0].content_html).toContain('asset:1');
});
