import {RunStore, terminal} from '../dist/src/run-store.js';
import {randomUUID} from 'node:crypto';
export class RunCoordinator {
  constructor(store, generation = randomUUID(), diagnostics) {this.store=store;this.generation=generation;this.diagnostics=diagnostics;this.active=null;this.beginnings=new Map();this.queue=Promise.resolve();}
  static async open(workspace, sessionId, generation, diagnostics) {
    return new RunCoordinator(await RunStore.open(workspace,sessionId),generation,diagnostics);
  }
  async initialize() {await this.store.reconcile();await this.store.interrupt();}
  async begin(data) {
    if(this.beginnings.has(data.runId))return this.beginnings.get(data.runId);
    const operation=(async()=>{
      if(this.active && this.active!==data.runId)throw new Error('Another run is active');
      const record=await this.store.create({...data,workerGeneration:this.generation});
      this.active=record.runId;
      const {CheckpointStore,TaskCheckpoint}=await import('../dist/src/checkpoints.js');
      this.checkpointStore=await CheckpointStore.open(record.workspace,data.checkpointLimits);
      await this.checkpointStore.maintenance();
      const {RollbackService}=await import('../dist/src/rollback.js');const rollback=new RollbackService(this.checkpointStore);
      for(const m of await this.checkpointStore.allManifests())if((await rollback.operations(m.sessionId,m.runId)).some(op=>['prepared','applying'].includes(op.state)))throw new Error('有未完成的撤销，请先完成或恢复撤销后再运行任务');
      this.checkpoint=await TaskCheckpoint.create(this.checkpointStore,record.sessionId,record.runId,record.branchStart,!!data.observeFiles);
      await this.store.update(record.runId,{status:'running'});
      void this.diagnostics?.event('run_started',{runId:record.runId,sessionId:record.sessionId,provider:data.provider,model:data.model})?.catch(()=>{});
      return {runId:record.runId,generation:this.generation};
    })();this.beginnings.set(data.runId,operation);return operation;
  }
  async handle(method, data) {
    const operation=this.queue.then(()=>this.handleSerial(method,data));this.queue=operation.catch(()=>{});return operation;
  }
  async handleSerial(method,data) {
    if(method==='run_begin')return this.begin(data);
    if(method==='run_list')return this.store.list();
    if(method==='run_partial_get')return this.store.getPartial(data.runId);
    if(method==='run_recovered')return this.store.update(data.parentRunId,{recoveredBy:data.runId},'recovered');
    const record=await this.store.get(data.runId);
    if(record.workerGeneration!==this.generation || this.active!==data.runId)throw new Error('Stale run');
    if(terminal.has(record.status))return record;
    if(method==='run_partial')return this.store.partial(data.runId,data.partial);
    if(method==='rollback_context') {
      const {RollbackService}=await import('../dist/src/rollback.js'),rollback=new RollbackService(this.checkpointStore),ids=new Set(data.branchIds||[]),messages=[];
      for(const run of (await this.store.list()).slice(0,20))if(run.branchEnd?ids.has(run.branchEnd):run.branchStart===null||ids.has(run.branchStart)) {
        let operations;try{operations=await rollback.operations(record.sessionId,run.runId);}catch(error){if(error.code==='ENOENT')continue;throw error;}
        for(const op of operations)if(op.state==='committed'&&!op.reversedBy)messages.push('用户已恢复这些文件的历史内容：'+op.steps.map(s=>s.path).join('、')+'。先读取当前文件，不要按旧工具结果重新执行已撤销的修改。');
      }
      return messages.slice(-8).join('\n');
    }
    if(method==='checkpoint_before') {
      if(!['write','edit'].includes(record.tools[data.callId]?.name))throw new Error('Checkpoint tool identity mismatch');
      return this.checkpoint.before(data.path,data.callId);
    }
    if(method==='checkpoint_after')return this.checkpoint.after(data.path);
    if(method==='checkpoint_finalize') {
      const checkpoint=await this.checkpoint.finalize();await this.store.update(data.runId,{checkpoint},'checkpoint');return checkpoint;
    }
    if(method==='run_tool') {
      if(typeof data.callId!=='string'||data.callId.length>2000||typeof data.name!=='string')throw new Error('Invalid tool identity');
      const tools={...record.tools,[data.callId]:{name:data.name,status:data.status,entryId:data.entryId,isError:data.isError}};
      return this.store.update(data.runId,{tools},'tool_'+data.status);
    }
    if(method==='run_model') {
      const requests={...(record.requests||{})};
      requests[data.requestId]={status:data.status,usage:data.usage,provider:data.provider,model:data.model};
      const values=Object.values(requests),metrics={...record.metrics,requests:values.length,
        tokens:values.reduce((n,r)=>n+(r.usage?.totalTokens || ((r.usage?.input||0)+(r.usage?.output||0)+(r.usage?.cacheRead||0)+(r.usage?.cacheWrite||0))),0),
        usageUnconfirmed:values.some(r=>r.status!=='finished'||!r.usage || !(r.usage.totalTokens>0))};
      return this.store.update(data.runId,{requests,metrics},'model_'+data.status);
    }
    if(method==='run_workflow')return this.store.update(data.runId,{workflow:data.workflow},'workflow');
    if(method==='run_finish') {
      const result=await this.store.update(data.runId,{status:data.result.status,result:data.result,branchEnd:data.branchEnd,durableDesktopEntryId:data.entryId},'settled');
      this.active=null;this.beginnings.delete(data.runId);
      void this.diagnostics?.event('run_settled',{runId:data.runId,sessionId:record.sessionId,code:data.result.status,durationMs:Date.now()-record.createdAt,tokens:result.metrics.tokens})?.catch(()=>{});
      return result;
    }
    throw new Error('Unknown run operation');
  }
  async interrupt() {await this.store.reconcile();await this.store.interrupt(this.generation);this.active=null;}
}
