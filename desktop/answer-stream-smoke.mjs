import assert from 'node:assert/strict';
import {createServer} from 'node:http';

export async function verifyAnswerStreaming({actions,js,until,snapshot}) {
  assert(await js(`import('local-agent://app/execution-ui.js').then(({executionView})=>{const host=document.createElement('div');document.body.append(host);const node=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};const v=executionView({messages:host,node,icon:()=>node('span')});v.start();v.commentary(node('div','progress-message','draft'));const answer=node('div','message assistant','answer');v.output(answer,{streaming:true});const user=node('div','message user','late user');host.append(user);v.user(user);const ok=host.children[0]===user && host.children[1].classList.contains('execution-group') && host.children[2]===answer;host.remove();return ok;});`),'late user persistence moves the process and streaming answer together');
  assert(await js(`import('local-agent://app/execution-ui.js').then(({executionView})=>{const host=document.createElement('div');document.body.append(host);const node=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};const v=executionView({messages:host,node,icon:()=>node('span')});v.start();const answer=node('div','message assistant','answer');v.output(answer,{streaming:true});const user=node('div','message user','late user');host.append(user);v.user(user);const ok=host.children[0]===user && host.children[1]===answer;host.remove();return ok;});`),'plain answers remain below a user event arriving after the first token');
  const requests=[];let releaseTail,releaseEnd;
  const tailGate=new Promise(resolve=>releaseTail=resolve),endGate=new Promise(resolve=>releaseEnd=resolve);
  const server=createServer(async(req,res)=>{
    let body='';for await(const data of req)body+=data;requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'desktop-answer',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    if(requests.length===1)send({reasoning_content:'隐藏的执行思考',content:'UNCLASSIFIED_DRAFT_仅供执行过程'});
    else if(requests.length===2){send({reasoning_content:'隐藏的回答思考',content:'实时答案的首段'});await tailGate;send({content:'，以及第二段。'});await endGate;}
    else send({content:'[[agent:answer]]\n下一条正常流式回答。'});
    send({},'stop');res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await actions.setMode({mode:'build'});await actions.setPermissions({write:false,shell:false});
    await actions.addModel({providerId:'answer_fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-chat',legacyTokens:true,contextWindow:32000,maxOutputTokens:1024});
    await actions.saveKey({providerId:'answer_fixture',key:'loopback-only',persist:false});
    const previous=(await actions.state()).agent.sessionId;await js("document.getElementById('new-session').click()");
    await until(async()=> (await actions.state()).agent.sessionId!==previous && await js("document.getElementById('model-select').value==='answer_fixture/fixture' && !document.getElementById('send').disabled && document.querySelector('.welcome')!==null"),'streaming fixture ready');
    await js("document.getElementById('prompt').value='验证没有标记时的真实流式显示';document.getElementById('send').click()");
    await until(()=>js("document.querySelector('#messages > .message.assistant')?.textContent.includes('实时答案的首段')"),'unmarked answer first chunk visible in actual desktop');
    assert.equal(requests.length,2);assert.equal(requests[1].tool_choice,'none');assert(!requests[1].tools?.length);
    assert(await js("!document.getElementById('stop').hidden && document.querySelector('#messages > .message.assistant').getAttribute('aria-busy')==='true'"),'first answer chunk paints while connection and task remain open');
    assert(await js("document.querySelector('.execution-status').textContent==='正在输出'"),'late thinking events cannot put an already streaming answer back into thinking');
    await until(()=>js("document.querySelector('#messages > .message.user')!==null"),'user journal event visible');
    assert(await js("const user=document.querySelector('#messages > .message.user'),group=document.querySelector('.execution-group'),answer=document.querySelector('#messages > .message.assistant');(user.compareDocumentPosition(group)&Node.DOCUMENT_POSITION_FOLLOWING)!==0 && group.nextElementSibling===answer"),'live layout remains user then collapsed process then streaming answer');
    assert(await js("Array.from(document.querySelectorAll('#messages > .message.assistant')).every(n=>!n.textContent.includes('UNCLASSIFIED_DRAFT') && !n.textContent.includes('隐藏')) && !document.querySelector('.execution-group').open"),'draft and reasoning stay inside a closed execution process');
    assert(await js("new Promise(resolve=>{let frames=0,clean=true;const paint=()=>{clean &&= Array.from(document.querySelectorAll('#messages > .message.assistant')).every(n=>!n.textContent.includes('UNCLASSIFIED_DRAFT') && !n.textContent.includes('隐藏'));if(++frames===20)resolve(clean);else requestAnimationFrame(paint);};paint();})"),'twenty actual paint frames never flash hidden process');
    releaseTail();await until(()=>js("document.querySelector('#messages > .message.assistant')?.textContent.includes('以及第二段')"),'answer grows before end event');
    assert(await js("!document.getElementById('stop').hidden && document.querySelectorAll('#messages > .message.assistant').length===1"),'answer tail paints before task completion with no duplicate bubble');
    await snapshot('desktop-answer-stage-streaming.png');releaseEnd();
    await until(()=>js("document.getElementById('stop').hidden && !document.getElementById('send').disabled"),'answer stage settled');
    const history=await actions.history();const replies=history.entries.filter(e=>e.data.kind==='message' && e.data.message.role==='assistant');
    assert.deepEqual(replies.map(e=>e.data.message.phase),['commentary','final_answer']);
    await js("document.getElementById('prompt').value='继续下一条任务';document.getElementById('send').click()");
    await until(()=>js("document.getElementById('stop').hidden && document.getElementById('messages').textContent.includes('下一条正常流式回答')"),'normal next task after answer continuation');
    assert.equal(requests.length,3);assert(requests[2].tools?.some(t=>t.function.name==='read'),'tool declarations restore on the next task');assert.notEqual(requests[2].tool_choice,'none');
    return ['markerless completion uses an authoritative tool-free answer stage','answer first chunk paints while provider stream stays open','answer tail paints before completion without duplication','closed process never flashes across twenty answer-stage paint frames','answer-stage journal persists draft and answer phases','next task restores tools and avoids an unnecessary final request','late user persistence retains process and answer order','plain fast answers remain below the user message'];
  } finally {releaseTail();releaseEnd();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
