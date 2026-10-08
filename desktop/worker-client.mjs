import { EventEmitter } from 'node:events';
export class WorkerClient extends EventEmitter {
  constructor(child, {hostRequest, diagnostics, generation} = {}) {
    super(); this.child = child; this.pending = new Map(); this.sequence = 0; this.exited = false; this.generation = generation;
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    const readyTimer = setTimeout(() => { this.readyReject(new Error('执行进程启动超时')); child.kill(); }, 60000);
    void this.ready.then(() => clearTimeout(readyTimer), () => clearTimeout(readyTimer));
    child.on('message', message => {
      if (message.type === 'ready') { this.readyResolve(); return; }
      if(message.type==='host_request') {
        void Promise.resolve().then(()=>hostRequest?.(message.method,message.params,update=>{if(!this.exited)child.postMessage({type:'host_update',id:message.id,update});})).then(
          result=>{if(!this.exited)child.postMessage({type:'host_response',id:message.id,result});},
          error=>{if(!this.exited)child.postMessage({type:'host_response',id:message.id,error:error.message});});
        return;
      }
      if (message.type === 'response') {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
      } else this.emit('notification', message);
    });
    child.on('exit', code => {
      this.exited = true; const error = new Error(`执行进程已退出 (${code})`); this.readyReject(error);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear(); this.emit('stopped', code);
    });
    // Runtime diagnostics remain local, never forward raw stderr to the renderer.
    child.stderr?.on('data', chunk => diagnostics?.capture(generation,'stderr',chunk)); child.stdout?.on('data', chunk => diagnostics?.capture(generation,'stdout',chunk));
  }
  async request(method, params = {}, timeoutMs = 30000) {
    await this.ready; if (this.exited) throw new Error('执行进程已退出'); const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('执行进程响应超时')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.child.postMessage({ id, method, params });
    });
  }
  async close() {this.closing=true;if (!this.exited) { try { await this.request('close'); } finally { this.child.kill(); } } }
}
