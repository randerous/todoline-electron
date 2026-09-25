import {expect,it} from 'vitest';
import {initialLayout} from '../src/renderer/initial-layout';
it('keeps plugin ancestors and restores the exact host position synchronously',()=>{
 const root=document.createElement('div');root.innerHTML='<div class="document-scroller"><div></div></div><aside></aside>';document.body.append(root);
 const host=root.firstElementChild!,mount=host.firstElementChild! as HTMLElement,next=host.nextSibling;
 expect(initialLayout(mount,()=>{expect(mount.isConnected).toBe(false);expect(mount.closest('.document-scroller')).toBe(host);mount.append(document.createElement('p'));return 42;})).toBe(42);
 expect(host.parentElement).toBe(root);expect(host.nextSibling).toBe(next);expect(mount.querySelector('p')).not.toBeNull();root.remove();
});
it('restores the host even if editor initialization throws',()=>{
 const el=document.createElement('div');document.body.append(el);expect(()=>initialLayout(el,()=>{throw Error('failed');})).toThrow('failed');expect(el.isConnected).toBe(true);el.remove();
});
