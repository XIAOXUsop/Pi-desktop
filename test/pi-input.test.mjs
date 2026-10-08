import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PiDesktopAgent} from '../desktop/pi-agent.mjs';
import {DemoProvider} from '../dist/src/demo.js';
import {completePiPrompt} from '../desktop/pi-completion.mjs';
import {piBuiltinCommands} from '../desktop/pi-native.mjs';
import {parsePiImport} from '../desktop/session-transfer.mjs';
import {piHostActions} from '../desktop/pi-host-actions.mjs';
import {ResourceManager} from '../desktop/resources.mjs';
import {ProjectTrustStore} from '@earendil-works/pi-coding-agent';

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'pi-input-'));await writeFile(join(root,'hello.txt'),'Hello, world!\r\n');
  const options={workspace:root,agentDir:join(root,'.profile/pi'),modelKey:'demo/offline',config:{providers:[],models:[]},tools:['list','read','edit','write'],mode:'build',resources:{extensions:[],skills:[],prompts:[],themes:[]}};
  return {root,options};
}
test('desktop catalogue and slash suggestions use all 24 installed Pi built-ins without creating a session',async()=>{
  assert.equal(piBuiltinCommands.length,24);
  for(const name of ['thinking','scoped-models','fork','clone','trust','logout','changelog','share','bug','import','quit'])assert(piBuiltinCommands.some(c=>c.name===name));
  const {root}=await fixture(),before=await readdir(root),result=await completePiPrompt({text:'/',cursor:1},{workspace:root});
  assert.deepEqual(new Set(result.items.map(i=>i.value)),new Set(piBuiltinCommands.map(c=>c.name)));assert.deepEqual(await readdir(root),before);
  assert.equal(await completePiPrompt({text:'普通 /model',cursor:9},{workspace:root}),null);
  assert.equal(await completePiPrompt({text:'/../../secret',cursor:13},{workspace:root}),null);
});
test('native Pi completion preserves whitespace suffix and cursor while completing model arguments',async()=>{
  const context={models:[{key:'fixture/large-model',id:'large-model',provider:'fixture'},{key:'fixture/other',id:'other',provider:'fixture'}]};
  const query='  /mod';const result=await completePiPrompt({text:query+'后文',cursor:query.length},context);assert(result.items.some(i=>i.value==='model'));
  const applied=await completePiPrompt({text:query+'后文',cursor:query.length,item:{value:'model'}},context);assert.equal(applied.text,'  /model 后文');assert.equal(applied.cursor,'  /model '.length);
  const model=await completePiPrompt({text:'/model large',cursor:12},context);assert.equal(model.items[0].value,'fixture/large-model');
  const scoped=await completePiPrompt({text:'/model ',cursor:7},{...context,scopedModels:['fixture/other']});assert.deepEqual(scoped.items.map(i=>i.value),['fixture/other']);
});
test('real Pi skill names and asynchronous plugin arguments complete without running a model',async()=>{
  const {root,options}=await fixture(),skill=join(root,'review'),extension=join(root,'complete.ts');await mkdir(skill);
  await writeFile(join(skill,'SKILL.md'),'---\nname: project-review\ndescription: Review project\n---\nRead code.');
  await writeFile(extension,"export default function(pi){pi.registerCommand('deploy',{description:'Fixture command',getArgumentCompletions:async(prefix)=>{await new Promise(r=>setTimeout(r,30));return [{value:'staging',label:'Staging environment'}].filter(i=>i.value.startsWith(prefix));},handler:async()=>{}});pi.on('session_start',(_event,ctx)=>ctx.ui.addAutocompleteProvider(base=>({getSuggestions:async(...args)=>{const result=await base.getSuggestions(...args);if(result && args[0][0]==='/deploy sta')result.items[0].label='Wrapped staging';return result;},applyCompletion:(...args)=>base.applyCompletion(...args)})));}");
  let calls=0;const provider={id:'demo',async *stream(){calls++;throw new Error('must not run');}};
  const agent=await PiDesktopAgent.create({...options,resources:{...options.resources,skills:[skill],extensions:[extension]}},provider);
  try {
    assert((await agent.complete({text:'/review',cursor:7})).items.some(i=>i.value==='skill:project-review'));
    const plugin=await agent.complete({text:'/deploy sta',cursor:11});assert.equal(plugin.items[0].value,'staging');assert.equal(plugin.items[0].label,'Wrapped staging');
    assert.equal((await agent.complete({text:'/deploy sta',cursor:11,item:{value:'staging'}})).text,'/deploy staging');
    const pending=agent.complete({text:'/deploy s',cursor:9});await agent.complete({text:'/model ',cursor:7});assert.equal(await pending,null);assert.equal(calls,0);
    assert.equal(agent.store.branch().filter(e=>e.data.kind==='message').length,0);
  } finally {await agent.close();}
});
test('native clone and fork preserve history independently and do not roll back project files',async()=>{
  const {root,options}=await fixture(),agent=await PiDesktopAgent.create(options,new DemoProvider());
  try {
    await agent.run('read and edit');const before=await readFile(agent.store.path,'utf8'),originalId=agent.store.id;
    agent.manager.appendCustomEntry('fixture-state',{value:17});await agent.save();
    const clone=await agent.copySession({mode:'clone'}),copied=await PiDesktopAgent.create({...options,resume:clone.path},new DemoProvider());
    try {assert.notEqual(copied.store.id,originalId);assert.equal(copied.session.getLastAssistantText(),agent.session.getLastAssistantText());assert(copied.manager.getEntries().some(e=>e.type==='custom' && e.customType==='fixture-state'));}finally{await copied.close();}
    const user=agent.store.branch().find(e=>e.data.kind==='message' && e.data.message.role==='user'),fork=await agent.copySession({mode:'fork',entryId:user.id});assert.equal(fork.editorText,'read and edit');
    const branched=await PiDesktopAgent.create({...options,resume:fork.path},new DemoProvider());try{assert(!branched.session.messages.some(m=>['user','assistant','toolResult'].includes(m.role)));}finally{await branched.close();}
    assert.equal(await readFile(agent.store.path,'utf8'),before);assert.equal(await readFile(join(root,'hello.txt'),'utf8'),'Hello, coding agent!\r\n');
  } finally {await agent.close();}
});
test('Pi JSONL exports and imports preserve compaction and reject malformed node relationships',async()=>{
  const {root,options}=await fixture(),agent=await PiDesktopAgent.create(options,new DemoProvider());
  try {
    await agent.run('read and edit');const first=agent.manager.getBranch().find(e=>e.type==='message');agent.manager.appendCompaction('Summary retained',first.id,1000);
    const path=join(root,'native.jsonl');await agent.exportJsonl(path);const jsonl=await readFile(path,'utf8'),imported=parsePiImport(jsonl,root);assert(imported.getEntries().some(e=>e.type==='compaction' && e.summary==='Summary retained'));
    const copy=await agent.copySession({jsonl}),restored=await PiDesktopAgent.create({...options,resume:copy.path},new DemoProvider());try{assert(restored.manager.getEntries().some(e=>e.type==='compaction'));assert.equal(restored.store.workspace,await realpath(root));}finally{await restored.close();}
    assert.throws(()=>parsePiImport('{"type":"header","version":1}\n',root),/官方 Pi/);
    assert.throws(()=>parsePiImport(JSON.stringify({type:'session',version:3,cwd:root})+'\n'+JSON.stringify({type:'custom',id:'a',parentId:'a'})+'\n',root),/分支关系/);
  } finally {await agent.close();}
});
test('thinking changes use native model capabilities and native bug reports omit conversation by default',async()=>{
  const {options}=await fixture(),agent=await PiDesktopAgent.create(options,new DemoProvider());
  try {assert.deepEqual(agent.state.thinkingLevels,['off']);await assert.rejects(agent.setThinking('high'),/当前模型/);assert.equal(await agent.setThinking('off'),'off');const bundle=await agent.bugBundle({hint:'Offline fixture'});assert.equal(bundle.sessionJsonl,undefined);assert.equal(bundle.summary,undefined);assert.equal(bundle.metadata.hint,'Offline fixture');assert.equal(bundle.metadata.session.included,false);}
  finally{await agent.close();}
});
test('project trust gates only project resources and cancelling an import creates no empty journal',async()=>{
  const {root}=await fixture(),manager=await new ResourceManager(join(root,'.profile')).load(),agentDir=manager.folder;
  for(const scope of ['project','global']) {await manager.create({type:'skills',name:scope+'-review',description:'Fixture',body:'Review files',scope},root);const item=(await manager.list(root)).items.find(i=>i.name===scope+'-review');await manager.toggle({id:item.id,enabled:true,scope},root);}
  const globalSkill=(await manager.list(root)).items.find(i=>i.scope==='global').path;
  // The globally trusted fixture deliberately lives inside the project path.
  const trust=new ProjectTrustStore(agentDir);trust.set(root,false);assert.deepEqual((await manager.runtime(root)).skills,[globalSkill]);assert.equal((await manager.runtime(root)).projectTrusted,false);trust.set(root,null);assert.equal((await manager.runtime(root)).skills.length,2);
  let opens=0;const host=piHostActions({settings:{config:{providers:[],models:[]}},resources:{folder:agentDir},worker:()=>null,current:()=>({workspace:root}),window:()=>null,dialog:{showOpenDialog:async()=>({canceled:true})},app:{},state:async()=>({}),exclusive:fn=>fn(),openProject:async()=>opens++,reloadWorker:async()=>{}});
  assert.equal((await host.piAction({kind:'import'})).cancelled,true);assert.equal(opens,0);assert(!(await readdir(root)).includes('.agent'));
});
