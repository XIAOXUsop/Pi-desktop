import {lstat,unlink,readdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {CheckpointStore,validateSnapshot,validateCheckpointPath,type CheckpointManifest,type ByteSnapshot} from './checkpoints.js';
import {checkedId,durableJson,readJson} from './durable-files.js';
interface Step {path:string;target:ByteSnapshot;expected:ByteSnapshot;backup?:ByteSnapshot;applied:boolean;applying?:boolean}
interface PreviewRow {path:string;operation:string;source:string;conflict:string|null;selected:boolean}
export interface RollbackPlan {
  version:1;operationId:string;sessionId:string;runId:string;workspace:string;branch:string|null;
  manifestHash:string;expiresAt:number;state:'preview'|'prepared'|'applying'|'committed';
  steps:Step[];createdAt:number;inverseOf?:string;reversedBy?:string;
}
const equal=(a:ByteSnapshot,b:ByteSnapshot)=>a.exists===b.exists&&a.hash===b.hash;
const digest=(m:CheckpointManifest)=>createHash('sha256').update(JSON.stringify(m)).digest('hex');
export class RollbackService {
  constructor(readonly store:CheckpointStore){}
  path(sessionId:string,runId:string,id:string,create=false){return this.store.directory.path(['.agent','checkpoints',checkedId(sessionId),checkedId(runId),'rollback-'+checkedId(id)+'.json'],create);}
  async get(sessionId:string,runId:string,id:string):Promise<RollbackPlan> {
    const plan=await readJson(await this.path(sessionId,runId,id));
    if(plan.version!==1||plan.workspace!==this.store.workspace.root||plan.sessionId!==sessionId||plan.runId!==runId||plan.operationId!==id||
      !['preview','prepared','applying','committed'].includes(plan.state)||!Array.isArray(plan.steps))throw new Error('Corrupt rollback operation');
    for(const step of plan.steps){validateCheckpointPath(step.path);validateSnapshot(step.target);validateSnapshot(step.expected,true);if(step.backup)validateSnapshot(step.backup);}
    return plan;
  }
  async persist(plan:RollbackPlan) {await durableJson(await this.path(plan.sessionId,plan.runId,plan.operationId,true),plan);}
  async preview(sessionId:string,runId:string,branch:string|null,selected?:string[]) {
    const manifest=await this.store.load(sessionId,runId),rows:PreviewRow[]=[];
    for(const file of Object.values(manifest.files)) {
      if(equal(file.before,file.after))continue;
      let conflict:string|null=null;
      try {
        if(file.before.exists)await this.store.blob(file.before);
        const current=await this.store.capture(file.path,false);
        if(!equal(current,file.after))conflict='任务后已被修改';
      }catch(error){conflict=error instanceof Error?error.message:'无法恢复';}
      rows.push({path:file.path,operation:file.before.exists?(file.after.exists?'update':'delete'):'create',source:file.source,conflict,
        selected:!conflict&&(selected?selected.includes(file.path):file.source==='file_tool')});
    }
    if(selected&&selected.some(path=>!rows.some(row=>row.path===path&&!row.conflict)))throw new Error('Selected files are unavailable or conflicted');
    const steps=rows.filter(row=>row.selected).map(row=>({path:row.path,target:manifest.files[row.path]!.before,expected:manifest.files[row.path]!.after,applied:false}));
    const plan:RollbackPlan={version:1,operationId:randomUUID(),sessionId,runId,workspace:this.store.workspace.root,branch,manifestHash:digest(manifest),expiresAt:Date.now()+5*60000,state:'preview',steps,createdAt:Date.now()};
    await this.persist(plan);return {planId:plan.operationId,runId,sessionId,rows,coverage:manifest.coverage,omissions:manifest.omissions};
  }
  async inverse(sessionId:string,runId:string,id:string,branch:string|null) {
    const old=await this.get(sessionId,runId,id);if(old.state!=='committed'||old.reversedBy)throw new Error('Rollback is not finished or already reversed');
    const manifest=await this.store.load(sessionId,runId);
    const plan:RollbackPlan={...old,operationId:randomUUID(),branch,manifestHash:digest(manifest),expiresAt:Date.now()+5*60000,createdAt:Date.now(),state:'preview',inverseOf:id,
      steps:old.steps.map(s=>{if(!s.backup)throw new Error('Undo backup missing');return {path:s.path,target:s.backup,expected:s.target,applied:false};})};
    for(const step of plan.steps){if(!equal(await this.store.capture(step.path,false),step.expected))throw new Error('撤销后文件已被修改');if(step.target.exists)await this.store.blob(step.target);}
    await this.persist(plan);return {planId:plan.operationId,runId,sessionId,rows:plan.steps.map(s=>({path:s.path,selected:true,conflict:null,operation:s.target.exists?'update':'create'}))};
  }
  async apply(sessionId:string,runId:string,id:string,branch:string|null,afterFile?: (path:string,index:number)=>Promise<void>) {
    const plan=await this.get(sessionId,runId,id);
    if(plan.branch!==branch)throw new Error('预览后会话分支已变化');
    if(plan.state==='committed')return {operationId:id,state:plan.state,files:plan.steps.map(s=>s.path)};
    if(!plan.steps.length)throw new Error('请选择无冲突且可恢复的文件');
    if(plan.state==='preview') {
      if(plan.expiresAt<Date.now())throw new Error('撤销预览已过期');
      if(digest(await this.store.load(sessionId,runId))!==plan.manifestHash)throw new Error('检查点已变化，请重新预览');
      for(const step of plan.steps) {
        const current=await this.store.capture(step.path,false);if(!equal(current,step.expected))throw new Error('文件已变化：'+step.path);
        if(step.target.exists)await this.store.blob(step.target);
      }
      for(const step of plan.steps)step.backup=await this.store.capture(step.path);
      plan.state='prepared';await this.persist(plan);
    }
    for(let index=0;index<plan.steps.length;index++) {
      const step=plan.steps[index]!,current=await this.store.capture(step.path,false);
      if(step.applied||step.applying&&equal(current,step.target)) {
        if(!equal(current,step.target))throw new Error('已撤销的文件又被修改：'+step.path);
        step.applied=true;step.applying=false;await this.persist(plan);continue;
      }
      if(!step.backup||!equal(current,step.backup))throw new Error('文件已变化：'+step.path);
      step.applying=true;plan.state='applying';await this.persist(plan);
      if(step.target.exists)await this.store.workspace.writeBytes(step.path,await this.store.blob(step.target),new AbortController().signal,step.target.mode);
      else {
        const path=await this.store.workspace.path(step.path),info=await lstat(path);
        if(!info.isFile()||info.nlink>1)throw new Error('Unsafe rollback delete');
        if(!equal(await this.store.capture(step.path,false),step.backup))throw new Error('文件已变化：'+step.path);
        await unlink(path);
      }
      await afterFile?.(step.path,index);
      step.applied=true;step.applying=false;await this.persist(plan);
    }
    plan.state='committed';await this.persist(plan);
    if(plan.inverseOf){const old=await this.get(sessionId,runId,plan.inverseOf);old.reversedBy=id;old.state='committed';await this.persist(old);}
    return {operationId:id,state:plan.state,files:plan.steps.map(s=>s.path)};
  }
  async recoverOriginal(sessionId:string,runId:string,id:string,branch:string|null) {
    const old=await this.get(sessionId,runId,id);
    if(!['prepared','applying'].includes(old.state))throw new Error('没有未完成的撤销');
    if(old.branch!==branch)throw new Error('会话分支已变化');
    for(const step of old.steps) {
      if(!step.backup)throw new Error('Undo backup missing');
      const current=await this.store.capture(step.path,false);
      if(!equal(current,step.target)&&!equal(current,step.backup))throw new Error('撤销期间文件被修改：'+step.path);
    }
    // The inverse operation is durable before changing files. Repeating it is safe.
    const manifest=await this.store.load(sessionId,runId);
    const inverse:RollbackPlan={...old,operationId:randomUUID(),inverseOf:id,state:'preview',manifestHash:digest(manifest),expiresAt:Date.now()+5*60000,createdAt:Date.now(),
      steps:await Promise.all(old.steps.map(async s=>({path:s.path,target:s.backup!,expected:await this.store.capture(s.path,false),applied:false})))};
    await this.persist(inverse);const result=await this.apply(sessionId,runId,inverse.operationId,branch);
    old.state='committed';old.reversedBy=inverse.operationId;await this.persist(old);return result;
  }
  async operations(sessionId:string,runId:string) {
    const probe=await this.path(sessionId,runId,'00000000-0000-0000-0000-000000000000');
    const plans=[];for(const name of await readdir(resolve(probe,'..')).catch(e=>{if(e.code!=='ENOENT')throw e;return [];}))if(/^rollback-[a-f0-9-]{36}\.json$/i.test(name))plans.push(await this.get(sessionId,runId,name.slice(9,-5)));
    return plans;
  }
}
