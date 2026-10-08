import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {tasks} from '../test/agent-evals/catalog.mjs';
import {materialize,grade,command} from '../test/agent-evals/grader.mjs';
const [base,folder,id,reserved,python]=process.argv.slice(2),task=tasks.find(t=>t.id===id),allowance=Number(reserved);
if(!task||!Number.isSafeInteger(allowance))throw new Error('Invalid evaluation assignment');
await mkdir(folder,{recursive:true});const workspace=resolve(folder,'project');await mkdir(workspace);
const protectedHashes=await materialize(task,workspace),grader=resolve(folder,'trusted');
const report={task:id,language:task.language,scenario:task.scenario||'build',version:JSON.parse(await readFile(resolve(base,'package.json'))).version,model:'deepseek/deepseek-flash',allowance,usedTokens:0,chargedTokens:0,usage:{input:0,output:0,cacheRead:0,cacheWrite:0},requests:0,unknownUsage:false,toolFailures:0,startedAt:new Date().toISOString()};
const baseline=await grade(task,workspace,grader,{python,protectedHashes});if(baseline.passed)throw new Error('Fixture does not prove a baseline failure');report.baselineFailed=true;
const {PiDesktopAgent}=await import(pathToFileURL(resolve(base,'desktop/pi-agent.mjs')).href),config=JSON.parse(await readFile(resolve(base,'configs/deepseek.json')));
config.models=config.models.filter(m=>m.id==='deepseek-flash').map(m=>({...m,maxOutputTokens:4096,contextWindow:65536}));
const options={workspace,config,modelKey:config.defaultModel,tools:['read','list','write','edit','shell'],mode:'build',agentDir:resolve(folder,'profile'),resources:{extensions:['plan','goal'].map(n=>resolve(base,'packages/pi-workflows/extensions',n+'.ts')),skills:[],prompts:[],themes:[]}};
let agent=await PiDesktopAgent.create(options),result,runEnds=[];const started=Date.now();
function installBudget(target){const original=target.runtime.streamSimple.bind(target.runtime);
target.runtime.streamSimple=(model,context,opts={})=>{
  const stream=createAssistantMessageEventStream();
  void(async()=>{
    // UTF-8 byte upper bound plus schema/protocol margin. Unknown usage retains
    // this reservation. No request starts unless its full upper bound fits.
    const bound=2*Buffer.byteLength(JSON.stringify(context))+16384;
    if(report.chargedTokens+bound>allowance){const message={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'error',errorMessage:'Evaluation token reservation exhausted',timestamp:Date.now()};stream.push({type:'error',reason:'error',error:message});stream.end(message);return;}
    report.requests++;let confirmed=false;report.chargedTokens+=bound;await save();
    try{for await(const event of original(model,context,{...opts,maxTokens:4096})){if(event.type==='done'||event.type==='error'){const usage=(event.message||event.error).usage,total=usage?.totalTokens;if(total>0){confirmed=true;report.usedTokens+=total;report.chargedTokens+=total-bound;for(const key of Object.keys(report.usage))report.usage[key]+=usage[key]||0;}else report.unknownUsage=true;}stream.push(event);}stream.end();}
    catch(error){report.error=error.message;const message={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:opts.signal?.aborted?'aborted':'error',errorMessage:error.message,timestamp:Date.now()};stream.push({type:'error',reason:message.stopReason,error:message});stream.end(message);}
    finally{if(!confirmed)report.unknownUsage=true;await save();}
  })();return stream;
};}
installBudget(agent);
let logging=Promise.resolve();function subscribe(owner){owner.subscribe(event=>{if(!report.firstVisibleMs&&event.type==='text_delta')report.firstVisibleMs=Date.now()-started;if(event.type==='tool_end'&&event.result.isError)report.toolFailures++;if(event.type==='run_end')runEnds.push(event.result);logging=logging.then(()=>writeFile(resolve(folder,'trajectory.jsonl'),JSON.stringify(event)+'\n',{flag:'a'}));});}
subscribe(agent);let saving=Promise.resolve();function save(){const snapshot=JSON.stringify(report,null,2);saving=saving.then(async()=>{const path=resolve(folder,'report.json'),temporary=path+'.tmp';await writeFile(temporary,snapshot);await rename(temporary,path);});return saving;}
const timeout=setTimeout(()=>{report.timedOut=true;void agent.abort();},180000);
const prompt=`这是独立评测项目。要求：${task.requirement}\n仅允许修改 ${task.allowed.join('、')}。禁止修改 test、数据、验收规则，禁止安装依赖。先读取相关源文件和测试，运行测试观察失败，修复后再次执行：${command(task,python)}。最后用中文简短报告证据。`;
async function until(check){for(let i=0;i<3600;i++){if(check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Evaluation workflow timeout');}
try{
  if(task.scenario==='plan') {
    await agent.command('/plan on');await agent.run(prompt);report.planReadOnly=task.allowed.every(p=>task.files[p]!==undefined);
    for(const[path,text]of Object.entries(task.files))if(task.allowed.includes(path)&&!Buffer.from(await readFile(resolve(workspace,path))).equals(Buffer.from(text)))throw new Error('Plan mutated source before approval');
    if(agent.bridge.cards.get('plan')?.status!=='ready')throw new Error('Planning finished without submitting an executable plan');
    const count=runEnds.length,executing=agent.command('/plan execute');await until(()=>agent.bridge.state.dialogs.length);agent.bridge.respond({id:agent.bridge.state.dialogs[0].id,confirmed:true});await executing;await until(()=>runEnds.length>count);result=runEnds.at(-1);
  } else if(task.scenario==='goal'){await agent.command('/goal '+prompt+' --tokens '+Math.min(allowance,80000)+' --max-turns 8');await until(()=>runEnds.length>0);result=runEnds.at(-1);report.goalStatus=agent.bridge.cards.get('goal')?.status;}
  else if(task.scenario==='recovery'){
    let aborted=false;const unsubscribe=agent.subscribe(event=>{if(!aborted&&event.type==='tool_end'){aborted=true;void agent.abort();}});await agent.run(prompt);unsubscribe();const session=agent.store.path;await agent.close();agent=await PiDesktopAgent.create({...options,resume:session});
    // Explicit cancellation resume uses valid Pi history; crash recovery is
    // separately covered by real process fault tests.
    installBudget(agent);report.reopened=true;subscribe(agent);result=await agent.run(prompt+' 上次已停止，请先核实当前文件，再继续未完成内容。');
  }else result=await agent.run(prompt);
  report.result=result;report.grader=await grade(task,workspace,grader,{python,protectedHashes});report.passed=result?.status==='completed'&&report.grader.passed;
}catch(error){report.error=error.message;report.passed=false;}
finally{clearTimeout(timeout);await agent.close();await logging;report.durationMs=Date.now()-started;report.endedAt=new Date().toISOString();await save();}
console.log(JSON.stringify({task:id,passed:report.passed,tokens:report.usedTokens,chargedTokens:report.chargedTokens,durationMs:report.durationMs,reason:report.grader?.reason||report.error}));
