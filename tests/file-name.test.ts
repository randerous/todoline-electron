import {expect,it} from 'vitest';
import {documentFileName} from '../src/shared/file-name';
it('keeps Unicode and an existing extension without allowing path input',()=>{
  expect(documentFileName('会议记录 2026')).toBe('会议记录 2026.tde');expect(documentFileName('Work.TDE')).toBe('Work.TDE');expect(documentFileName('.notes')).toBe('.notes.tde');
});
it.each(['',' ','.tde','..','name.','name ','../escape','C:\\other','bad/name','a:b','x\0y','x\ny','a?b','name|x','CON','con.txt','NUL.tde','COM1','LPT9.log','COM¹','LPT²','x'.repeat(252)])('rejects invalid Windows file name %j',name=>expect(()=>documentFileName(name)).toThrow());
it('does not confuse ordinary words with reserved device names',()=>{
  expect(documentFileName('console')).toBe('console.tde');expect(documentFileName('COM10')).toBe('COM10.tde');expect(documentFileName('x'.repeat(251))).toHaveLength(255);
});
