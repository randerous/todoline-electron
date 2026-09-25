export function imageMime(bytes:Uint8Array):string {
  const starts=(values:number[])=>values.every((n,i)=>bytes[i]===n);
  const tag=(from:number,to:number)=>String.fromCharCode(...bytes.subarray(from,to));
  if(starts([137,80,78,71,13,10,26,10]))return 'image/png';
  if(starts([255,216,255]))return 'image/jpeg';
  if(/^GIF8[79]a$/.test(tag(0,6)))return 'image/gif';
  if(tag(0,4)==='RIFF'&&tag(8,12)==='WEBP')return 'image/webp';
  if(starts([66,77]))return 'image/bmp';
  if(starts([0,0,1,0]))return 'image/x-icon';
  if(starts([73,73,42,0])||starts([77,77,0,42]))return 'image/tiff';
  return 'application/octet-stream';
}
