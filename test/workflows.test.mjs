import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,cp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {PiDesktopAgent} from '../desktop/pi-agent.mjs';
import {ResourceManager} from '../desktop/resources.mjs';
import {ExtensionBridge} from '../desktop/extension-bridge.mjs';

const packageRoot=fileURLToPath(new URL('../packages/pi-workflows/',import.meta.url));
async function until(check) {for(let i=0;i<500;i++){if(await check())return;await delay(10);}throw new Error('Workflow fixture timed out');}
async function fixture(respond,extensionNames=['plan','goal']) {
  const parent=fileURLToPath(new URL('../.agent/workflow-tests/',import.meta.url));await mkdir(parent,{recursive:true});
  const root=await mkdtemp(resolve(parent,'project-'));await writeFile(resolve(root,'hello.txt'),'before');
  const options={workspace:root,agentDir:resolve(root,'.profile'),modelKey:'demo/offline',config:{providers:[],models:[]},tools:['read','list','write','edit'],mode:'build',resources:{extensions:extensionNames.map(name=>resolve(packageRoot,'extensions',name+'.ts')),skills:[],prompts:[],themes:[]}};
  let modelCalls=0,checks=0;
  const provider={id:'demo',async *stream(request){
    const evaluation=request.system.includes('independently evaluate goal completion');
    const step=evaluation?++checks:++modelCalls;
    const response=await respond({request,evaluation,step,root});
    const text=response.text || '',toolCalls=response.calls || [];
    if(text)yield {type:'text_delta',text};
    yield {type:'done',message:{role:'assistant',text,toolCalls,provider:'demo',model:'offline',stopReason:toolCalls.length?'tool_use':'stop',usage:response.usage || {input:20,output:10},timestamp:Date.now()}};
  }};
  const agent=await PiDesktopAgent.create(options,provider),events=[];agent.subscribe(e=>events.push(e));
  return {agent,root,options,provider,events,get modelCalls(){return modelCalls;},get checks(){return checks;}};
}
const call=(name,args,id='call')=>({id,name,arguments:JSON.stringify(args)});
const goalCard=agent=>agent.state.extensionUI.cards.find(c=>c.id==='goal');

test('bundled workflows are independently enabled and user disabling/removal survives setup',async()=>{
  const f=await fixture(()=>({text:'answer'}),[]);await f.agent.close();
  const manager=await new ResourceManager(resolve(f.root,'profile')).load();await manager.installBundledWorkflows(packageRoot);
  let list=await manager.list(f.root);assert.equal(list.items.length,2);assert(list.items.every(i=>i.enabled));
  await manager.toggle({id:list.items.find(i=>i.name.includes('/goal')).id,enabled:false,scope:'global'},f.root);
  await manager.installBundledWorkflows(packageRoot);assert.equal((await manager.runtime(f.root)).extensions.length,1);
  await manager.remove({sourceId:list.sources[0].id},f.root);await manager.installBundledWorkflows(packageRoot);assert.equal((await manager.list(f.root)).items.length,0);
});

test('bundled workflow relocation preserves disabled resources after packaging',async()=>{
  const f=await fixture(()=>({text:'answer'}),[]);await f.agent.close();
  const manager=await new ResourceManager(resolve(f.root,'relocation-profile')).load();await manager.installBundledWorkflows(packageRoot);
  const goal=(await manager.list(f.root)).items.find(item=>item.name.includes('/goal'));
  await manager.toggle({id:goal.id,enabled:false,scope:'global'},f.root);
  const destination=resolve(f.root,'installed-workflows');await cp(packageRoot,destination,{recursive:true});
  await manager.installBundledWorkflows(destination);
  const items=(await manager.list(f.root)).items;assert.equal(items.length,2);
  assert.equal(items.find(item=>item.name.includes('/goal')).enabled,false);
  assert.equal(items.find(item=>item.name.includes('/plan')).enabled,true);
  assert(items.every(item=>item.path.startsWith(destination)));
  await manager.remove({sourceId:manager.data.sources.find(source=>source.bundled).id},f.root);
  await manager.installBundledWorkflows(packageRoot);assert.equal((await manager.list(f.root)).items.length,0);
});

test('portable extension dialogs validate answers, time out and cancel without leaking promises',async()=>{
  const bridge=new ExtensionBridge(()=>{});const ui=bridge.ui({autocomplete:()=>{},setEditorText:()=>{}});
  const selected=ui.select('choose',['one','two']);let id=bridge.state.dialogs[0].id;
  assert.throws(()=>bridge.respond({id,value:'invented'}));bridge.respond({id,value:'two'});assert.equal(await selected,'two');
  assert.equal(await ui.confirm('confirm','message',{timeout:10}),false);
  const editor=ui.editor('edit','old');id=bridge.state.dialogs[0].id;bridge.respond({id,value:'new'});assert.equal(await editor,'new');
  const controller=new AbortController(),input=ui.input('input','',{signal:controller.signal});controller.abort();assert.equal(await input,undefined);
  const pending=ui.confirm('confirm','message');bridge.dispose();assert.equal(await pending,false);assert.equal(bridge.dialogs.size,0);
});

