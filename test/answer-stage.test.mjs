import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {PiDesktopAgent} from '../desktop/pi-agent.mjs';
import {DemoProvider} from '../dist/src/demo.js';
import {fileURLToPath} from 'node:url';

async function fixture(handler,{protocol='openai-chat',extensions=[]}={}) {
  const root=await mkdtemp(join(tmpdir(),'answer-stage-'));
  await writeFile(join(root,'hello.txt'),'fixture');
  const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const options={workspace:root,agentDir:join(root,'.profile'),modelKey:'fixture/model',tools:['read'],mode:'build',resources:{extensions,skills:[],prompts:[],themes:[]},config:{providers:[{id:'fixture',protocol,...(protocol==='openai-chat'?{thinking:'enabled'}:{}),baseUrl:`http://127.0.0.1:${server.address().port}/v1`,timeoutMs:5000}],models:[{provider:'fixture',id:'model',contextWindow:65536,maxOutputTokens:8192,tools:true}]}};
  const agent=await PiDesktopAgent.create(options,new DemoProvider());
  return {agent,root,options,async close(){await agent.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
const chunk=(res,delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'stage-fixture',object:'chat.completion.chunk',created:1,model:'model',choices:[{index:0,delta,finish_reason}]})+'\n\n');
const end=res=>{chunk(res,{},'stop');res.end('data: [DONE]\n\n');};
async function until(check) {for(let i=0;i<300;i++){if(check())return;await delay(10);}assert.fail('local streaming condition timed out');}

test('markerless completion enters an authoritative tool-free stage and streams before completion',async()=>{
  const requests=[],events=[];let release;const gate=new Promise(resolve=>release=resolve);
  const f=await fixture(async(req,res)=>{
    let body='';for await(const data of req)body+=data;requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});
    if(requests.length===1){chunk(res,{reasoning_content:'Private process',content:'An unmarked complete draft.'});end(res);}
    else {chunk(res,{reasoning_content:'Private final reasoning',content:'Final first chunk'});await gate;chunk(res,{content:' and tail.'});end(res);}
  });
  f.agent.subscribe(e=>events.push(e));
  try {
    const run=f.agent.run('Give the result');
    for(let i=0;i<100 && !events.some(e=>e.type==='text_delta' && e.text==='Final first chunk');i++)await delay(10);
    assert.equal(requests.length,2,'unmarked completed text must not be dumped into the answer area');
    assert(requests[0].messages.some(m=>typeof m.content==='string' && m.content.includes('Desktop presentation protocol')),'real native Pi request carries the protocol');
    assert.equal(requests[1].thinking.type,'enabled','reasoning remains enabled');
    assert.equal(requests[1].tool_choice,'none');assert(!requests[1].tools?.length);
    // Persistence deliberately runs independently of the provider stream.
    // Under coverage the next request can start before the old journal write.
    await until(()=>events.some(e=>e.type==='message' && e.message.role==='assistant'));
    const draft=events.find(e=>e.type==='message' && e.message.role==='assistant');assert.equal(draft.message.phase,'commentary');
    const delta=events.find(e=>e.type==='text_delta' && e.text==='Final first chunk');assert.equal(delta.phase,'final_answer');
    assert(!events.some(e=>e.type==='message' && e.messageId===delta.messageId),'first answer delta precedes persistence and message completion');
    assert(!events.some(e=>e.type==='run_end'));
    release();const result=await run;assert.equal(result.status,'completed',result.error);assert.equal(result.text,'Final first chunk and tail.');
    const saved=f.agent.store.branch().filter(e=>e.data.kind==='message' && e.data.message.role==='assistant');assert.deepEqual(saved.map(e=>e.data.message.phase),['commentary','final_answer']);
    const resume=f.agent.store.path;await f.agent.close();
    const restored=await PiDesktopAgent.create({...f.options,resume},new DemoProvider());try{assert.equal(restored.state.lastResult.status,'completed');assert.equal(restored.sessionInfo().lastAssistantText,'Final first chunk and tail.');}finally{await restored.close();}
  } finally {release();await f.close();}
});

