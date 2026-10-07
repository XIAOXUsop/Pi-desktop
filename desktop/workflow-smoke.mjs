import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Exercise the real renderer, worker and Pi transport using a loopback-only model.
export async function verifyWorkflows({actions,project,js,until,snapshot,bundledSource}) {
  let scenario='plan',main=0,evaluations=0,heldResponse;
  const errors=[];
  const server=createServer(async(req,res)=>{
    try {
      let body='';for await(const chunk of req)body+=chunk;
      const payload=JSON.parse(body);
      const evaluation=payload.messages.some(message=>typeof message.content==='string' && message.content.includes('You independently evaluate goal completion'));
      const step=evaluation?++evaluations:++main;
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'workflow-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
      const tool=(name,args)=>send({tool_calls:[{index:0,id:`${scenario}-${step}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');
      if(evaluation)send({content:JSON.stringify({verdict:step===1?'continue':'met',reason:step===1?'还需修改文件并读取核对。':'已读取修改后的文件，验收通过。'})},'stop');
      else if(scenario==='plan') {
        if(step===1)tool('plan_question',{question:'选择修改方式',options:['保留原文字','改成 after']});
        else if(step===2)tool('submit_plan',{plan:'审批后将 workflow.txt 改为 after，并读取确认。',steps:['修改 workflow.txt','读取确认'],acceptance:['文件内容为 after']});
        else send({content:'[[agent:answer]]\n计划已准备好，请确认后执行。'},'stop');
      } else if(scenario==='execute') {
        if(step===1)tool('write',{path:'workflow.txt',content:'after'});
        else send({content:'[[agent:answer]]\n按批准的计划修改完成。'},'stop');
      } else if(scenario==='goal') {
        if(step===1 || step===4)tool('read',{path:'workflow.txt'});
        else if(step===3)tool('write',{path:'workflow.txt',content:'after'});
        else {send({reasoning_content:'根据文件结果核对目标。'});send({content:'[[agent:answer]]\n'});await delay(40);send({content:step===2?'已读取当前文件。':'已修改文件，并读取核对。'},'stop');}
      } else {send({reasoning_content:'等待停止测试。',content:'[[agent:progress]]\n正在检查项目。'});heldResponse=res;return;}
      res.write('data: '+JSON.stringify({id:'workflow-fixture',choices:[],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})+'\n\n');
      res.end('data: [DONE]\n\n');
    } catch(error){errors.push(error.message);if(!res.destroyed)res.destroy();}
  });
  await new Promise(accept=>server.listen(0,'127.0.0.1',accept));
  const input=text=>js(`document.getElementById('prompt').focus();document.getElementById('prompt').value=${JSON.stringify(text)};document.getElementById('prompt').setSelectionRange(${text.length},${text.length});document.getElementById('prompt').dispatchEvent(new InputEvent('input'));`);
  const submit=async text=>{await input(text);await js("document.getElementById('send').click()");};
  const idle=()=>until(async()=>!(await actions.state()).agent.busy && await js("document.getElementById('stop').hidden && !document.getElementById('send').disabled"),'workflow idle');
  const card=async id=>(await actions.state()).agent.extensionUI.cards.find(item=>item.id===id);
  const sync=async()=>{await submit('/reload');await idle();};
  const fresh=async()=>{await js("document.getElementById('new-session').click()");await idle();};
  const click=label=>js(`Array.from(document.querySelectorAll('#workflow-cards button')).find(button=>button.textContent===${JSON.stringify(label)}).click()`);
  try {
    await actions.setMode({mode:'build'});
    await actions.addResource({source:bundledSource.root,scope:'global'});
    for(const item of (await actions.listResources()).items.filter(item=>item.path.startsWith(bundledSource.root)))await actions.toggleResource({id:item.id,enabled:true,scope:'global'});
    await actions.setPermissions({write:true,shell:false});
    await actions.addModel({providerId:'workflow_fixture',modelId:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-chat',legacyTokens:true,contextWindow:32000,maxOutputTokens:1024});
    await actions.saveKey({providerId:'workflow_fixture',key:'loopback-test-only',persist:false});
    await sync();await fresh();
    const workspace=(await actions.state()).project;
    await writeFile(resolve(workspace,'workflow.txt'),'before');
    await input('/pl');await until(()=>js("document.querySelector('#prompt-options [data-value=plan]')!==null"),'plan slash completion');
    await input('/goal pa');await until(()=>js("document.querySelector('#prompt-options [data-value=pause]')!==null"),'goal parameter completion');
    await submit('/plan 先探索 workflow.txt 的修改方案');
    await until(()=>js("document.getElementById('extension-dialog').open && document.querySelector('.extension-choices')!==null"),'plan clarification dialog');
    await js("Array.from(document.querySelectorAll('.extension-choices button')).find(button=>button.textContent==='填写自己的答案').click()");
    await until(()=>js("document.querySelector('#extension-dialog input')!==null"),'plan free text answer');
    await js("document.querySelector('#extension-dialog input').value='改成 after';document.querySelector('#extension-dialog form').requestSubmit()");
    await idle();assert.equal((await card('plan')).status,'ready');assert.equal(await readFile(resolve(workspace,'workflow.txt'),'utf8'),'before');
    await js("document.querySelector('[data-workflow=plan] details').open=true");await snapshot('desktop-workflow-plan.png');
    await click('执行计划');await until(()=>js("document.getElementById('extension-dialog').open"),'execute plan confirmation');
    await js("Array.from(document.querySelectorAll('#extension-dialog button')).find(button=>button.textContent==='取消').click()");await idle();assert.equal((await actions.state()).mode,'plan');assert.equal(main,3);
    scenario='execute';main=0;
    await click('执行计划');await until(()=>js("document.getElementById('extension-dialog').open"),'second plan confirmation');
    await js("document.querySelector('#extension-dialog form').requestSubmit()");await until(async()=>main===2 && !(await actions.state()).agent.busy,'approved execution');await idle();
    assert.equal(await readFile(resolve(workspace,'workflow.txt'),'utf8'),'after');assert.equal((await actions.state()).mode,'build');
    scenario='goal';main=0;evaluations=0;await fresh();await writeFile(resolve(workspace,'workflow.txt'),'before');
    await submit('/goal workflow.txt 内容为 after，并读取核对 --tokens 20k --max-turns 5');
    await until(async()=>(await card('goal'))?.status==='complete','goal independent verification');await idle();
    assert.equal(main,5);assert.equal(evaluations,2);assert.equal((await card('goal')).usage.tokens,210);assert.equal((await card('goal')).usage.evaluationTokens,60);
    assert.equal(await readFile(resolve(workspace,'workflow.txt'),'utf8'),'after');
    assert(await js("document.querySelectorAll('.execution-group').length===1 && !document.querySelector('.execution-group').open && document.querySelectorAll('#messages > .message.assistant').length>=1"),'goal continuation retains one collapsed process with final output');
    await js("document.querySelector('[data-workflow=goal] details').open=true");await snapshot('desktop-workflow-goal.png');
    scenario='held';main=0;await fresh();await submit('/goal 持续检查项目');await until(()=>js("!document.getElementById('stop').hidden"),'goal running');
    await submit('/goal pause');await until(async()=>(await card('goal'))?.status==='paused','pause via composer during stream');
    assert.equal(main,1);await js("document.getElementById('stop').click()");await idle();
    await sync();assert.equal((await card('goal')).status,'paused');assert.equal(main,1);await snapshot('desktop-workflow-paused.png');
    await click('清除');await until(async()=>(await card('goal'))?.status==='idle','clear goal');assert(await js("document.getElementById('workflow-cards').hidden"));
    assert.deepEqual(errors,[]);
    return ['bundled plan and goal independently load as official Pi extensions','native workflow slash and parameter completion','plan select and free text clarification in real desktop','plan confirmation cancellation performs no writes','approved plan restores host permissions and performs edits','goal continuation uses one Pi activity with collapsed process and streamed output','independent loopback verification and cumulative token accounting','goal pause through composer during streaming','stop and reload never automatically resume goal','clear removes workflow card'];
  } finally {
    heldResponse?.destroy();server.closeAllConnections();await new Promise(accept=>server.close(accept));
  }
}