test('plan is read-only, stores structured criteria, executes only after confirmation and restores tools',async()=>{
  const f=await fixture(({step})=>step===1?{calls:[call('write',{path:'hello.txt',content:'FORBIDDEN'},'blocked-write')]}:step===2?{calls:[call('submit_plan',{plan:'Update greeting after approval.',steps:['Edit hello.txt'],acceptance:['hello.txt contains after']},'plan')]}:{text:'[[agent:answer]]Plan ready.'});
  try {
    assert.deepEqual(f.agent.commands.map(c=>c.command).sort(),['/goal','/plan']);
    const initial=f.agent.state.tools;await f.agent.command('/plan on');assert.equal(f.agent.mode,'plan');
    const result=await f.agent.run('explore');assert.equal(result.status,'completed');assert.equal(await readFile(resolve(f.root,'hello.txt'),'utf8'),'before');
    assert.equal(f.agent.bridge.cards.get('plan').status,'ready');assert(f.events.some(e=>e.type==='tool_end' && e.result.isError));
    const execute=f.agent.command('/plan execute');await until(()=>f.agent.bridge.dialogs.size);f.agent.bridge.respond({id:f.agent.bridge.state.dialogs[0].id,confirmed:false});await execute;assert.equal(f.agent.mode,'plan');
    await f.agent.command('/plan off');assert.equal(f.agent.mode,'build');assert(initial.filter(n=>!['submit_plan','plan_question'].includes(n)).every(n=>f.agent.state.tools.includes(n)));
    const path=f.agent.store.path;await f.agent.close();const restored=await PiDesktopAgent.create({...f.options,resume:path},f.provider);assert.equal(restored.mode,'build');await restored.close();
  } finally {if(!f.agent.bridge.disposed)await f.agent.close();}
});

test('goal continues inside official settlement, verifies independently and counts verification usage',async()=>{
  const f=await fixture(({evaluation,step})=>evaluation?{text:JSON.stringify({verdict:step===1?'continue':'met',reason:step===1?'还需要修改并核对文件。':'文件已修改并核对。'})}:step===1?{calls:[call('read',{path:'hello.txt'},'read-before')]}:step===2?{text:'[[agent:answer]]Inspected.'}:step===3?{calls:[call('write',{path:'hello.txt',content:'after'},'write-after')]}:step===4?{calls:[call('read',{path:'hello.txt'},'read-after')]}:{text:'[[agent:answer]]Verified after.'});
  try {
    await f.agent.command('/goal hello.txt contains after --tokens 20k --max-turns 5');
    await until(()=>f.events.some(e=>e.type==='run_end'));
    assert.equal(goalCard(f.agent).status,'complete');assert.equal(f.checks,2);assert.equal(f.modelCalls,5);
    assert.equal(f.events.filter(e=>e.type==='run_start').length,1);assert.equal(f.events.filter(e=>e.type==='run_end').length,1);
    assert.equal(goalCard(f.agent).usage.evaluationTokens,60);assert.equal(goalCard(f.agent).usage.tokens,210);
    assert.equal(await readFile(resolve(f.root,'hello.txt'),'utf8'),'after');
    assert(f.events.some(e=>e.type==='text_delta'),'streams during extension-driven activity');
    const path=f.agent.store.path;await f.agent.close();const restored=await PiDesktopAgent.create({...f.options,resume:path},f.provider);assert.equal(goalCard(restored).status,'complete');assert.equal(goalCard(restored).usage.tokens,210);await restored.close();
  } finally {if(!f.agent.bridge.disposed)await f.agent.close();}
});

