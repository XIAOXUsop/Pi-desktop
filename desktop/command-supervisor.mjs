import {shellTool} from '../dist/src/tools/shell.js';
export class CommandSupervisor {
  constructor(){this.commands=new Map();this.completed=new Map();}
  async execute(data,update=()=>{}) {
    if(typeof data.command!=='string'||!data.command||data.command.length>100000 ||
      (data.timeoutMs!==undefined && (!Number.isInteger(data.timeoutMs)||data.timeoutMs<1||data.timeoutMs>120000)))throw new Error('无效命令');
    const key=data.generation+':'+data.runId+':'+data.callId;
    if(this.completed.has(key))return this.completed.get(key);
    if(this.commands.has(key))return this.commands.get(key).result;
    const controller=new AbortController(),record={...data,controller,createdAt:Date.now()};
    this.commands.set(key,record);
    record.result=shellTool(undefined,pid=>{record.pid=pid;}).execute({command:data.command,timeoutMs:data.timeoutMs},{workspace:data.workspace,callId:data.callId,signal:controller.signal,update})
      .finally(()=>this.commands.delete(key));
    const result=await record.result;this.completed.set(key,result);if(this.completed.size>256)this.completed.delete(this.completed.keys().next().value);return result;
  }
  async cancel(data) {
    const jobs=[...this.commands.values()].filter(r=>(!data.generation||r.generation===data.generation)&&(!data.runId||r.runId===data.runId)&&(!data.callId||r.callId===data.callId));
    for(const record of jobs)record.controller.abort(new Error('命令已停止'));
    await Promise.allSettled(jobs.map(r=>r.result));return {stopped:jobs.length};
  }
}
