export type ImageInput=Uint8Array|Promise<Uint8Array>|Pick<File,'name'|'arrayBuffer'>;
export function imageFiles(files:FileList|readonly File[]|undefined|null):File[]{
  return Array.from(files??[]).filter(file=>file.type.startsWith('image/')||/\.(png|jpe?g|gif|bmp|webp|tiff?|avif|ico|svg)$/i.test(file.name));
}
