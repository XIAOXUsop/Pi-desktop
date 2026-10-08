import {CheckpointStore,TaskCheckpoint,checkpointLimits} from '../dist/src/checkpoints.js';
import {RollbackService} from '../dist/src/rollback.js';
import {terminal} from '../dist/src/run-store.js';

// All identities and paths come from the current main-process session.
export function checkpointActions({current,worker,coordinator,settings,exclusive,reloadWorker,state}) {
  async function services() {
    const selected=current();if(!selected?.sessionId||!worker())throw new Error('请先选择会话');
    const store=await CheckpointStore.open(selected.workspace,settings.data.checkpoints);
    return {store,rollback:new RollbackService(store),sessionId:selected.sessionId};
  }
  async function rows() {
    if(!current()?.sessionId||!worker()||!coordinator())return [];
    const {store,rollback,sessionId}=await services(),ids=new Set(await worker().request('branch_ids'));
    const result=[];
    for(const run of await coordinator().store.list()) {
      if(!terminal.has(run.status)||!(run.branchEnd?ids.has(run.branchEnd):run.branchStart===null||ids.has(run.branchStart)))continue;
      if(run.checkpointExpired){if(run.checkpoint?.files)result.push({runId:run.runId,createdAt:run.createdAt,expired:true,files:run.checkpoint.files});continue;}
      let manifest;try{manifest=await store.load(sessionId,run.runId);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      const files=Object.values(manifest.files).filter(f=>f.before.hash!==f.after.hash||f.before.exists!==f.after.exists).length;
      if(!files&&manifest.state!=='capturing')continue;
      const operations=(await rollback.operations(sessionId,run.runId)).filter(op=>op.state!=='preview').map(op=>({operationId:op.operationId,state:op.state,inverseOf:op.inverseOf,reversedBy:op.reversedBy,createdAt:op.createdAt,files:op.steps.map(s=>s.path)}));
      result.push({runId:run.runId,createdAt:run.createdAt,status:run.status,files,coverage:manifest.coverage,pinned:!!manifest.pinned,state:manifest.state,operations});
    }
    return result.slice(0,20);
  }
  async function selected(runId,{finalize=true}={}) {
    const list=await rows();if(!list.length||list[0].runId!==runId||list[0].expired)throw new Error('只可撤销当前分支最近一次仍有检查点的文件修改；较早任务或已过期任务不能直接撤销');
    const value=await services(),manifest=await value.store.load(value.sessionId,runId);
    if(finalize&&manifest.state==='capturing') {
      const task=await TaskCheckpoint.resume(value.store,value.sessionId,runId),checkpoint=await task.finalize();
      await coordinator().store.update(runId,{checkpoint},'checkpoint_recovered');
    }
    return {...value,branch:(await worker().request('state')).leaf};
  }
  async function notice(runId,result) {
    // WAL remains authoritative if the worker disappears before this message is saved.
    await worker().request('rollback_notice',{runId,operationId:result.operationId,files:result.files});
    await coordinator().store.update(runId,{rollbackOperationId:result.operationId},'rollback');
    return result;
  }
  return {
    listCheckpoints:rows,
    previewRollback:input=>exclusive(async()=>{const s=await selected(input.runId);return s.rollback.preview(s.sessionId,input.runId,s.branch,input.files);}),
    applyRollback:input=>exclusive(async()=>{const s=await selected(input.runId,{finalize:false});return notice(input.runId,await s.rollback.apply(s.sessionId,input.runId,input.planId,s.branch));}),
    inverseRollback:input=>exclusive(async()=>{const s=await selected(input.runId,{finalize:false});return s.rollback.inverse(s.sessionId,input.runId,input.operationId,s.branch);}),
    resumeRollback:input=>exclusive(async()=>{const s=await selected(input.runId,{finalize:false});if(!['complete','restore'].includes(input.mode))throw new Error('请选择撤销恢复方式');return notice(input.runId,await (input.mode==='restore'?s.rollback.recoverOriginal(s.sessionId,input.runId,input.operationId,s.branch):s.rollback.apply(s.sessionId,input.runId,input.operationId,s.branch)));}),
    pinCheckpoint:input=>exclusive(async()=>{if(typeof input.pinned!=='boolean')throw new Error('无效保留选项');const s=await services();if(!(await rows()).some(r=>r.runId===input.runId&&!r.expired))throw new Error('检查点已过期');const m=await s.store.load(s.sessionId,input.runId);m.pinned=input.pinned;await s.store.persist(m);return rows();}),
    setCheckpointLimits:input=>exclusive(async()=>{settings.data.checkpoints=checkpointLimits(input);await settings.save();await reloadWorker();return state();}),
  };
}
