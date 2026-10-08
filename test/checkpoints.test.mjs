import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,unlink,mkdir,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionStore} from '../dist/src/session.js';
import {RunStore} from '../dist/src/run-store.js';
import {CheckpointStore,TaskCheckpoint} from '../dist/src/checkpoints.js';
import {RollbackService} from '../dist/src/rollback.js';
import {checkpointActions} from '../desktop/checkpoint-actions.mjs';
import {deleteSessionFiles} from '../desktop/session-files.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
async function fixture(limits={}) {
  const root=await mkdtemp(join(tmpdir(),'pi-checkpoint-')),session=await SessionStore.create(root),runs=await RunStore.open(root,session.id),store=await CheckpointStore.open(root,limits),rollback=new RollbackService(store);
  async function task(observe=false) {const record=await runs.create({workerGeneration:randomUUID(),branchStart:null});return TaskCheckpoint.create(store,session.id,record.runId,null,observe);}
  return {root,session,runs,store,rollback,task};
}
async function mutate(f,task,path,value) {await task.before(path,'write-'+path);await writeFile(join(f.root,path),value);await task.after(path);}
async function preview(f,task,selected) {return f.rollback.preview(f.session.id,task.manifest.runId,'branch',selected);}
async function apply(f,task,plan,hook) {return f.rollback.apply(f.session.id,task.manifest.runId,plan.planId,'branch',hook);}

