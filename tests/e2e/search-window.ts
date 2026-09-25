import {expect,type ElectronApplication,type Page} from '@playwright/test';
export async function searchWindow(app:ElectronApplication):Promise<Page>{
  await expect.poll(()=>app.windows().some(p=>p.url()==='about:blank')).toBe(true);
  const page=app.windows().find(p=>p.url()==='about:blank')!;
  await expect(page.getByRole('textbox',{name:'搜索内容'})).toBeVisible();return page;
}
