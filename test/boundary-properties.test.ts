import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readSse} from '../src/providers/sse.js';
import {bounded} from '../src/util.js';
import {Workspace} from '../src/tools/workspace.js';
import {fileTools} from '../src/tools/files.js';
import {temp} from './helpers.js';

// Fixed seeds make generated failures reproducible without a new dependency.
function random(seed:number) {
  let state=seed>>>0;
  return () => {state=(Math.imul(state,1664525)+1013904223)>>>0;return state>>>8;};
}
function stream(chunks:Uint8Array[]) {
  return new ReadableStream<Uint8Array>({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}});
}
async function collect(body:ReadableStream<Uint8Array>,signal=new AbortController().signal) {
  const events=[];for await(const event of readSse(body,signal))events.push(event);return events;
}

test('SSE event content is invariant across generated network chunks and all line endings',async()=>{
  const expected=[{event:'custom',data:'你好🙂\né café'},{event:'message',data:'尾部'}];
  for(const ending of ['\r\n','\n','\r'])for(let seed=1;seed<=32;seed++){
    const encoded=new TextEncoder().encode([': heartbeat','event: custom','data: 你好🙂','data: é café','','data: 尾部'].join(ending));
    const next=random(seed),chunks=[];
    for(let offset=0;offset<encoded.length;){const end=Math.min(encoded.length,offset+1+next()%13);chunks.push(encoded.slice(offset,end));offset=end;}
    const body=stream(chunks);
    assert.deepEqual(await collect(body),expected,`seed ${seed}, ending ${JSON.stringify(ending)}`);
    assert.equal(body.locked,false);
  }
});

test('SSE cleanup runs for already-aborted consumers and consumers that stop after one event',async()=>{
  const abort=new AbortController();abort.abort(new Error('cancel before start'));
  let cancelled=0;
  const before=new ReadableStream<Uint8Array>({cancel(){cancelled++;}});
  await assert.rejects(collect(before,abort.signal),/cancel before start/);
  assert.equal(cancelled,1);assert.equal(before.locked,false);
  const after=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('data: first\n\ndata: second\n\n'));},cancel(){cancelled++;}});
  const received=[];for await(const event of readSse(after,new AbortController().signal)){received.push(event.data);break;}
  assert.deepEqual(received,['first']);assert.equal(cancelled,2);assert.equal(after.locked,false);
});

test('SSE network failure rejects after delivered events and releases the reader',async()=>{
  let pulls=0;
  const body=new ReadableStream<Uint8Array>({pull(c){if(pulls++===0)c.enqueue(new TextEncoder().encode('data: delivered\n\n'));else c.error(new Error('fixture connection reset'));}});
  const received:string[]=[];
  await assert.rejects(async()=>{for await(const event of readSse(body,new AbortController().signal))received.push(event.data);},/fixture connection reset/);
  assert.deepEqual(received,['delivered']);assert.equal(body.locked,false);
});

test('SSE rejects unterminated multibyte lines and aggregate multiline overflow without retaining a lock',async()=>{
  const encoder=new TextEncoder(),limit=4*1024*1024;
  for(const [name,chunks]of [
    ['line',[encoder.encode('data: '+'你'.repeat(Math.floor(limit/3)+1))]],
    ['event',[encoder.encode('data: '+'x'.repeat(limit/2)+'\n'),encoder.encode('data: '+'x'.repeat(limit/2+1)+'\n\n')]],
  ] as const){
    const body=stream([...chunks]);await assert.rejects(collect(body),new RegExp(`SSE ${name} exceeds`));assert.equal(body.locked,false);
  }
});

test('bounded generated Unicode has a maximal valid prefix and obeys varying byte budgets',()=>{
  const symbols=['a','é','你','🙂','\uFEFF','\r','\n','Ω'],next=random(20261005),marker='\n[output truncated]',markerBytes=Buffer.byteLength(marker);
  for(let trial=0;trial<256;trial++){
    const source=Array.from({length:60},()=>symbols[next()%symbols.length]).join(''),budget=next()%180,result=bounded(source,budget);
    assert(Buffer.byteLength(result)<=budget,`trial ${trial}, budget ${budget}`);assert(!result.includes('\uFFFD'));
    if(Buffer.byteLength(source)<=budget){assert.equal(result,source);continue;}
    if(budget<markerBytes)continue;
    assert(result.endsWith(marker));const prefix=result.slice(0,-marker.length);
    assert(source.startsWith(prefix));const following=Array.from(source.slice(prefix.length))[0];assert(following);
    assert(Buffer.byteLength(prefix+following)>budget-markerBytes,`prefix must use available bytes: trial ${trial}`);
  }
});

test('generated mixed-ending files preserve every byte outside a unique Unicode edit',async t=>{
  const {root}=await temp(t),workspace=await Workspace.open(root),edit=fileTools(workspace).find(tool=>tool.name==='edit')!,next=random(20261005);
  for(let trial=0;trial<32;trial++){
    const ending=()=>next()%2?'\r\n':'\n';
    const original=(trial%2?'\uFEFF':'')+Array.from({length:12},(_,index)=>`行${index}🙂${index===6?'唯一待改文字':'café'}${ending()}`).join('');
    const path=`generated-${trial}.txt`;await writeFile(resolve(root,path),original);
    await edit.execute({path,oldText:'唯一待改文字',newText:'已更新Ω'}, {workspace:root,signal:new AbortController().signal,callId:`edit-${trial}`,update(){}});
    assert.deepEqual(await readFile(resolve(root,path)),Buffer.from(original.replace('唯一待改文字','已更新Ω')),`trial ${trial}`);
  }
});