test('Responses public phase is available on the first delta rather than only item.done',async()=>{
  const events=[],requests=[];let release;const gate=new Promise(resolve=>release=resolve);
  const f=await fixture(async(req,res)=>{
    let body='';for await(const data of req)body+=data;requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=data=>res.write('data: '+JSON.stringify(data)+'\n\n');
    const item={id:'msg_fixture',type:'message',role:'assistant',phase:'final_answer',status:'in_progress',content:[]};
    send({type:'response.created',response:{id:'resp_fixture',status:'in_progress',model:'model',output:[]}});
    send({type:'response.output_item.added',output_index:0,item});
    send({type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:'Native first chunk'});await gate;
    send({type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:' and tail.'});
    const completed={...item,status:'completed',content:[{type:'output_text',text:'Native first chunk and tail.',annotations:[]}]};
    send({type:'response.output_item.done',output_index:0,item:completed});
    send({type:'response.completed',response:{id:'resp_fixture',status:'completed',model:'model',output:[completed],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}});res.end();
  },{protocol:'openai-responses'});
  f.agent.subscribe(e=>events.push(e));
  try {
    const run=f.agent.run('Native response test');await until(()=>events.some(e=>e.type==='text_delta'));
    const first=events.find(e=>e.type==='text_delta');assert.equal(first.phase,'final_answer');assert.equal(first.text,'Native first chunk');assert(!events.some(e=>e.type==='run_end'));
    release();assert.equal((await run).status,'completed');assert.equal(requests.length,1,'native phase requires no extra provider request');
  } finally {release();await f.close();}
});

test('cancelling the tool-free answer stage retains partial output and does not loop',async()=>{
  let count=0;const events=[];
  const f=await fixture(async(req,res)=>{for await(const data of req){}count++;res.writeHead(200,{'Content-Type':'text/event-stream'});if(count===1){chunk(res,{content:'Draft'});end(res);}else chunk(res,{content:'Partial final'});});
  f.agent.subscribe(e=>events.push(e));
  try {const run=f.agent.run('Stop test');await until(()=>events.some(e=>e.type==='text_delta' && e.phase==='final_answer'));await f.agent.abort();const result=await run;assert.equal(result.status,'cancelled');assert.equal(result.text,'Partial final');assert.equal(count,2);assert.equal(f.agent.busy,false);}finally{await f.close();}
});

test('length-limited unclassified output never launches a final-answer repair',async()=>{
  let count=0;
  const f=await fixture(async(req,res)=>{for await(const data of req){}count++;res.writeHead(200,{'Content-Type':'text/event-stream'});chunk(res,{content:'Incomplete'},'length');res.end('data: [DONE]\n\n');});
  try {const result=await f.agent.run('Length test');assert.equal(result.status,'limit');assert.equal(count,1);}finally{await f.close();}
});

test('authoritative phase overrides a wrong prefix and tool capability restores for the next task',async()=>{
  const requests=[];
  const f=await fixture(async(req,res)=>{let body='';for await(const data of req)body+=data;requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});chunk(res,{content:requests.length===1?'Unclassified draft':requests.length===2?'[[agent:progress]]\nActual final answer':'[[agent:answer]]\nNext answer'});end(res);});
  try {assert.equal((await f.agent.run('First')).text,'Actual final answer');assert.equal((await f.agent.run('Second')).text,'Next answer');assert.equal(requests.length,3);assert(requests[2].tools?.length);assert.notEqual(requests[2].tool_choice,'none');}finally{await f.close();}
});

test('a failing answer-stage request remains failed without promoting the old draft',async()=>{
  let count=0;const events=[];
  const f=await fixture(async(req,res)=>{for await(const data of req){}count++;if(count===1){res.writeHead(200,{'Content-Type':'text/event-stream'});chunk(res,{content:'Old draft'});end(res);}else {res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'fixture invalid request',type:'invalid_request_error'}}));}});
  f.agent.subscribe(e=>events.push(e));
  try {const result=await f.agent.run('Failure');assert.equal(result.status,'failed');assert.match(result.error,/fixture invalid request/);assert.equal(count,2);assert.equal(events.find(e=>e.type==='message' && e.message.text==='Old draft').message.phase,'commentary');}finally{await f.close();}
});

test('provider violating tool_choice none is blocked and cannot loop or read a file',async()=>{
  let count=0;const events=[];
  const f=await fixture(async(req,res)=>{for await(const data of req){}count++;res.writeHead(200,{'Content-Type':'text/event-stream'});if(count===1){chunk(res,{content:'Old draft'});end(res);}else {chunk(res,{tool_calls:[{index:0,id:'forbidden',type:'function',function:{name:'read',arguments:'{"path":"hello.txt"}'}}]},'tool_calls');res.end('data: [DONE]\n\n');}});
  f.agent.subscribe(e=>events.push(e));
  try {const result=await f.agent.run('Guard');assert.notEqual(result.status,'completed');assert.equal(count,2);assert(!events.some(e=>e.type==='tool_end' && e.result.text.includes('1: fixture')));}finally{await f.close();}
});

test('an empty authoritative answer is a failure rather than a successful completion',async()=>{
  let count=0;
  const f=await fixture(async(req,res)=>{for await(const data of req){}count++;res.writeHead(200,{'Content-Type':'text/event-stream'});if(count===1)chunk(res,{content:'Draft'});end(res);});
  try {const result=await f.agent.run('Empty');assert.equal(result.status,'failed');assert.match(result.error,/未返回最终回答内容/);assert.equal(count,2);}finally{await f.close();}
});

