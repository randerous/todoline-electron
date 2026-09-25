// https://learn.microsoft.com/windows/win32/fileio/naming-a-file
export function documentFileName(value:string,extension:string='tde'):string{
  if(typeof value!=='string'||!value.trim())throw new Error('请输入文件名。');
  if(/[<>:"/\\|?*\x00-\x1f]/.test(value))throw new Error('文件名不能包含路径或 < > : " / \\ | ? * 等字符。');
  if(/[ .]$/.test(value))throw new Error('文件名不能以空格或句点结尾。');
  const suffix=extension?'.'+extension:'',name=value.toLowerCase().endsWith(suffix.toLowerCase())?value:value+suffix;
  if(suffix&&!name.slice(0,-suffix.length).trim())throw new Error('请输入扩展名前的文件名。');
  if(/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name))throw new Error('该名称为 Windows 保留名称，请换一个文件名。');
  if(name.length>255)throw new Error('文件名过长，请缩短到 255 个字符以内（含扩展名）。');
  return name;
}
