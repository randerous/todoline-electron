// @vitest-environment node
import {EventEmitter} from 'node:events';
import {beforeEach,expect,it,vi} from 'vitest';
const fork=vi.hoisted(()=>vi.fn());
vi.mock('electron',()=>({utilityProcess:{fork}}));
import {DatabaseClient} from '../src/main/rpc';
let child:EventEmitter&{postMessage:ReturnType<typeof vi.fn>;kill:ReturnType<typeof vi.fn>};
beforeEach(()=>{fork.mockReset();child=Object.assign(new EventEmitter(),{postMessage:vi.fn(),kill:vi.fn()});fork.mockReturnValue(child);});
it('does not create a database process for an unused client, including shutdown',()=>{
 const client=new DatabaseClient();expect(fork).not.toHaveBeenCalled();client.shutdown();expect(fork).not.toHaveBeenCalled();
});
it('starts once for concurrent first requests and routes replies by ID',async()=>{
 const client=new DatabaseClient(),a=client.call('open','a'),b=client.call('open','b');expect(fork).toHaveBeenCalledTimes(1);
 child.emit('message',{id:2,result:'b'});child.emit('message',{id:1,result:'a'});await expect(Promise.all([a,b])).resolves.toEqual(['a','b']);client.shutdown();expect(child.kill).toHaveBeenCalledOnce();
});
it('warms a known TDE session without creating a second process on its first open',async()=>{
 const client=new DatabaseClient();client.warmup();expect(fork).toHaveBeenCalledOnce();const pending=client.call('open','a');child.emit('message',{id:1,result:'a'});await expect(pending).resolves.toBe('a');expect(fork).toHaveBeenCalledOnce();client.shutdown();client.warmup();expect(fork).toHaveBeenCalledOnce();
});
it('rejects pending operations on exit and never silently restarts a lost database',async()=>{
 const client=new DatabaseClient(),pending=client.call('save',{});child.emit('exit',1);
 await expect(pending).rejects.toThrow('已退出');await expect(client.call('open','a')).rejects.toThrow('不可用');expect(fork).toHaveBeenCalledOnce();
});
it('a failed spawn can be retried, while explicit shutdown prevents future starts',async()=>{
 fork.mockImplementationOnce(()=>{throw new Error('spawn failed');});const client=new DatabaseClient();await expect(client.call('open','a')).rejects.toThrow('spawn failed');
 const pending=client.call('open','a');client.shutdown();await expect(pending).rejects.toThrow('已关闭');await expect(client.call('open','b')).rejects.toThrow('不可用');expect(fork).toHaveBeenCalledTimes(2);
});
