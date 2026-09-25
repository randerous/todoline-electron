import {expect,it} from 'vitest';
import {friendlyError} from '../src/renderer/errors';
it('keeps the recovery-copy path when its underlying migration error is a permission failure',()=>{
  const detail='副本已保留在 E:\\notes\\copy.tde，提醒记录未迁移，原文件未删除。EACCES: permission denied';
  expect(friendlyError(new Error(`Error invoking remote method 'tl:rename': Error: ${detail}`))).toBe(detail);
});
it('keeps the backup location after a post-copy conflict and translates ordinary save failures',()=>{
  const detail='原文件有外部变化，未删除原文件。副本已保留在 E:\\copy.tde。Disk conflict';
  expect(friendlyError(detail)).toBe(detail);expect(friendlyError(new Error('EACCES'))).toContain('无法写入');expect(friendlyError('Disk conflict')).toContain('已被其他程序修改');
});
