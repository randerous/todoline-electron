import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
export class DatabaseClient {
  private child?: UtilityProcess;
  private seq = 0;
  private stopped=false;
  private waiting = new Map<number,{resolve:(r:any)=>void;reject:(e:Error)=>void}>();
  /** Overlap worker startup with the renderer when the saved session needs TDE. */
  warmup(){if(!this.stopped)this.start();}
  private start() {
    if(this.child)return this.child;
    this.child = utilityProcess.fork(path.join(__dirname,'db-worker.cjs'), [], { serviceName:'TodoLine 数据库',env:{...process.env,TODOLINE_NATIVE_BINDING:path.join(__dirname,'better_sqlite3.node')} });
    this.child.on('message', ({id,result,error}:any) => {
      const task = this.waiting.get(id); if (!task) return;
      this.waiting.delete(id); error ? task.reject(new Error(typeof error === 'string' ? error : error.message)) : task.resolve(result);
    });
    this.child.on('exit', () => {
      this.stopped=true;
      for (const task of this.waiting.values()) task.reject(new Error('数据库进程已退出。未保存编辑仍保留在窗口中，请另存副本或重新启动。'));
      this.waiting.clear();
    });
    return this.child;
  }
  call<T=any>(method:string,...args:unknown[]):Promise<T> {
    if(this.stopped)return Promise.reject(new Error('数据库进程不可用。待写数据保留在恢复日志中，请重新启动应用。'));
    return new Promise((resolve,reject) => {
      const id=++this.seq;
      try {const child=this.start();this.waiting.set(id,{resolve,reject});child.postMessage({id,method,args});}
      catch(error){this.waiting.delete(id);reject(error);}
    });
  }
  shutdown() {
    this.stopped=true;
    for(const task of this.waiting.values())task.reject(new Error('数据库进程已关闭。'));
    this.waiting.clear();this.child?.kill();
  }
}
