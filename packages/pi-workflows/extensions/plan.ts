import {Type} from 'typebox';
import {restore,toolResult,completions,publish} from '../shared.mjs';

const TYPE='local-workflow-plan';
const safeTools=new Set(['read','list','grep','find','ls','submit_plan','plan_question','get_goal']);
export default function(pi) {
  let state={phase:'idle',text:'',steps:[],acceptance:[]},previousTools=[],ctx;
  function show() {
    if(!ctx)return;
    const active=['planning','ready'].includes(state.phase);
    publish(pi,ctx,'plan',{title:'计划',status:state.phase,statusText:{idle:'未开启',planning:'只读探索',ready:'等待执行',executing:'已交给执行'}[state.phase],mode:active?'plan':'build',body:state.text,steps:state.steps,acceptance:state.acceptance},active?[{label:'继续完善',command:'/plan refine'},{label:'执行计划',command:'/plan execute',disabled:state.phase!=='ready'},{label:'退出规划',command:'/plan off'}]:[]);
    pi.events.emit('workbench:plan-state',{active,phase:state.phase});
  }
  function persist() {pi.appendEntry(TYPE,structuredClone(state));show();}
  function enter() {
    if(!['planning','ready'].includes(state.phase))previousTools=pi.getActiveTools();
    state.phase='planning';pi.setActiveTools([...new Set([...previousTools.filter(n=>safeTools.has(n)),'submit_plan','plan_question'])]);persist();
  }
  function leave(phase='idle') {
    const active=['planning','ready'].includes(state.phase);state.phase=phase;
    if(active)pi.setActiveTools(previousTools.filter(n=>pi.getAllTools().some(t=>t.name===n)));persist();
  }
  function reload(_event,current) {
    ctx=current;state=restore(ctx,TYPE) || {phase:'idle',text:'',steps:[],acceptance:[]};
    previousTools=pi.getActiveTools().filter(n=>!['submit_plan','plan_question'].includes(n));
    if(['planning','ready'].includes(state.phase))pi.setActiveTools([...previousTools.filter(n=>safeTools.has(n)),'submit_plan','plan_question']);
    else pi.setActiveTools(previousTools);show();
  }
  pi.on('session_start',reload);pi.on('session_tree',reload);
  pi.on('tool_call',event=>['planning','ready'].includes(state.phase) && !safeTools.has(event.toolName)?{block:true,reason:'规划模式只允许读取项目、澄清问题和保存会话计划。执行计划后才能修改项目。'}:undefined);
  pi.on('before_agent_start',(_event,current)=>{
    ctx=current;if(!['planning','ready'].includes(state.phase))return;
    return {message:{customType:TYPE,display:false,content:'Planning mode: explore read-only. Ask plan_question only when a material decision is missing. Do not edit project files or run commands. When ready call submit_plan with a concrete plan, steps, acceptance criteria and important constraints. Wait for the user to execute it; do not start implementation.'}};
  });
  pi.registerTool({name:'submit_plan',label:'提交计划',description:'Save a concrete plan in the current session without modifying project files. Await user execution.',parameters:Type.Object({plan:Type.String({minLength:1,maxLength:32000}),steps:Type.Array(Type.String({minLength:1,maxLength:2000}),{minItems:1,maxItems:30}),acceptance:Type.Array(Type.String({minLength:1,maxLength:2000}),{minItems:1,maxItems:30})}),
    async execute(_id,args,_signal,_update,current) {ctx=current;if(!['planning','ready'].includes(state.phase))return toolResult('请先开启 /plan。',{},true);state={phase:'ready',text:args.plan,steps:args.steps,acceptance:args.acceptance};persist();return toolResult('计划已保存，等待用户选择继续完善或执行。',{plan:state});}});
  pi.registerTool({name:'plan_question',label:'澄清计划',description:'Ask a material planning question with choices. A cancelled question is unanswered, never approval.',parameters:Type.Object({question:Type.String({minLength:1,maxLength:2000}),options:Type.Array(Type.String({minLength:1,maxLength:500}),{minItems:2,maxItems:5})}),
    async execute(_id,args,signal,_update,current) {if(!['planning','ready'].includes(state.phase))return toolResult('规划模式未开启。',{},true);const answer=await current.ui.select(args.question,[...args.options,'填写自己的答案'],{signal});if(answer==='填写自己的答案'){const value=await current.ui.input(args.question,'填写答案',{signal});return toolResult(value===undefined?'用户取消了问题，尚未回答。':value,{answered:value!==undefined});}return toolResult(answer===undefined?'用户取消了问题，尚未回答。':answer,{answered:answer!==undefined});}});
  pi.registerCommand('plan',{description:'只读规划、澄清与执行计划',getArgumentCompletions:completions(['on','off','status','refine','execute']),async handler(args,current) {
    ctx=current;const value=args.trim();
    if(value==='status') {show();current.ui.notify(state.text || '尚未生成计划。','info');return;}
    if(!current.isIdle()) {current.ui.notify('请先停止当前任务，再切换规划或执行计划。','warning');return;}
    if(value==='off') {leave();return;}
    if(value==='execute') {
      if(state.phase!=='ready') {current.ui.notify('先完成计划，再选择执行。','warning');return;}
      if(!await current.ui.confirm('执行计划？','按当前文件与命令权限执行此计划。'))return;
      const plan=structuredClone(state);leave('executing');
      pi.sendMessage({customType:'local-plan-execute',display:false,content:`Implement the approved plan within existing permissions. Verify every acceptance criterion.\n\n${plan.text}\n\nSteps:\n${plan.steps.map((s,i)=>`${i+1}. ${s}`).join('\n')}\n\nAcceptance:\n${plan.acceptance.join('\n')}`},{triggerTurn:true,deliverAs:'followUp'});return;
    }
    if(!value && ['planning','ready'].includes(state.phase)) {leave();return;}
    enter();if(value && !['on','refine'].includes(value))pi.sendUserMessage(value,{deliverAs:'followUp'});
  }});
  pi.on('session_shutdown',()=>{pi.events.emit('workbench:workflow',{id:'plan',removed:true});});
}
