export function friendlyError(error:unknown):string{
  const raw=error instanceof Error?error.message:String(error);
  const detail=raw.replace(/^Error: /,'').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
  if(/^(副本已保留在 |原文件有外部变化，未删除原文件)/.test(detail))return detail;
  if(/Disk conflict|Revision conflict|modified by another connection/i.test(raw))return '文件已被其他程序修改，自动保存已停止。请另存为，或重新加载磁盘版本。';
  if(/SQLITE_FULL|disk full|ENOSPC/i.test(raw))return '磁盘空间不足，编辑内容已保留。请释放空间后重试保存。';
  if(/SQLITE_BUSY|database is locked|in.use destination|already open/i.test(raw))return '文件正在使用中。请关闭其他程序中的该文件，或选择其他文件名。';
  if(/READONLY|read.only|write access unavailable|EACCES|EPERM/i.test(raw))return '此文件无法写入，请将内容另存到有写入权限的位置。';
  if(/Duplicate event ID|Unknown persisted event|Invalid event|Unsupported editor node/i.test(raw))return '文档结构未通过保存校验，编辑内容已保留。请另存为并保留原文件。';
  if(/unrecognized|format_version|Unsupported.*schema|unsupported.*format/i.test(raw))return '此文件的格式暂不支持写入，已保留原文并以只读方式打开。';
  if(/Cannot open TodoLine|ENOENT|not a database/i.test(raw))return '无法打开文件，请确认文件仍然存在且是有效的 .tde 文档。';
  return detail;
}