test('approved plan answers native clarification and executes with the original tool permissions',async()=>{
  const f=await fixture(({step})=>step===1?{calls:[call('plan_question',{question:'Choose output',options:['before','after']},'question')]}:step===2?{calls:[call('submit_plan',{plan:'Write after.',steps:['Edit hello.txt'],acceptance:['hello.txt is after']},'plan')]}:step===3?{text:'[[agent:answer]]Ready.'}:step===4?{calls:[call('write',{path:'hello.txt',content:'after'},'approved-write')]}:{text:'[[agent:answer]]Done.'});
  try {
    await f.agent.command('/plan on');const planning=f.agent.run('prepare plan');
    await until(()=>f.agent.bridge.state.dialogs.length);f.agent.bridge.respond({id:f.agent.bridge.state.dialogs[0].id,value:'after'});await planning;
    assert.equal(await readFile(resolve(f.root,'hello.txt'),'utf8'),'before');
    const execute=f.agent.command('/plan execute');await until(()=>f.agent.bridge.state.dialogs.length);f.agent.bridge.respond({id:f.agent.bridge.state.dialogs[0].id,confirmed:true});await execute;
    await until(()=>f.events.filter(e=>e.type==='run_end').length===2);
    assert.equal(await readFile(resolve(f.root,'hello.txt'),'utf8'),'after');assert.equal(f.agent.mode,'build');assert(!f.agent.state.tools.includes('update_goal'),'inactive goal tools stay hidden after plan restores its snapshot');
  }finally{await f.agent.close();}
});

test('budget exhaustion inside a tool turn prevents the next mutation or model request',async()=>{
  const f=await fixture(()=>({calls:[call('write',{path:'hello.txt',content:'must not run'},'write')],usage:{input:100,output:10}}));
  try{await f.agent.command('/goal inspect project --tokens 100');await until(()=>f.events.some(e=>e.type==='run_end'));assert.equal(goalCard(f.agent).status,'budget_limited');assert.equal(f.modelCalls,1);assert.equal(f.checks,0);assert.equal(await readFile(resolve(f.root,'hello.txt'),'utf8'),'before');}finally{await f.agent.close();}
});

test('an extension-started provider failure pauses the goal and never claims completion',async()=>{
  const f=await fixture(()=>{throw new Error('fixture transport failure');});
  try{await f.agent.command('/goal inspect project');await until(()=>goalCard(f.agent)?.status==='paused');await until(()=>!f.agent.busy);assert.equal(f.checks,0);assert.equal(f.events.filter(e=>e.type==='run_end').length,1);}finally{await f.agent.close();}
});

test('goal pause works through streaming command dispatch and abort never resurrects the goal',async()=>{
  let release;const held=new Promise(resolve=>release=resolve);
  const f=await fixture(async({request})=>{await Promise.race([held,new Promise(resolve=>request.signal.addEventListener('abort',resolve,{once:true}))]);return {text:'[[agent:answer]]Stopped.'};});
  try {
    await f.agent.command('/goal inspect project');await until(()=>f.agent.session.isStreaming);
    await f.agent.steer('/goal pause');assert.equal(goalCard(f.agent).status,'paused');assert.equal(f.checks,0);
    await f.agent.abort();release();assert.equal(goalCard(f.agent).status,'paused');assert.equal(f.events.filter(e=>e.type==='run_end').length,1);
    const count=f.modelCalls;await delay(30);assert.equal(f.modelCalls,count);
    const path=f.agent.store.path;await f.agent.close();const restored=await PiDesktopAgent.create({...f.options,resume:path},f.provider);assert.equal(goalCard(restored).status,'paused');assert(!restored.busy);await restored.close();
  } finally {release();if(!f.agent.bridge.disposed)await f.agent.close();}
});

test('budget exhaustion stops before further evaluation and does not mark a goal complete',async()=>{
  const f=await fixture(()=>({text:'[[agent:answer]]Partial work.',usage:{input:100,output:10}}));
  try {await f.agent.command('/goal inspect project --tokens 100');await until(()=>f.events.some(e=>e.type==='run_end'));assert.equal(goalCard(f.agent).status,'budget_limited');assert.equal(f.checks,0);assert.equal(f.modelCalls,1);}finally{await f.agent.close();}
});

test('no progress and turn limits stop automatic continuation, malformed evaluator pauses visibly',async()=>{
  for(const mode of ['no-progress','turn-limit','malformed']){
    const f=await fixture(({evaluation})=>({text:evaluation?mode==='malformed'?'not-json':JSON.stringify({verdict:'continue',reason:'尚未满足。'}):'[[agent:answer]]Acknowledged.'}));
    try {await f.agent.command('/goal inspect project'+(mode==='turn-limit'?' --max-turns 1':''));await until(()=>f.events.some(e=>e.type==='run_end'));assert.equal(goalCard(f.agent).status,mode==='turn-limit'?'turn_limited':'paused');assert.equal(f.modelCalls,mode==='no-progress'?2:1);}finally{await f.agent.close();}
  }
});

test('plan mode prevents goal start and a disabled goal extension removes its command',async()=>{
  const f=await fixture(()=>({text:'answer'}),['plan']);try {assert(!f.agent.isExtensionCommand('/goal'));await f.agent.command('/plan on');assert.equal(f.agent.mode,'plan');assert(!f.agent.state.tools.includes('write'));}finally{await f.agent.close();}
});
