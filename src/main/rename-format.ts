import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {DatabaseClient} from './rpc';
import type {MarkdownStore} from './markdown-store';
import {documentFileName} from '../shared/file-name';
import {isTextDocument,isTdePath,type NativeDocumentSnapshot,type FormatRenameRequest} from '../shared/native-document';
import type {DocumentSnapshot,AssetInput,SaveResult} from '../shared/types';
import {imageInfo} from './image-codec';

/** Build and open a complete replacement before releasing the source file. */
export async function renameFormat(request:FormatRenameRequest,original:NativeDocumentSnapshot,db:DatabaseClient,markdown:MarkdownStore,recoveryRoot:string):Promise<NativeDocumentSnapshot>{
 const to=path.join(path.dirname(original.path),documentFileName(request.name,'')),toTde=isTdePath(to),fromText=isTextDocument(original);
 if(toTde!==fromText)throw new Error('此操作仅用于 TDE 与文本格式转换。');
 if(original.readOnly||original.revision!==request.revision)throw new Error('文件只读或版本已变化，未转换。');
 if(await fs.lstat(to).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw new Error('同一文件夹中已有该名称，请换一个文件名。');
 if(toTde&&(!Array.isArray(request.events)||!request.events.length))throw new Error('转换内容为空。');
 if(!toTde&&typeof request.source!=='string')throw new Error('无效文本内容。');
 const unchanged=()=>fromText?markdown.verifyUnchanged(original.handle,request.revision):db.call('save',{handle:original.handle,revision:original.revision,events:original.events});
 await unchanged();
 const backup=path.join(recoveryRoot,randomUUID(),original.name);await fs.mkdir(path.dirname(backup),{recursive:true});
 if(fromText){const copy=await markdown.saveAs({handle:original.handle,revision:original.revision,source:original.source,assets:request.references},backup);await markdown.close(copy.handle);}
 else{const copy=await db.call<DocumentSnapshot>('saveAs',{handle:original.handle,revision:original.revision,events:original.events},backup,false);await db.call('close',copy.handle);}
 const staging=await fs.mkdtemp(path.join(path.dirname(to),'.todoline-convert-')),staged=path.join(staging,path.basename(to));
 let stagedHandle:string|undefined,destination:NativeDocumentSnapshot|undefined;
 try{
  if(toTde){
   const doc=await db.call<DocumentSnapshot>('open',staged,true);stagedHandle=doc.handle;
   const assets:AssetInput[]=[],ids=new Set<number>();let bytes=0;
   for(const asset of request.assets??[]){
    if(!Number.isSafeInteger(asset.id)||asset.id<=0||ids.has(asset.id)||!(asset.data instanceof Uint8Array)||(bytes+=asset.data.length)>512*1024*1024)throw new Error('无效图片数据。');
    ids.add(asset.id);const size=await imageInfo(asset.data);assets.push({data:asset.data,w:size.width,h:size.height});
   }
   const mapped=assets.length?await db.call<number[]>('addAssets',doc.handle,assets):[],map=new Map((request.assets??[]).map((asset,i)=>[asset.id,mapped[i]]));
   const events=request.events!.map(e=>({...e,content_html:e.content_html.replace(/src="asset:(\d+)"/g,(_all,id)=>{const mapped=map.get(Number(id));if(mapped===undefined)throw new Error('图片引用缺失，未转换。');return `src="asset:${mapped}"`;})}));
   await db.call<SaveResult>('save',{handle:doc.handle,revision:doc.revision,events});await db.call('close',doc.handle);stagedHandle=undefined;
  }else{
   const doc=await markdown.create(staged,request.source!,false);stagedHandle=doc.handle;await markdown.close(doc.handle);stagedHandle=undefined;
  }
  await unchanged();await fs.link(staged,to);
  destination=toTde?await db.call<DocumentSnapshot>('open',to):await markdown.open(to);
  await unchanged();
 }catch(error){
  if(destination){if(toTde)await db.call('close',destination.handle);else await markdown.close(destination.handle);}
  throw new Error(`格式转换未完成，原文件保留；恢复副本：${backup}。${String(error)}`);
 }finally{
  if(stagedHandle){if(toTde)await db.call('close',stagedHandle).catch(()=>{});else await markdown.close(stagedHandle).catch(()=>{});}
  await fs.rm(staging,{recursive:true,force:true}).catch(()=>{});
 }
 // The replacement is now fully usable. Cleanup failures are reported without
 // sending the renderer back to a source handle that has already been closed.
 destination!.recoveryBackup=backup;
 try{
  if(fromText)await markdown.close(original.handle);else await db.call('close',original.handle);
  await fs.unlink(original.path);
 }catch(error){destination!.warning='原文件无法移除，已保留两份文件：'+String(error);}
 if(isTextDocument(destination!))markdown.annotate(destination!.handle,{warning:destination!.warning,recoveryBackup:backup});
 return destination!;
}