test('Anthropic uses its native none choice and streams markerless final text with tools disabled',async()=>{
  const requests=[],events=[];let release;const gate=new Promise(resolve=>release=resolve);
  const f=await fixture(async(req,res)=>{
    let body='';for await(const data of req)body+=data;requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=data=>res.write('event: '+data.type+'\ndata: '+JSON.stringify(data)+'\n\n');
    send({type:'message_start',message:{id:'msg_anthropic',type:'message',role:'assistant',model:'model',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
    send({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
    send({type:'content_block_delta',index:0,delta:{type:'text_delta',text:requests.length===1?'Unmarked draft':'Anthropic live answer'}});if(requests.length===2)await gate;
    send({type:'content_block_stop',index:0});send({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}});send({type:'message_stop'});res.end();
  },{protocol:'anthropic'});f.agent.subscribe(e=>events.push(e));
  try {const run=f.agent.run('Anthropic streaming');await until(()=>events.some(e=>e.type==='text_delta' && e.text==='Anthropic live answer'));assert.deepEqual(requests[1].tool_choice,{type:'none'});assert(requests[1].tools?.some(t=>t.name==='read'));assert.equal(events.find(e=>e.type==='text_delta' && e.text==='Anthropic live answer').phase,'final_answer');assert(!events.some(e=>e.type==='run_end'));release();assert.equal((await run).status,'completed');assert.equal(requests.length,2);}finally{release();await f.close();}
});

test('Responses phase arriving only at item.done cannot dump a completed buffer into the answer',async()=>{
  let count=0;const events=[];let release;const gate=new Promise(resolve=>release=resolve);
  const f=await fixture(async(req,res)=>{
    for await(const data of req){}count++;res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=data=>res.write('data: '+JSON.stringify(data)+'\n\n');
    const item={id:'msg_late',type:'message',role:'assistant',status:'in_progress',content:[]};
    send({type:'response.created',response:{id:'resp_late',status:'in_progress',model:'model',output:[]}});send({type:'response.output_item.added',output_index:0,item});
    const text=count===1?'Fully buffered draft':'Truly live answer';send({type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:text});if(count===2)await gate;
    const completed={...item,phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]};send({type:'response.output_item.done',output_index:0,item:completed});send({type:'response.completed',response:{id:'resp_late',status:'completed',model:'model',output:[completed],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}});res.end();
  },{protocol:'openai-responses'});
  f.agent.subscribe(e=>events.push(e));
  try {const run=f.agent.run('Late native metadata');await until(()=>events.some(e=>e.type==='text_delta' && e.text==='Truly live answer'));await until(()=>events.some(e=>e.type==='message' && e.message.text==='Fully buffered draft'));assert.equal(count,2);assert.equal(events.find(e=>e.type==='message' && e.message.text==='Fully buffered draft').message.phase,'commentary');assert.equal(events.find(e=>e.type==='text_delta' && e.text==='Truly live answer').phase,'final_answer');assert(!events.some(e=>e.type==='run_end'));release();assert.equal((await run).status,'completed');}finally{release();await f.close();}
});

for(const budget of [3000,50])test(`goal charges the markerless answer stage before verification (budget ${budget})`,async()=>{
  const requests=[],events=[];
  const f=await fixture(async(req,res)=>{
    let body='';for await(const data of req)body+=data;const payload=JSON.parse(body);requests.push(payload);res.writeHead(200,{'Content-Type':'text/event-stream'});
    const verify=payload.messages.some(m=>typeof m.content==='string' && m.content.includes('independently evaluate goal'));
    chunk(res,{content:verify?'{"verdict":"met","reason":"交付内容满足条件"}':requests.length===1?'Unmarked deliverable draft':'Final deliverable'});
    chunk(res,{},'stop');res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})+'\n\n');res.end('data: [DONE]\n\n');
  },{extensions:[fileURLToPath(new URL('../packages/pi-workflows/extensions/goal.ts',import.meta.url))]});
  f.agent.subscribe(e=>events.push(e));
  try {
    await f.agent.command(`/goal --tokens ${budget} 写一句测试结果作为交付内容`);await until(()=>events.some(e=>e.type==='run_end'));
    const card=f.agent.bridge.cards.get('goal');
    assert.equal(requests[1].tool_choice,'none');
    if(budget===3000){assert.equal(requests.length,3);assert.equal(card.status,'complete');assert.equal(card.usage.tokens,90);assert.equal(card.usage.evaluationTokens,30);assert.equal(card.usage.rounds,1);}
    else {assert.equal(requests.length,2);assert.equal(requests[1].max_tokens,20);assert.equal(card.status,'budget_limited');assert.equal(card.usage.tokens,60);assert.equal(card.usage.evaluationTokens,0);}
  }finally{await f.close();}
});
