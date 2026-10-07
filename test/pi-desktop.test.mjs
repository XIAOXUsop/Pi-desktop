import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiDesktopAgent, desktopMessage } from '../desktop/pi-agent.mjs';
import { ResourceManager } from '../desktop/resources.mjs';
import { DemoProvider } from '../dist/src/demo.js';
import { SessionStore } from '../dist/src/index.js';
import { deleteSessionFiles } from '../desktop/session-files.mjs';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { providerPresets } from '../desktop/provider-presets.mjs';
import {assistantPresentation} from '../desktop/ui/assistant-presentation.js';

test('OpenCode Go sends its own client identity and a stable conversation header through Pi',async () => {
  const {options}=await fixture();const requests=[];let agent;
  const originalFetch=globalThis.fetch;const previousKey=process.env.OPENCODE_API_KEY;
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req) body+=chunk;requests.push({headers:req.headers,path:req.url,body:JSON.parse(body)});res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'go-fixture',object:'chat.completion.chunk',created:1,model:'deepseek-v4-flash',choices:[{index:0,delta:{role:'assistant',content:'Fixture answer.'},finish_reason:'stop'}],usage:{prompt_tokens:120,completion_tokens:3,total_tokens:123}})+'\n\ndata: [DONE]\n\n');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    process.env.OPENCODE_API_KEY='go-local-fixture-key';
    globalThis.fetch=(input,init)=>{const url=typeof input==='string'?input:input.url || input.toString();assert(url.startsWith('https://opencode.ai/zen/go/v1/'),'fixture must never call another external endpoint');return originalFetch(`http://127.0.0.1:${server.address().port}/v1/${url.slice('https://opencode.ai/zen/go/v1/'.length)}`,init);};
    const preset=providerPresets().find(p=>p.id==='opencode-go'),m=preset.models.find(m=>m.id==='deepseek-v4-flash');
    agent=await PiDesktopAgent.create({...options,tools:['read'],modelKey:'opencode-go/deepseek-v4-flash',config:{providers:[preset.provider],models:[{provider:preset.id,id:m.id,contextWindow:m.contextWindow,maxOutputTokens:m.maxOutputTokens,tools:true}]}},new DemoProvider());
    assert.equal((await agent.run('first fixture task')).status,'completed');
    assert.equal((await agent.run('second fixture task')).status,'completed');
    assert.equal(requests.length,4,'each unmarked completion receives one authoritative answer request');
    for(const req of requests){assert.equal(req.headers['user-agent'],'pi-desktop/0.1.0');assert.equal(req.headers['x-opencode-session'],agent.state.sessionId);assert.equal(req.path,'/v1/chat/completions');assert.equal(req.body.model,'deepseek-v4-flash');assert.equal(req.body.max_tokens,384000);}
  } finally {globalThis.fetch=originalFetch;if(previousKey===undefined) delete process.env.OPENCODE_API_KEY;else process.env.OPENCODE_API_KEY=previousKey;await agent?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

async function seedContext(options) {
  const store = await SessionStore.create(options.workspace);
  for(let i=0;i<5;i++) {
    await store.append({kind:'message',message:{role:'user',text:'prior task '+i,timestamp:Date.now()}});
    await store.append({kind:'message',message:{role:'assistant',text:'prior result '.repeat(2200),toolCalls:[],provider:'fixture',model:'fixture',stopReason:'stop',usage:{input:50000,output:100},timestamp:Date.now()}});
  }
  const path = store.path;await store.close();return path;
}

test('Pi uses the configured official-scale output ceiling and adapts compaction to small custom windows',async () => {
  const {options}=await fixture();const payloads=[];let agent;
  const server=createServer(async(req,res) => {let body='';for await(const chunk of req) body+=chunk;payloads.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'limits',object:'chat.completion.chunk',created:1,model:payloads.at(-1).model,choices:[{index:0,delta:{role:'assistant',content:'Full output.'},finish_reason:'stop'}],usage:{prompt_tokens:120,completion_tokens:3,total_tokens:123}})+'\n\ndata: [DONE]\n\n');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    agent=await PiDesktopAgent.create({...options,tools:['read'],modelKey:'limits/large',config:{providers:[{id:'limits',protocol:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`}],models:[{provider:'limits',id:'large',contextWindow:1048576,maxOutputTokens:393216,tools:true},{provider:'limits',id:'small',contextWindow:8192,maxOutputTokens:2048,tools:true}]}},new DemoProvider());
    assert.equal((await agent.run('answer completely')).status,'completed');assert.equal(payloads[0].max_tokens,393216);
    await agent.setModel('limits/small');assert.equal((await agent.run('answer once more')).status,'completed');assert.equal(payloads.length,4);assert.equal(payloads[2].max_tokens,2048);assert.equal(payloads[3].max_tokens,2048);assert.equal(agent.model.contextWindow,8192);
  } finally {await agent?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('native Pi compacts early with room for a useful summary and the complete response',async () => {
  const {options} = await fixture();const path = await seedContext(options), payloads=[];let agent;
  const server = createServer(async(req,res) => {
    let body='';for await(const chunk of req) body += chunk;payloads.push(JSON.parse(body));
    const answer = payloads.length === 1 ? 'Summary: previous tasks completed; continue the current task.' : 'Complete final answer.';
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:answer},finish_reason:'stop'}],usage:{prompt_tokens:500,completion_tokens:20,total_tokens:520}})+'\n\ndata: [DONE]\n\n');
  });await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    agent = await PiDesktopAgent.create({...options,resume:path,modelKey:'fixture/fixture',config:{providers:[{id:'fixture',protocol:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,timeoutMs:5000}],models:[{provider:'fixture',id:'fixture',contextWindow:65536,maxOutputTokens:8192,tools:true}]}},new DemoProvider());const events=[];agent.subscribe(e => events.push(e));
    const result = await agent.run('finish the current task');assert.equal(result.status,'completed',result.error);assert.equal(result.text,'Complete final answer.');
    assert(payloads.length >= 2);assert(payloads.every(p => p.max_tokens >= 1024));assert(events.some(e => e.type === 'compaction_start'));assert(events.some(e => e.type === 'compaction_end' && e.success));
    assert(agent.manager.getEntries().some(e => e.type === 'compaction'));
    const marker = agent.store.branch().at(-1);assert.equal(marker.data.kind,'run_result');assert.equal(marker.data.result.status,'completed');assert(marker.data.assistantEntryId);
  } finally {await agent?.close();server.closeAllConnections();await new Promise(resolve => server.close(resolve));}
});

test('length stop remains incomplete even when failed recovery removes it from Pi projection',async () => {
  const {root,options} = await fixture();const path = await seedContext(options), extension = join(root,'cancel-compaction.ts');
  await writeFile(extension,`export default function(pi) {pi.on('session_before_compact',()=>({cancel:true}));}`);
  const server = createServer(async(req,res) => {for await(const chunk of req) {}res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'Let'},finish_reason:'length'}],usage:{prompt_tokens:66610,completion_tokens:1,total_tokens:66611}})+'\n\ndata: [DONE]\n\n');});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));let agent;
  try {
    agent = await PiDesktopAgent.create({...options,resume:path,resources:{...options.resources,extensions:[extension]},modelKey:'fixture/fixture',config:{providers:[{id:'fixture',protocol:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,timeoutMs:5000}],models:[{provider:'fixture',id:'fixture',contextWindow:65536,maxOutputTokens:8192,tools:true}]}},new DemoProvider());const events=[];agent.subscribe(e=>events.push(e));
    const result = await agent.run('reproduce the short response');assert.equal(result.status,'limit');assert.equal(result.text,'Let');assert.match(result.error,/未完成/);
    assert(events.some(e => e.type === 'compaction_end' && !e.success));assert(agent.manager.getEntries().some(e => e.type === 'context_edit'));
    const marker = agent.store.branch().at(-1);assert.equal(marker.data.result.status,'limit');const output = agent.store.branch().find(e => e.id === marker.data.assistantEntryId);assert.equal(output.data.message.stopReason,'length');assert.equal(output.data.message.executionStatus,'limit');
    const resume = agent.store.path;await agent.close();agent = await PiDesktopAgent.create({...options,resume},new DemoProvider());assert.equal(agent.state.lastResult.status,'limit');
  } finally {await agent?.close();server.closeAllConnections();await new Promise(resolve => server.close(resolve));}
});

test('unrecoverable giant tool result is stopped before a one-token provider request',async () => {
  const {root,options} = await fixture();const extension = join(root,'huge-result.ts');
  await writeFile(extension,`import {Type} from 'typebox';export default function(pi) {pi.on('session_before_compact',()=>({cancel:true}));pi.registerTool({name:'huge_result',label:'Huge',description:'Offline test',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'x'.repeat(300000)}]})});}`);
  let requests=0;const server = createServer(async(req,res) => {for await(const chunk of req) {}requests++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{tool_calls:[{index:0,id:'huge',type:'function',function:{name:'huge_result',arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:500,completion_tokens:20,total_tokens:520}})+'\n\ndata: [DONE]\n\n');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let agent;
  try {agent = await PiDesktopAgent.create({...options,resources:{...options.resources,extensions:[extension]},modelKey:'fixture/fixture',config:{providers:[{id:'fixture',protocol:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,timeoutMs:5000}],models:[{provider:'fixture',id:'fixture',contextWindow:65536,maxOutputTokens:8192,tools:true}]}},new DemoProvider());
    const result = await agent.run('get oversized output');assert.notEqual(result.status,'completed');assert.equal(requests,1);assert.match(result.error,/上下文/);
  } finally {await agent?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('stream with no finish reason is incomplete and does not become a successful answer',async () => {
  const {options} = await fixture();const server = createServer(async(req,res) => {for await(const chunk of req) {}res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{content:'Partial'},finish_reason:null}]})+'\n\n');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let agent;
  try {agent=await PiDesktopAgent.create({...options,modelKey:'fixture/fixture',config:{providers:[{id:'fixture',protocol:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,timeoutMs:5000}],models:[{provider:'fixture',id:'fixture',contextWindow:65536,maxOutputTokens:8192,tools:true}]}},new DemoProvider());const result=await agent.run('stream test');assert.equal(result.status,'failed');assert.equal(result.text,'Partial');assert.match(result.error,/finish_reason/);
  } finally {await agent?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('public reasoning separates text from opaque signatures and preserves redacted markers',() => {
  const native = {role:'assistant',content:[{type:'thinking',thinking:'public summary',thinkingSignature:'OPAQUE_SECRET'},{type:'thinking',thinking:'HIDDEN',redacted:true,thinkingSignature:'REDACTED_SECRET'},{type:'text',text:'answer'}],provider:'fixture',model:'fixture',stopReason:'stop',usage:{input:0,output:0},timestamp:1};
  const message = desktopMessage(native);
  assert.equal(message.text,'answer');assert.deepEqual(message.reasoning,[{index:0,text:'public summary'},{index:1,text:'',redacted:true}]);
  assert(!JSON.stringify(message).includes('SECRET'));assert(!JSON.stringify(message).includes('HIDDEN'));
  const typed=desktopMessage({...native,content:[{type:'text',text:'status',textSignature:JSON.stringify({v:1,id:'OPAQUE_PRIVATE_ID',phase:'commentary'})}]});
  assert.equal(typed.phase,'commentary');assert.equal(typed.text,'status');assert(!JSON.stringify(typed).includes('OPAQUE_PRIVATE_ID'));
  assert.equal([{role:'user',content:'question',timestamp:1},{...native,content:[{type:'text',text:'answer',textSignature:JSON.stringify({v:1,id:'message',phase:'final_answer'})}]}].map(desktopMessage)[1].phase,'final_answer','Array.map index is not a phase override');
});

test('real Pi reasoning SSE persists across restore, stays out of answer text and carries stable message ids',async () => {
  const {options} = await fixture();let count = 0, agent;
  const server = createServer(async(req,res) => {
    for await(const chunk of req) {} count++;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send = (delta,finish_reason=null) => res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    send({role:'assistant',reasoning_content:'Inspect '});await delay(10);send({reasoning_content:'the file.'});
    if(count === 1) {send({content:'I will inspect the file.'});send({tool_calls:[{index:0,id:'read-call',type:'function',function:{name:'read',arguments:'{"path":"hello.txt"}'}}]},'tool_calls');}
    else send({content:'File verified'},'stop');res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const configured = {...options,modelKey:'fixture/fixture',config:{providers:[{id:'fixture',protocol:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,timeoutMs:5000}],models:[{provider:'fixture',id:'fixture',contextWindow:32000,maxOutputTokens:1024,tools:true}]}};
  try {
    agent = await PiDesktopAgent.create(configured,new DemoProvider());const events=[];agent.subscribe(e => events.push(e));
    const result = await agent.run('inspect');assert.equal(result.status,'completed',result.error);assert.equal(result.text,'File verified');
    const ends = events.filter(e => e.type === 'message' && e.message.role === 'assistant');assert.equal(ends.length,3);assert.deepEqual(ends.map(e=>e.message.phase),['commentary','commentary','final_answer']);
    for(const end of ends) {assert.equal(end.message.reasoning[0].text,'Inspect the file.');const deltas = events.filter(e => e.type === 'thinking_delta' && e.messageId === end.messageId);assert.equal(deltas.map(e => e.text).join(''),'Inspect the file.');}
    assert.notEqual(ends[0].messageId,ends[1].messageId);
    assert.deepEqual(events.filter(e => e.type === 'assistant_start').map(e => e.messageId),ends.map(e => e.messageId));
    const progress = events.findIndex(e => e.type === 'assistant_progress' && e.messageId === ends[0].messageId);
    assert(progress > events.findIndex(e => e.type === 'text_delta' && e.messageId === ends[0].messageId));
    assert(progress < events.findIndex(e => e.type === 'tool_start'),'tool preparation reclassifies commentary before executing');
    const path = agent.store.path;await agent.close();agent = await PiDesktopAgent.create({...configured,resume:path},new DemoProvider());
    const journal = agent.store.branch().filter(e => e.data.kind === 'message' && e.data.message.role === 'assistant');assert.equal(journal.length,3);assert(journal.every(e => e.data.message.reasoning[0].text === 'Inspect the file.'));assert.equal(journal.at(-1).data.message.phase,'final_answer');
    assert.equal(agent.session.messages.filter(m => m.role === 'assistant')[0].content[0].thinking,'Inspect the file.');
  } finally {await agent?.close();await new Promise(resolve => server.close(resolve));}
});

test('real Pi publishes answer increments while SSE is held open, independently of final persistence',async () => {
  const {options} = await fixture();let release,arrived,agent;
  const gate = new Promise(resolve => {release = resolve;});
  const firstText = new Promise(resolve => {arrived = resolve;});
  const server = createServer(async(req,res) => {
    for await(const chunk of req) {}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send = (delta,finish_reason=null) => res.write('data: '+JSON.stringify({id:'held-stream',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    send({role:'assistant',reasoning_content:'公開思考摘要。'});
    send({content:'[[agent:answer]]\nFirst answer '});await gate;
    send({content:'second chunk.'});send({},'stop');res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    agent = await PiDesktopAgent.create({...options,modelKey:'fixture/fixture',config:{providers:[{id:'fixture',protocol:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,timeoutMs:5000}],models:[{provider:'fixture',id:'fixture',contextWindow:32000,maxOutputTokens:1024,tools:true}]}},new DemoProvider());
    const events=[];agent.subscribe(event => {events.push(event);if(event.type === 'text_delta') arrived();});
    const run = agent.run('stream');await firstText;
    assert.deepEqual(assistantPresentation(events.filter(e => e.type === 'text_delta').map(e => e.text).join('')),{phase:'final_answer',text:'First answer '});
    assert(events.some(e => e.type === 'thinking_delta' && e.text === '公開思考摘要。'),'public reasoning arrives separately before answer text');
    assert(!events.some(e => e.type === 'run_end' || e.type === 'message' && e.message.role === 'assistant'),'live answer does not wait for terminal or persisted message');
    assert(!agent.store.branch().some(e => e.data.kind === 'message' && e.data.message.role === 'assistant'));
    release();const result = await run;assert.equal(result.status,'completed');assert.equal(result.text,'First answer second chunk.');
    const deltas = events.filter(e => e.type === 'text_delta');assert.equal(deltas.length,2);assert.equal(deltas[0].messageId,deltas[1].messageId);
    const settled=events.find(e => e.type === 'message' && e.message.role === 'assistant').message;
    assert.equal(settled.text,assistantPresentation(deltas.map(e => e.text).join('')).text);assert.equal(settled.phase,'final_answer');
    assert(agent.store.branch().some(e => e.data.kind === 'message' && e.data.message.phase === 'final_answer' && e.data.message.text === result.text));
  } finally {release();await agent?.close();server.closeAllConnections();await new Promise(resolve => server.close(resolve));}
});

test('an explicit process-only completion remains process and cannot falsely finish with an answer',async () => {
  const {options}=await fixture();const raw='[[agent:progress]]\nI will inspect the files.';
  const provider={id:'demo',async *stream(){yield {type:'text_delta',text:raw};yield {type:'done',message:{role:'assistant',text:raw,toolCalls:[],provider:'demo',model:'offline',stopReason:'stop',usage:{input:0,output:0},timestamp:Date.now()}};}};
  const agent=await PiDesktopAgent.create(options,provider);
  try {
    const result=await agent.run('inspect');assert.equal(result.status,'failed');assert.match(result.error,/未生成最终回答/);assert.equal(result.text,'I will inspect the files.');
    const saved=agent.store.branch().findLast(e=>e.data.kind==='message' && e.data.message.role==='assistant').data.message;
    assert.equal(saved.phase,'commentary');assert.equal(saved.text,result.text);assert(!saved.text.includes('[[agent:'));
  } finally {await agent.close();}
});

test('abort retains partial reasoning with cancelled status and no fabricated final answer',async () => {
  const {options} = await fixture();let notify;const arrived = new Promise(resolve => notify = resolve);
  const provider = {id:'demo',async *stream(request) {yield {type:'thinking_delta',text:'partial sample'};yield {type:'text_delta',text:'I will inspect the project.'};await delay(10000,undefined,{signal:request.signal});}};
  const agent = await PiDesktopAgent.create(options,provider);agent.subscribe(e => {if(e.type === 'text_delta') notify();});
  try {const run = agent.run('test cancellation');await arrived;await agent.abort();assert.equal((await run).status,'cancelled');
    const m = agent.store.branch().findLast(e => e.data.kind === 'message' && e.data.message.role === 'assistant').data.message;
    assert.equal(m.executionStatus,'cancelled');assert.equal(m.reasoning[0].text,'partial sample');assert.equal(m.text,'I will inspect the project.');assert.equal(m.phase,'commentary');
  } finally {await agent.close();}
});

test('official extension partial tool results are forwarded once as cumulative replacements',async () => {
  const {root,options} = await fixture();const extension = join(root,'progress.ts');
  await writeFile(extension,`import {Type} from 'typebox';export default function(pi) {pi.registerTool({name:'progress_fixture',label:'Progress',description:'Offline',parameters:Type.Object({}),execute:async(id,args,signal,onUpdate)=>{onUpdate({content:[{type:'text',text:'first'}]});onUpdate({content:[{type:'text',text:'first second'}]});return {content:[{type:'text',text:'final'}]};}});}`);
  const provider = {id:'demo',async *stream(request) {const done = request.messages.some(m => m.role === 'tool');yield {type:'done',message:{role:'assistant',text:done ? 'done' : '',toolCalls:done ? [] : [{id:'progress-call',name:'progress_fixture',arguments:'{}'}],provider:'demo',model:'offline',stopReason:done ? 'stop' : 'tool_use',usage:{input:0,output:0},timestamp:Date.now()}};}};
  const agent = await PiDesktopAgent.create({...options,resources:{extensions:[extension],skills:[],prompts:[],themes:[]}},provider);const events=[];agent.subscribe(e => events.push(e));
  try {assert.equal((await agent.run('progress')).status,'completed');const updates = events.filter(e => e.type === 'tool_update');assert.deepEqual(updates.map(e => e.text),['first','first second']);assert(updates.every(e => e.replace));}
  finally {await agent.close();}
});

test('journal rejects malformed public reasoning while accepting old assistant messages',async () => {
  const {root} = await fixture(), store = await SessionStore.create(root);
  const message = {role:'assistant',text:'answer',toolCalls:[],provider:'fixture',model:'fixture',stopReason:'stop',usage:{input:0,output:0},timestamp:1};
  try {await store.append({kind:'message',message});
    await assert.rejects(store.append({kind:'message',message:{...message,reasoning:[{index:-1,text:'bad'}]}}),/reasoning/);
    await assert.rejects(store.append({kind:'message',message:{...message,reasoning:[{index:0,text:'hidden',redacted:true}]}}),/reasoning/);
    await store.append({kind:'message',message:{...message,phase:'commentary'}});
    await assert.rejects(store.append({kind:'message',message:{...message,phase:'unknown'}}),/phase/);
  } finally {await store.close();}
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'pi-desktop-'));
  await writeFile(join(root,'hello.txt'),'Hello, world!\r\n');
  const options = {workspace:root,agentDir:join(root,'.profile/pi'),modelKey:'demo/offline',config:{providers:[],models:[]},tools:['list','read','edit','write'],mode:'build',resources:{extensions:[],skills:[],prompts:[],themes:[]}};
  return {root,options};
}

test('desktop Pi shares byte-preserving mixed edits and UTF-8-safe read truncation with the core',async()=>{
  const {root,options}=await fixture(),prefix='x'.repeat(64*1024-Buffer.byteLength('\n[output truncated]')-4);
  const original=prefix+'你'.repeat(20)+'\r\nalpha\r\nbeta\ngamma\r\ndelta';await writeFile(join(root,'mixed.txt'),original);
  let step=0;
  const provider={id:'demo',async *stream(request){
    step++;if(step===2)assert.equal(request.messages.at(-1).text,'1: '+prefix+'\n[output truncated]');
    const toolCalls=step===1?[{id:'read-mixed',name:'read',arguments:JSON.stringify({path:'mixed.txt'})}]:step===2?[{id:'edit-mixed',name:'edit',arguments:JSON.stringify({path:'mixed.txt',oldText:'beta',newText:'BETA'})}]:[];
    yield {type:'done',message:{role:'assistant',text:step===3?'[[agent:answer]]Verified.':'',toolCalls,provider:'demo',model:'offline',stopReason:toolCalls.length?'tool_use':'stop',usage:{input:10,output:2},timestamp:Date.now()}};
  }};
  const agent=await PiDesktopAgent.create(options,provider);
  try {
    assert.equal((await agent.run('edit mixed file')).status,'completed');assert.equal(step,3);
    const expected=original.replace('beta','BETA');assert.deepEqual(await readFile(join(root,'mixed.txt')),Buffer.from(expected));
    const change=agent.store.branch().find(entry=>entry.data.kind==='file_change').data.change;
    assert.equal(change.addedLines,1);assert.equal(change.removedLines,1);assert(!change.patch.includes('\uFFFD'));
    assert.deepEqual(await readFile(join(root,change.before.snapshot)),Buffer.from(original));
    assert.deepEqual(await readFile(join(root,change.after.snapshot)),Buffer.from(expected));
    const path=agent.store.path;await agent.close();
    const restored=await PiDesktopAgent.create({...options,resume:path},provider);
    try {const read=restored.store.messages().find(message=>message.role==='tool' && message.name==='read');assert.equal(read.text,'1: '+prefix+'\n[output truncated]');}finally{await restored.close();}
  }finally{if(!agent.bridge.disposed)await agent.close();}
});

test('Pi command catalogue contains only loaded extension commands skills and templates',async()=>{
  const {root,options}=await fixture();const extension=join(root,'commands.ts'),skill=join(root,'skills','catalog'),prompt=join(root,'catalog-prompt.md');
  await mkdir(skill,{recursive:true});await writeFile(join(skill,'SKILL.md'),'---\nname: catalog-review\ndescription: Inspect the current project.\n---\nRead first.');
  await writeFile(prompt,'---\ndescription: Summarize current work.\n---\nSummarize $ARGUMENTS');
  await writeFile(extension,"export default function(pi){pi.registerCommand('catalog-command',{description:'Catalogue fixture',handler:async()=>{}});}");
  let agent=await PiDesktopAgent.create({...options,resources:{extensions:[extension],skills:[skill],prompts:[prompt],themes:[]}},new DemoProvider());
  try {assert.deepEqual(agent.commands.map(c=>c.command).sort(),['/catalog-command','/catalog-prompt','/skill:catalog-review']);assert(agent.commands.every(c=>typeof c.description==='string' && ['extension','skill','prompt'].includes(c.source)));assert.equal(agent.sessionInfo().sessionFile,agent.store.path);assert.equal(agent.sessionInfo().sessionId,agent.store.id);}
  finally {await agent.close();}
  agent=await PiDesktopAgent.create(options,new DemoProvider());try {assert.deepEqual(agent.commands,[]);}finally {await agent.close();}
});

test('manual Pi compaction preserves journal and native summary across resume without sending a user command',async()=>{
  const {root,options}=await fixture(),path=await seedContext(options),extension=join(root,'manual-compact.ts');
  await writeFile(extension,`export default function(pi){pi.on('session_before_compact',async(event)=>{await new Promise(resolve=>setTimeout(resolve,100));return {compaction:{summary:'Manual summary: '+event.customInstructions,firstKeptEntryId:event.preparation.firstKeptEntryId,tokensBefore:event.preparation.tokensBefore}};});}`);
  let agent=await PiDesktopAgent.create({...options,resume:path,resources:{...options.resources,extensions:[extension]}},new DemoProvider());const original=agent.store.all(),before=original.length,id=agent.store.id;
  try {
    const operation=agent.compact('Keep the current goal');assert.equal(agent.busy,true);await assert.rejects(agent.run('/compact'),/busy/);
    const result=await operation;assert(result.tokensBefore>0 && result.tokensAfter>0);assert.equal(agent.busy,false);assert.equal(agent.store.all().length,before);
    assert(agent.manager.getEntries().some(e=>e.type==='compaction' && e.summary.includes('Keep the current goal')));
    const exportPath=join(root,'session.html');await agent.exportHtml(exportPath);assert((await readFile(exportPath,'utf8')).includes('Manual summary'));
    await agent.close();agent=await PiDesktopAgent.create({...options,resume:path},new DemoProvider());assert.equal(agent.store.id,id);assert(agent.manager.getEntries().some(e=>e.type==='compaction'));assert.deepEqual(agent.store.all().slice(0,before),original);
  } finally {await agent.close();}
});

test('manual Pi compaction rejects empty history and invalid instructions and releases busy state',async()=>{
  const {options}=await fixture(),agent=await PiDesktopAgent.create(options,new DemoProvider());
  try {await assert.rejects(agent.compact(''),/无需压缩|No messages/);assert.equal(agent.busy,false);await assert.rejects(agent.compact({}),/压缩说明/);await assert.rejects(agent.compact('x'.repeat(16385)),/16 KiB/);assert.equal(agent.busy,false);assert.equal(agent.store.branch().filter(e=>e.data.kind==='message').length,0);
    await agent.store.append({kind:'message',message:{role:'user',text:'</pre><script>unsafe()</script><img src=x onerror=unsafe()>完整记录',timestamp:Date.now()}});
    const output=join(agent.workspace.root,'escaped.html');await agent.exportHtml(output);const html=await readFile(output,'utf8');assert(html.includes('&lt;script&gt;unsafe()&lt;/script&gt;') && html.includes('完整记录'));assert(!html.includes('<script>') && !html.includes('<img'));
  }
  finally {await agent.close();}
});
test('official Pi executes tracked tools, persists its tree, restores and branches the desktop journal',async () => {
  const {root,options} = await fixture();
  let agent = await PiDesktopAgent.create(options,new DemoProvider()); const events=[]; agent.subscribe(e => events.push(e));
  assert.equal(agent.state.engine,'pi');
  const result = await agent.run('read and edit'); assert.equal(result.status,'completed',result.error);
  assert.equal(await readFile(join(root,'hello.txt'),'utf8'),'Hello, coding agent!\r\n');
  assert.equal(events.filter(e => e.type === 'file_change').length,1);
  const user = agent.store.branch().find(e => e.data.kind === 'message' && e.data.message.role === 'user');
  const path = agent.store.path, id = agent.store.id; await agent.close();
  agent = await PiDesktopAgent.create({...options,resume:path},new DemoProvider());
  assert.equal(agent.session.messages.filter(m => m.role === 'assistant').length,3);
  await agent.branch(user.id); assert.equal(agent.session.messages.filter(m => m.role === 'assistant').length,0);
  assert.equal(agent.store.leaf,user.id); await agent.close();
  await deleteSessionFiles(root,id); await assert.rejects(stat(join(root,'.agent/pi-state',id+'.json')), {code:'ENOENT'});
  assert.equal(await readFile(join(root,'hello.txt'),'utf8'),'Hello, coding agent!\r\n');
});
test('manager imports a Pi package without executing it, honors enabled paths and preserves local sources',async () => {
  const {root} = await fixture(); const pkg = join(root,'test-package'); await mkdir(join(pkg,'skills','review'),{recursive:true}); await mkdir(join(pkg,'extensions'));
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'fixture',pi:{skills:['skills'],extensions:['extensions/test.ts']}}));
  await writeFile(join(pkg,'skills/review/SKILL.md'),'---\nname: review\ndescription: >-\n  Review code carefully.\n  Retain identifiers.\n---\nRead files before review.\n');
  await writeFile(join(pkg,'extensions/test.ts'),'throw new Error("MUST NOT RUN DURING DISCOVERY"); export default function() {}');
  const manager = await new ResourceManager(join(root,'.profile')).load();
  let list = await manager.add({source:pkg,scope:'project'},root); assert.equal(list.items.length,2); assert(list.items.every(i => !i.enabled));
  const skill = list.items.find(i => i.type === 'skills'); assert.match(skill.description,/Review code carefully/);
  await manager.toggle({id:skill.id,enabled:true},root);
  assert.deepEqual((await manager.runtime(root)).skills,[skill.path]); assert.deepEqual((await manager.runtime(root)).extensions,[]);
  await assert.rejects(manager.add({source:pkg},root),/已经添加/);
  assert.equal((await manager.list(join(root,'other'))).items.length,0);
  await rename(pkg,pkg+'-moved'); const missing = (await manager.list(root)).items; assert.equal(missing.length,1); assert.equal(missing[0].error,true);
  await manager.remove({sourceId:missing[0].sourceId},root); assert.equal((await manager.list(root)).items.length,0); await rename(pkg+'-moved',pkg);
  assert.match(await readFile(join(pkg,'extensions/test.ts'),'utf8'),/MUST NOT RUN/);
});
test('native extension tool and command run, skill expands, disabled extensions disappear and custom state restores',async () => {
  const {root,options} = await fixture(); const pkg = join(root,'bundle'); await mkdir(join(pkg,'skills','audit'),{recursive:true}); await mkdir(join(pkg,'extensions'));
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'fixture',pi:{skills:['skills'],extensions:['extensions/tool.ts']}}));
  await writeFile(join(pkg,'skills/audit/SKILL.md'),'---\nname: audit\ndescription: Inspect code\n---\nAUDIT_INSTRUCTIONS_123\n');
  await writeFile(join(pkg,'extensions/tool.ts'),`import { Type } from 'typebox';
export default function(pi) {
 pi.registerTool({ name:'fixture_tool',label:'Fixture',description:'Fixture tool',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'EXTENSION_EXECUTED'}],details:{native:true}}) });
 pi.registerCommand('fixture',{description:'Notify',handler:async(args,ctx)=>{pi.appendEntry('fixture-memory',{value:17});ctx.ui.notify('COMMAND_EXECUTED');}});
}`);
  const manager = await new ResourceManager(join(root,'.profile')).load(); const list = await manager.add({source:pkg},root);
  for(const item of list.items) await manager.toggle({id:item.id,enabled:true},root);
  let seenPrompt;
  const provider = {id:'demo',async *stream(request) {
    seenPrompt = request.messages.findLast(m => m.role === 'user').text;
    const done = request.messages.some(m => m.role === 'tool' && m.name === 'fixture_tool');
    yield {type:'done',message:{role:'assistant',text:done ? 'done' : '',toolCalls:done ? [] : [{id:'fixture-call',name:'fixture_tool',arguments:'{}'}],provider:'demo',model:'offline',stopReason:done ? 'stop' : 'tool_use',usage:{input:0,output:0},timestamp:Date.now()}};
  }};
  let agent = await PiDesktopAgent.create({...options,resources:await manager.runtime(root)},provider); const events=[]; agent.subscribe(e => events.push(e));
  assert(agent.state.tools.includes('fixture_tool'));
  assert.equal((await agent.run('/fixture')).status,'completed'); assert(events.some(e => e.type === 'extension_notice' && e.message === 'COMMAND_EXECUTED'));
  assert.equal((await agent.run('/skill:audit inspect')).status,'completed'); assert.match(seenPrompt,/AUDIT_INSTRUCTIONS_123/);
  assert(events.some(e => e.type === 'tool_end' && e.result.text === 'EXTENSION_EXECUTED'));
  const path = agent.store.path; await agent.close();
  agent = await PiDesktopAgent.create({...options,resume:path,resources:await manager.runtime(root)},provider);
  assert(agent.manager.getEntries().some(e => e.type === 'custom' && e.customType === 'fixture-memory' && e.data.value === 17)); await agent.close();
  const extension = list.items.find(i => i.type === 'extensions'); await manager.toggle({id:extension.id,enabled:false},root);
  agent = await PiDesktopAgent.create({...options,resume:path,resources:await manager.runtime(root)},provider);
  assert(!agent.state.tools.includes('fixture_tool')); await agent.close();
});
test('planning mode blocks extension model tools and surfaces invalid extensions',async () => {
  const {root,options} = await fixture(); const path = join(root,'broken.ts'); await writeFile(path,'export default function() { throw new Error("broken-fixture") }');
  const agent = await PiDesktopAgent.create({...options,mode:'plan',tools:['list','read'],resources:{extensions:[path],skills:[],prompts:[],themes:[]}},new DemoProvider());
  assert.deepEqual(agent.state.tools,['list','read']); assert(agent.state.resourceDiagnostics.some(d => /broken-fixture/.test(d.message)));
  await agent.close();
});
test('existing DeepSeek configuration uses Pi transport with the key, disabled thinking and legacy token field',async () => {
  const {root,options} = await fixture(); let request;
  const server = createServer(async(req,res) => {
    let body=''; for await(const chunk of req) body += chunk;
    request = {path:req.url,authorization:req.headers.authorization,payload:JSON.parse(body)};
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'Transport verified'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); const previous = process.env.PI_FIXTURE_KEY; process.env.PI_FIXTURE_KEY = 'test-key'; let agent;
  try {
    agent = await PiDesktopAgent.create({...options,modelKey:'fixture/fixture',config:{providers:[{id:'fixture',protocol:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKeyEnv:'PI_FIXTURE_KEY',thinking:'disabled',tokenLimitField:'max_tokens',timeoutMs:5000}],models:[{provider:'fixture',id:'fixture',contextWindow:65536,maxOutputTokens:4096,tools:true}]}},new DemoProvider());
    const result = await agent.run('hello'); assert.equal(result.status,'completed',result.error); assert.equal(result.text,'Transport verified');
    assert.equal(request.path,'/v1/chat/completions'); assert.equal(request.authorization,'Bearer test-key'); assert.deepEqual(request.payload.thinking,{type:'disabled'});
    assert.equal(request.payload.max_tokens,4096); assert.equal(request.payload.max_completion_tokens,undefined);
    assert(!JSON.stringify(JSON.parse(await readFile(agent.snapshotPath,'utf8'))).includes('test-key'));
  } finally {await agent?.close(); await new Promise(resolve => server.close(resolve)); if(previous === undefined) delete process.env.PI_FIXTURE_KEY; else process.env.PI_FIXTURE_KEY = previous;}
});
test('legacy journals import only the selected branch while retaining all previous bytes',async () => {
  const {root,options} = await fixture(); const store = await SessionStore.create(root);
  const old = await store.append({kind:'message',message:{role:'user',text:'retained user',timestamp:1}});
  await store.append({kind:'message',message:{role:'user',text:'abandoned user',timestamp:2}}); await store.select(old.id); const path = store.path; await store.close();
  const before = await readFile(path,'utf8'); const agent = await PiDesktopAgent.create({...options,resume:path},new DemoProvider());
  assert.deepEqual(agent.session.messages.filter(m => m.role === 'user').map(m => m.content),['retained user']);
  await agent.close(); assert((await readFile(path,'utf8')).startsWith(before));
});
test('references in a selected skill can be read from managed folders, while unrelated external files stay blocked',async () => {
  const {root,options} = await fixture(); const folder = join(root,'.agent','managed','review'); await mkdir(folder,{recursive:true}); const skill = join(folder,'SKILL.md'), ref = join(folder,'guide.md');
  await writeFile(skill,'---\nname: review\ndescription: Review files\n---\nRead guide.md\n'); await writeFile(ref,'REFERENCE_OK');
  const external = await mkdtemp(join(tmpdir(),'pi-unrelated-')); const unrelated = join(external,'unrelated.txt'); await writeFile(unrelated,'UNRELATED_SECRET'); let target = ref;
  const messages=[]; const provider = {id:'demo',async *stream(request) {
    messages.push(...request.messages.filter(m => m.role === 'tool'));
    const done = request.messages.some(m => m.role === 'tool'); yield {type:'done',message:{role:'assistant',text:done ? 'done' : '',toolCalls:done ? [] : [{id:'read-reference',name:'read',arguments:JSON.stringify({path:target})}],provider:'demo',model:'offline',stopReason:done ? 'stop' : 'tool_use',usage:{input:0,output:0},timestamp:Date.now()}};
  }};
  const agent = await PiDesktopAgent.create({...options,resources:{extensions:[],skills:[skill],prompts:[],themes:[]}},provider);
  assert.equal((await agent.run('read reference')).status,'completed'); assert(messages.some(m => m.text.includes('REFERENCE_OK') && !m.isError)); await agent.close();
  target = unrelated; const other = await PiDesktopAgent.create({...options,resources:{extensions:[],skills:[skill],prompts:[],themes:[]}},provider);
  await other.run('read unrelated'); assert(messages.some(m => m.isError)); assert(!messages.some(m => m.text.includes('UNRELATED_SECRET'))); await other.close();
});
test('terminal-only custom UI degrades like official RPC and shutdown hooks execute',async () => {
  const {root,options} = await fixture(); const extension = join(root,'ui.ts');
  await writeFile(extension,`export default function(pi) {pi.registerCommand('terminal-ui',{description:'Test UI',handler:async(args,ctx)=>{await ctx.ui.custom(()=>{});}});pi.on('session_shutdown',()=>pi.appendEntry('closed',{ok:true}));}`);
  const agent = await PiDesktopAgent.create({...options,resources:{extensions:[extension],skills:[],prompts:[],themes:[]}},new DemoProvider());
  const result = await agent.run('/terminal-ui'); assert.equal(result.status,'completed');assert.equal(agent.bridge.dialogs.size,0);
  const path = agent.snapshotPath; await agent.close(); assert(JSON.parse(await readFile(path,'utf8')).entries.some(e => e.customType === 'closed'));
});
test('npm installation uses the real Pi package manager and does not run package install scripts',async () => {
  const {root} = await fixture();
  const files = {
    'package/package.json':JSON.stringify({name:'pi-desktop-offline-fixture',version:'1.0.0',pi:{skills:['skills']},scripts:{preinstall:'node -e "process.exit(91)"'}}),
    'package/skills/review/SKILL.md':'---\nname: review\ndescription: Review offline fixture\n---\nReview the files.\n'
  };
  const blocks=[];
  for(const [name,value] of Object.entries(files)) {
    const content = Buffer.from(value), header = Buffer.alloc(512); header.write(name); header.write('0000644\0',100); header.write('0000000\0',108); header.write('0000000\0',116);
    header.write(content.length.toString(8).padStart(11,'0')+'\0',124); header.write('00000000000\0',136); header.fill(32,148,156); header.write('0',156); header.write('ustar\0',257); header.write('00',263);
    header.write([...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148); blocks.push(header,content,Buffer.alloc((512-content.length%512)%512));
  }
  const archive = gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)])); let metadataReads=0;
  const server = createServer((req,res) => {
    if(req.url.includes('.tgz')) {res.writeHead(200,{'Content-Type':'application/octet-stream'});res.end(archive);return;}
    metadataReads++; res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({name:'pi-desktop-offline-fixture','dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{...JSON.parse(files['package/package.json']),dist:{tarball:`http://127.0.0.1:${server.address().port}/fixture.tgz`,shasum:createHash('sha1').update(archive).digest('hex')}}}}));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const vars = {npm_config_registry:`http://127.0.0.1:${server.address().port}`,npm_config_cache:join(root,'.npm-cache'),npm_config_audit:'false',npm_config_fund:'false',npm_config_fetch_retries:'0',npm_config_fetch_timeout:'5000'};
  const before = Object.fromEntries(Object.keys(vars).map(k => [k,process.env[k]])); Object.assign(process.env,vars);
  try {
    const manager = await new ResourceManager(join(root,'.profile')).load(); const list = await manager.add({source:'npm:pi-desktop-offline-fixture@1.0.0',scope:'global'},root);
    assert(metadataReads > 0); assert.equal(list.items.length,1); assert.equal(list.items[0].name,'review'); assert.equal(list.items[0].enabled,false);
    const readsBefore = metadataReads; await assert.rejects(manager.add({source:'npm:pi-desktop-offline-fixture@2.0.0',scope:'project'},root),/已添加/); assert.equal(metadataReads,readsBefore);
  } finally {for(const [key,value] of Object.entries(before)) if(value === undefined) delete process.env[key]; else process.env[key]=value; await new Promise(resolve => server.close(resolve));}
});