test('Git tracked generated paths remain covered without modifying the index',async()=>{
  const f=await fixture();try{await promisify(execFile)('git',['init',f.root]);await mkdir(join(f.root,'dist'));await writeFile(join(f.root,'.gitignore'),'dist/\n');await writeFile(join(f.root,'dist','tracked.txt'),'baseline');await promisify(execFile)('git',['-C',f.root,'add','-f','dist/tracked.txt']);const task=await f.task(true);assert(task.manifest.files['dist/tracked.txt']);await writeFile(join(f.root,'dist','tracked.txt'),'changed');await task.finalize();await apply(f,task,await preview(f,task,['dist/tracked.txt']));assert.equal(await readFile(join(f.root,'dist','tracked.txt'),'utf8'),'baseline');const {stdout}=await promisify(execFile)('git',['-C',f.root,'ls-files']);assert(stdout.includes('dist/tracked.txt'));}finally{await f.session.close();}
});
test('corrupt references refuse cleanup before pruning any closed task',async()=>{
  const f=await fixture({keepTasks:1});try{for(let i=0;i<3;i++){const task=await f.task();await mutate(f,task,'a','v'+i);await task.finalize();await f.runs.update(task.manifest.runId,{status:'completed'});if(i===2){task.manifest.files.a.before.blob='../invalid';await f.store.persist(task.manifest);}}const before=await (await import('node:fs/promises')).readdir(join(f.root,'.agent/checkpoints',f.session.id));await assert.rejects(()=>f.store.maintenance(),/Corrupt/);assert.deepEqual(await (await import('node:fs/promises')).readdir(join(f.root,'.agent/checkpoints',f.session.id)),before);}finally{await f.session.close();}
});
test('main checkpoint API restricts rollback to the latest modifying task on the active branch',async()=>{
  const f=await fixture();try{const task=await f.task();await mutate(f,task,'a','agent');await task.finalize();await f.runs.update(task.manifest.runId,{status:'completed',branchEnd:'old-branch'});let ids=['current-branch'];const host=checkpointActions({current:()=>({workspace:f.root,sessionId:f.session.id}),worker:()=>({request:async method=>method==='branch_ids'?ids:{leaf:'current-branch'}}),coordinator:()=>({store:f.runs}),settings:{data:{}},exclusive:fn=>fn()});assert.deepEqual(await host.listCheckpoints(),[]);ids.push('old-branch');assert.equal((await host.listCheckpoints()).length,1);await assert.rejects(()=>host.previewRollback({runId:randomUUID()}),/最近一次/);await f.runs.update(task.manifest.runId,{checkpointExpired:true,checkpoint:{files:1}});await assert.rejects(()=>host.previewRollback({runId:task.manifest.runId}),/已过期/);}finally{await f.session.close();}
});
test('deleting a session cleans only its run metadata and manifests, retaining shared byte objects',async()=>{
  const f=await fixture();const task=await f.task();await mutate(f,task,'a','agent');await task.finalize();await f.runs.update(task.manifest.runId,{status:'completed'});const blob=await f.store.blobPath(task.manifest.files.a.after.blob);await f.session.close();await deleteSessionFiles(f.root,f.session.id);await assert.rejects(async()=>readFile(await f.store.manifestPath(f.session.id,task.manifest.runId)),{code:'ENOENT'});assert.equal(await readFile(blob,'utf8'),'agent');assert.equal(await readFile(join(f.root,'a'),'utf8'),'agent');
});
test('multiple edits restore the earliest raw mixed-line-ending bytes and undo the rollback',async()=>{
  const f=await fixture();try {
    const original=Buffer.from('alpha\r\nbeta\ngamma\r\ndelta');await writeFile(join(f.root,'a.txt'),original);
    const task=await f.task();await mutate(f,task,'a.txt','first');await mutate(f,task,'a.txt','second\r\n');await task.finalize();
    const p=await preview(f,task),result=await apply(f,task,p);assert.deepEqual(await readFile(join(f.root,'a.txt')),original);
    const inverse=await f.rollback.inverse(f.session.id,task.manifest.runId,result.operationId,'branch');await apply(f,task,inverse);
    assert.deepEqual(await readFile(join(f.root,'a.txt')),Buffer.from('second\r\n'));
  }finally{await f.session.close();}
});
test('BOM, UTF-16, invalid UTF-8 and binary snapshots round-trip byte for byte',async()=>{
  for(const bytes of [Buffer.from([239,187,191,97,13,10]),Buffer.from([255,254,97,0,13,0,10,0]),Buffer.from([128,255,254,1]),Buffer.from([0,1,2,3,255])]) {
    const f=await fixture();try {await writeFile(join(f.root,'file'),bytes);const task=await f.task();await mutate(f,task,'file','replacement');await task.finalize();await apply(f,task,await preview(f,task));assert.deepEqual(await readFile(join(f.root,'file')),bytes);}finally{await f.session.close();}
  }
});
test('new file undo deletes only the task content and refuses a later same-name replacement',async()=>{
  const f=await fixture();try {
    const task=await f.task();await mutate(f,task,'created','agent');await task.finalize();const p=await preview(f,task);
    await writeFile(join(f.root,'created'),'manual');await assert.rejects(()=>apply(f,task,p),/文件已变化/);assert.equal(await readFile(join(f.root,'created'),'utf8'),'manual');
    const conflicts=await preview(f,task);assert.equal(conflicts.rows[0].conflict,'任务后已被修改');
  }finally{await f.session.close();}
});
test('observed creations and deletions require selection and restore the deleted binary',async()=>{
  const f=await fixture();try {
    const original=Buffer.from([0,4,7,255]);await writeFile(join(f.root,'deleted'),original);const task=await f.task(true);
    await unlink(join(f.root,'deleted'));await writeFile(join(f.root,'created'),'new');await task.finalize();
    assert((await preview(f,task)).rows.every(r=>!r.selected));
    await apply(f,task,await preview(f,task,['deleted','created']));assert.deepEqual(await readFile(join(f.root,'deleted')),original);
    await assert.rejects(()=>readFile(join(f.root,'created')),e=>e.code==='ENOENT');
  }finally{await f.session.close();}
});
test('bounded walk follows nested ignore rules and excludes credentials and dependency folders',async()=>{
  const f=await fixture();try {
    await mkdir(join(f.root,'src'));await mkdir(join(f.root,'node_modules'));await writeFile(join(f.root,'.gitignore'),'*.log\n');
    await writeFile(join(f.root,'src','.gitignore'),'ignore.txt\n');await writeFile(join(f.root,'src','ignore.txt'),'private');await writeFile(join(f.root,'src','keep.ts'),'code');
    await writeFile(join(f.root,'a.log'),'ignored');await writeFile(join(f.root,'.env'),'secret');await writeFile(join(f.root,'node_modules','a.js'),'dependency');
    const task=await f.task(true);assert(task.manifest.files['src/keep.ts']);assert(!task.manifest.files['src/ignore.txt']);assert(!task.manifest.files['.env']);assert(!task.manifest.files['a.log']);assert(!task.manifest.files['node_modules/a.js']);
  }finally{await f.session.close();}
});
test('a previously ignored or uncaptured file cannot be misclassified as newly created',async()=>{
  const f=await fixture();try {
    await writeFile(join(f.root,'.gitignore'),'hidden.txt\n');await writeFile(join(f.root,'hidden.txt'),'existing');const task=await f.task(true);
    await writeFile(join(f.root,'.gitignore'),'');await writeFile(join(f.root,'hidden.txt'),'changed');await task.finalize();
    assert(!task.manifest.files['hidden.txt']);assert(task.manifest.omissions.some(o=>o.path==='hidden.txt'));
  }finally{await f.session.close();}
});
test('rollback interrupted after a file replacement can finish without duplicate effects',async()=>{
  const f=await fixture();try {
    await writeFile(join(f.root,'a'),'old-a');await writeFile(join(f.root,'b'),'old-b');const task=await f.task();
    await mutate(f,task,'a','new-a');await mutate(f,task,'b','new-b');await task.finalize();const p=await preview(f,task);
    await assert.rejects(()=>apply(f,task,p,async()=>{throw new Error('injected crash');}),/injected/);
    assert.equal(await readFile(join(f.root,'a'),'utf8'),'old-a');assert.equal(await readFile(join(f.root,'b'),'utf8'),'new-b');
    await apply(f,task,p);assert.equal(await readFile(join(f.root,'b'),'utf8'),'old-b');
  }finally{await f.session.close();}
});
test('an interrupted rollback can instead restore its pre-undo bytes',async()=>{
  const f=await fixture();try {
    await writeFile(join(f.root,'a'),'old-a');await writeFile(join(f.root,'b'),'old-b');const task=await f.task();
    await mutate(f,task,'a','new-a');await mutate(f,task,'b','new-b');await task.finalize();const p=await preview(f,task);
    await assert.rejects(()=>apply(f,task,p,async()=>{throw new Error('injected crash');}));
    await f.rollback.recoverOriginal(f.session.id,task.manifest.runId,p.planId,'branch');assert.equal(await readFile(join(f.root,'a'),'utf8'),'new-a');assert.equal(await readFile(join(f.root,'b'),'utf8'),'new-b');
  }finally{await f.session.close();}
});
test('preview becomes invalid after changing branch or corrupting a blob',async()=>{
  const f=await fixture();try {
    await writeFile(join(f.root,'a'),'before');const task=await f.task();await mutate(f,task,'a','after');await task.finalize();const p=await preview(f,task);
    await assert.rejects(()=>f.rollback.apply(f.session.id,task.manifest.runId,p.planId,'other-branch'),/分支/);
    await writeFile(await f.store.blobPath(task.manifest.files.a.before.blob),'tampered');await assert.rejects(()=>apply(f,task,p),/checksum/);
    assert.equal(await readFile(join(f.root,'a'),'utf8'),'after');
  }finally{await f.session.close();}
});
test('size limits and hard links fail before mutation; arbitrary paths are refused',async()=>{
  const f=await fixture({maxFileBytes:4,maxRunBytes:8,maxStorageBytes:16});try {
    await writeFile(join(f.root,'large'),'too large');const task=await f.task();await assert.rejects(()=>task.before('large','write'),/size limit/);
    await writeFile(join(f.root,'small'),'abc');await link(join(f.root,'small'),join(f.root,'hard'));await assert.rejects(()=>task.before('hard','write'),/regular file/);
    await assert.rejects(()=>task.before('../outside','write'),/escapes/);assert.equal(await readFile(join(f.root,'large'),'utf8'),'too large');
  }finally{await f.session.close();}
});
test('retention protects pinned and active checkpoints and GC respects shared references',async()=>{
  const f=await fixture({keepTasks:1});try {
    await writeFile(join(f.root,'a'),'original');const first=await f.task();await mutate(f,first,'a','one');await first.finalize();await f.runs.update(first.manifest.runId,{status:'completed'});
    const second=await f.task();await mutate(f,second,'a','two');await second.finalize();await f.runs.update(second.manifest.runId,{status:'completed'});
    await f.store.maintenance();assert.equal((await f.store.allManifests()).length,1);assert.equal((await f.runs.get(first.manifest.runId)).checkpointExpired,true);
    assert.equal((await f.store.blob(second.manifest.files.a.before)).toString(),'one');
    second.manifest.pinned=true;await f.store.persist(second.manifest);
    const active=await f.task();await active.before('a','write');await f.store.maintenance();assert.equal((await f.store.allManifests()).length,2);
  }finally{await f.session.close();}
});
test('valid files named like object prototype properties are captured safely',async()=>{
  const f=await fixture();try {await writeFile(join(f.root,'constructor'),'before');const task=await f.task();await mutate(f,task,'constructor','after');await task.finalize();await apply(f,task,await preview(f,task));assert.equal(await readFile(join(f.root,'constructor'),'utf8'),'before');}finally{await f.session.close();}
});
