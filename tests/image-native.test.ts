// @vitest-environment node
import {beforeAll,describe,expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {imageFixtures,rawTiff} from './fixtures/image-formats';
// The helper is a Windows WIC decoder built from src/native/image-codec.cpp.
const windowsOnly = process.platform !== 'win32';
beforeAll(()=>{if(windowsOnly)return;execFileSync(process.execPath,['scripts/build-image-codec.mjs'],{windowsHide:true,timeout:30000});},35000);
function decode(input:Buffer){return spawnSync('out/main/image-codec.exe',[],{input,windowsHide:true,maxBuffer:1024*1024,timeout:10000});}
it.skipIf(windowsOnly).each(imageFixtures)('native preview decodes $name at the original pixel size',image=>{
  const result=decode(image.buffer);expect(result.error).toBeUndefined();expect(result.status).toBe(0);
  expect(result.stdout.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  expect([result.stdout.readUInt32BE(16),result.stdout.readUInt32BE(20)]).toEqual([image.width,image.height]);
});
it.skipIf(windowsOnly)('rejects corrupt and truncated TIFF without producing a partial preview',()=>{for(const bytes of [Buffer.alloc(0),Buffer.from('bad'),imageFixtures[0].buffer.subarray(0,16)]){const r=decode(bytes);expect(r.status).toBe(2);expect(r.stdout.length).toBe(0);}});
it.skipIf(windowsOnly)('bounds pixel allocation before decoding a huge TIFF',()=>{const r=decode(rawTiff(20000,20000));expect(r.status).toBe(3);expect(r.stdout.length).toBe(0);});
