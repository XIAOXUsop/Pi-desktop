import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionStore} from '../dist/src/session.js';
import {RunStore} from '../dist/src/run-store.js';
import {Diagnostics,redact} from '../desktop/diagnostics.mjs';
import {PiDesktopAgent} from '../desktop/pi-agent.mjs';
import {DemoProvider} from '../dist/src/demo.js';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {CommandSupervisor} from '../desktop/command-supervisor.mjs';
import {shellTool} from '../dist/src/tools/shell.js';
test('Windows command output preserves Chinese and emoji with a UTF-8 stream', {skip:process.platform!=='win32'},async()=>{const root=await mkdtemp(join(tmpdir(),'pi-unicode-shell-')),result=await shellTool().execute({command:"Write-Output '中文 😀'"},{workspace:root,signal:new AbortController().signal,callId:'unicode',update(){}});assert.equal(result.isError,false);assert(result.text.includes('中文 😀'),result.text);assert(!result.text.includes('\uFFFD'));});
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'pi-reliability-')),session=await SessionStore.create(root);
  const runs=await RunStore.open(root,session.id);return {root,session,runs};
}
async function agentFixture() {
  const root=await mkdtemp(join(tmpdir(),'pi-run-'));await writeFile(join(root,'hello.txt'),'Hello, world!\r\n');
  const options={workspace:root,agentDir:join(root,'.profile'),modelKey:'demo/offline',tools:['read','write','edit'],mode:'build',resources:{extensions:[],skills:[],prompts:[],themes:[]},config:{providers:[],models:[]}};
  return {root,options,agent:await PiDesktopAgent.create(options,new DemoProvider())};
}
test('run state survives reload, terminal states reject resurrection and identity cannot change',async()=>{
  const f=await fixture();try {
    const run=await f.runs.create({workerGeneration:randomUUID(),branchStart:null});
    await f.runs.update(run.runId,{status:'running'});await f.runs.update(run.runId,{status:'completed'});
    const reopened=await RunStore.open(f.root,f.session.id);assert.equal((await reopened.get(run.runId)).status,'completed');
    await assert.rejects(()=>reopened.update(run.runId,{status:'running'}),/terminal/);
    await assert.rejects(()=>reopened.get('../another'),/identity/);
  }finally{await f.session.close();}
});
test('journal settlement reconciles a crash before auxiliary state commit',async()=>{
  const f=await fixture();try {
    const run=await f.runs.create({workerGeneration:randomUUID(),branchStart:null});
    await f.session.append({kind:'run_result',runId:run.runId,assistantEntryId:null,result:{status:'completed',turns:1}});
    await f.runs.reconcile();assert.equal((await f.runs.get(run.runId)).status,'completed');
  }finally{await f.session.close();}
});
test('worker loss preserves finished tools and marks only unresolved side effects uncertain',async()=>{
  const f=await fixture();try {
    const run=await f.runs.create({workerGeneration:randomUUID(),branchStart:null});
    await f.runs.update(run.runId,{tools:{done:{name:'edit',status:'finished',entryId:'saved'},pending:{name:'shell',status:'prepared'}}});
    await f.runs.partial(run.runId,{messages:[{phase:'final_answer',text:'unfinished'}]});
    await f.runs.interrupt();const result=await f.runs.get(run.runId);
    assert.equal(result.status,'interrupted');assert.equal(result.tools.done.status,'finished');assert.equal(result.tools.pending.status,'uncertain');
    assert.equal((await f.runs.getPartial(run.runId)).messages[0].text,'unfinished');
  }finally{await f.session.close();}
});
test('run directory symlink is refused instead of writing into an unrelated project',async t=>{
  const f=await fixture();try{
    const {symlink}=await import('node:fs/promises');const external=await mkdtemp(join(tmpdir(),'pi-external-'));
    try{await symlink(external,join(f.root,'.agent','runs'),'junction');}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('junction privilege unavailable');return;}throw e;}
    await assert.rejects(()=>f.runs.create({workerGeneration:randomUUID(),branchStart:null}),/Unsafe/);assert.deepEqual(await readdir(external),[]);
  }finally{await f.session.close();}
});
test('diagnostics default omits raw worker text and detailed export redacts secrets across chunks',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pi-diagnostics-')),secret='fixture-private-api-key',logger=new Diagnostics(root,{secrets:[secret],maxBytes:100});
  logger.capture('worker','stderr',Buffer.from('private prompt '+secret.slice(0,8)));logger.capture('worker','stderr',Buffer.from(secret.slice(8)+' Bearer another-private-token'));
  await logger.event('worker_exit',{exitCode:1,secret,prompt:'private prompt'});
  const summary=await logger.bundle({status:'failed'});assert(!summary.runtime);
  const detail=JSON.stringify(await logger.bundle({}, {includeRuntime:true}));assert(!detail.includes(secret));assert(!detail.includes('another-private-token'));
  const disk=await readFile(join(root,'desktop.jsonl'),'utf8');assert(!disk.includes('private prompt'));assert(!disk.includes(secret));
  assert(!redact({Authorization:'Bearer example-token'}).includes('example-token'));
});
test('official Pi run has one durable result with confirmed tool references',async()=>{
  const f=await agentFixture();try {
    const result=await f.agent.run('Edit hello.txt');assert.equal(result.status,'completed');
    const runs=await f.agent.runRecords();assert.equal(runs.length,1);assert.equal(runs[0].status,'completed');
    assert(Object.values(runs[0].tools).every(tool=>tool.status==='finished'&&tool.entryId));
    assert.equal(f.agent.busy,false);
  }finally{await f.agent.close();}
});
test('failed durable begin prevents model and file effects and releases the run',async()=>{
  const f=await agentFixture();try {
    f.agent.coordinator.store.create=async()=>{throw new Error('fixture disk full');};
    const result=await f.agent.run('Edit hello.txt');assert.equal(result.status,'failed');assert.equal(f.agent.busy,false);
    assert.equal(await readFile(join(f.root,'hello.txt'),'utf8'),'Hello, world!\r\n');
    assert(!f.agent.store.all().some(e=>e.data.kind==='run_result'&&e.data.result.status==='completed'));
  }finally{await f.agent.close();}
});
test('Pi snapshot write failure cannot persist a completed run result',async()=>{
  const f=await agentFixture();const save=f.agent.save.bind(f.agent);try {
    f.agent.save=async()=>{throw new Error('fixture snapshot failure');};
    const result=await f.agent.run('Edit hello.txt');assert.equal(result.status,'failed');assert.equal(f.agent.state.lastResult.status,'failed');
    assert(!f.agent.store.all().some(e=>e.data.kind==='run_result'&&e.data.result.status==='completed'));
  }finally{f.agent.save=save;f.agent.pending=Promise.resolve();await f.agent.close();}
});
test('a real process crash restores partial output and resumes without replaying confirmed writes',async()=>{
  const f=await agentFixture();const path=f.agent.store.path;await f.agent.close();
  const child=fork(new URL('./fixtures/reliability-agent-child.mjs',import.meta.url),[JSON.stringify({...f.options,resume:path})],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  let stderr='';child.stderr.on('data',c=>stderr+=c);
  const timer=setTimeout(()=>child.kill(),20000);let restored;
  try {
    const [message]=await once(child,'message');assert.equal(message.type,'ready_to_kill',stderr);
    const exited=once(child,'exit');child.kill();await exited;clearTimeout(timer);
    const provider={id:'demo',async *stream(request){
      assert(request.messages.some(m=>m.role==='user'&&m.text.includes('confirmed-write')));
      yield {type:'done',message:{role:'assistant',text:'[[agent:answer]]\n根据已保存的工具结果继续完成。',toolCalls:[],provider:'demo',model:'offline',stopReason:'stop',usage:{input:20,output:10},timestamp:Date.now()}};
    }};
    restored=await PiDesktopAgent.create({...f.options,resume:path},provider);
    assert.equal(restored.state.lastResult.status,'interrupted');assert.equal(restored.recovery.run.runId,message.runId);
    assert.equal(restored.recovery.uncertain.length,0);
    const partial=await restored.coordinator.store.getPartial(message.runId);assert(partial.messages.some(m=>m.text.includes('尚未完成')));
    const before=await readFile(join(f.root,'hello.txt'));
    const result=await restored.recoverRun({runId:message.runId,confirmedUncertain:true});assert.equal(result.status,'completed',result.error);
    assert.deepEqual(await readFile(join(f.root,'hello.txt')),before);
    const runs=await restored.runRecords(),previous=runs.find(r=>r.runId===message.runId),next=runs.find(r=>r.parentRunId===message.runId);
    assert.equal(previous.status,'interrupted');assert.equal(previous.recoveredBy,next.runId);assert.equal(next.status,'completed');
    assert(!Object.values(next.tools).some(t=>t.name==='write'||t.name==='edit'));
  } finally {clearTimeout(timer);if(child.exitCode===null)child.kill();await restored?.close();}
});
test('supervisor cancels an owned command after execution owner is lost and preserves completed deduplication',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pi-command-')),supervisor=new CommandSupervisor(),data={workspace:root,generation:randomUUID(),runId:randomUUID(),callId:'wait',command:process.platform==='win32'?'Start-Sleep -Seconds 30':'sleep 30'};
  const result=supervisor.execute(data).then(()=>({success:true}),error=>({error:error.message}));
  await new Promise(resolve=>setTimeout(resolve,100));const stopped=await supervisor.cancel({generation:data.generation});
  assert.equal(stopped.stopped,1);assert((await result).error);assert.equal(supervisor.commands.size,0);
  const completed={...data,callId:'once',command:process.platform==='win32'?'Write-Output once':'echo once'};
  const first=await supervisor.execute(completed),second=await supervisor.execute(completed);assert.deepEqual(second,first);
});
