import { PiDesktopAgent } from './pi-agent.mjs';
import { DemoProvider } from '../dist/src/demo.js';
import { setTimeout as delay } from 'node:timers/promises';
import { savedSessionModel } from './project-sessions.mjs';

class DesktopDemoProvider extends DemoProvider {
  async *stream(request) {
    await delay(500, undefined, { signal: request.signal });
    const turns = request.messages.filter(message => message.role === 'assistant').length;
    // Public sample content for the explicitly labelled offline demonstration only.
    const thinking = ['离线演示：先读取 hello.txt，确认当前内容。','离线演示：根据读取结果，修改示例中的问候。','离线演示：核对工具结果，再给出修改说明。'][Math.min(turns,2)];
    yield {type:'thinking_delta',text:thinking.slice(0,6)};
    await delay(150,undefined,{signal:request.signal});
    yield {type:'thinking_delta',text:thinking.slice(6)};
    await delay(150,undefined,{signal:request.signal});
    const reasoning = [{index:0,text:thinking}];
    if (turns > 0 && !request.tools.some(tool => ['write','edit','shell','bash','powershell'].includes(tool.name))) {
      const text = '已读取示例文件。当前为只读模式，没有修改文件或运行命令。\n\n需要编辑时，切换到执行模式并勾选“修改文件”。';
      yield { type: 'text_delta', text };
      yield { type: 'done', message: { role: 'assistant', text, reasoning, toolCalls: [], provider: this.id, model: request.model.id, stopReason: 'stop', usage: { input: 0, output: 0 }, timestamp: Date.now() } }; return;
    }
    for await (const event of super.stream(request)) {
      if (event.type === 'text_delta') continue;
      if (event.type === 'done' && !event.message.toolCalls.length) {
        const edited = request.messages.some(message => message.role === 'tool' && message.name === 'edit' && !message.isError);
        const text = edited ? '已将 `hello.txt` 的问候改为：\n\n```text\nHello, coding agent!\n```\n\n保留了原有的 CRLF 换行。' : '演示结束。执行结果见上方记录。';
        yield { type: 'text_delta', text }; yield { ...event, message: { ...event.message, text, reasoning } };
      } else if(event.type === 'done') {
        const text = turns === 0 ? '离线演示：读取示例文件，确认需要修改的位置。' : '离线演示：修改问候，并保留原文件的换行。';
        yield {type:'text_delta',text};yield {...event,message:{...event.message,text,reasoning}};
      }
      else yield event;
    }
  }
}

let agent; let opening = false; let unsubscribe;
const send = value => process.parentPort.postMessage(value);
function publicEvent(event) {
  if (event.type === 'message' && event.message.role === 'assistant') { const { providerState, ...message } = event.message; return { ...event, message }; }
  return event;
}
async function open(options) {
  if (opening || agent?.busy) throw new Error('Worker session is busy'); opening = true;
  try {
    await release();process.chdir(options.workspace);
    if(options.restoreModel && options.resume) {const key=await savedSessionModel(options.resume,options.config);if(key) options={...options,modelKey:key};}
    agent = await PiDesktopAgent.create(options, new DesktopDemoProvider());
    unsubscribe=agent.subscribe(event => send({ type: 'event', event: publicEvent(event) }));
    return { ...agent.state, sessionPath: agent.store.path };
  }
  finally { opening = false; }
}
async function release() {
  unsubscribe?.();unsubscribe=undefined;
  const previous=agent;agent=undefined;if(previous) await previous.close();
}
function history() {
  return { entries: agent.store.all().map(entry => {
    if (entry.data.kind === 'message' && entry.data.message.role === 'assistant') {
      const { providerState, ...message } = entry.data.message; return { ...entry, data: { kind: 'message', message } };
    }
    return entry;
  }), leaf: agent.store.leaf, activeEntryIds: agent.store.branch().map(entry => entry.id),branchableEntryIds:Object.keys(agent.mapping) };
}
process.parentPort.on('message', async event => {
  const command = event.data; const id = command.id;
  try {
    if (command.method === 'open') { send({ type: 'response', id, result: await open(command.params) }); return; }
    if(command.method==='release' || command.method==='close') {await release();send({type:'response',id,result:{closed:true}});return;}
    if(command.method==='state' && !agent) {send({type:'response',id,result:null});return;}
    if (!agent) throw new Error('No active session'); const params = command.params ?? {}; let result;
    switch (command.method) {
      case 'run': {
        if (agent.busy) throw new Error('任务进行中，请使用插话或追加任务');
        if (typeof params.prompt !== 'string' || !params.prompt.trim()) throw new Error('请输入任务');
        void agent.run(params.prompt).then(result => send({ type: 'run_result', id, result }),error=>send({type:'event',event:{type:'extension_notice',sessionId:agent?.store.id,level:'error',message:error.message}})); result = { accepted: true }; break;
      }
      case 'command': {
        if(typeof params.prompt!=='string' || params.prompt.length>256*1024 || !agent.isExtensionCommand(params.prompt))throw new Error('无效扩展指令');
        const owner=agent;void owner.command(params.prompt).catch(error=>send({type:'event',event:{type:'extension_notice',sessionId:owner.store.id,level:'error',message:error.message}}));result={accepted:true};break;
      }
      case 'extension_response': agent.bridge.respond(params);result={accepted:true};break;
      case 'set_mode': {
        if(!['build','plan'].includes(params.mode))throw new Error('无效工作模式');
        if(!agent.isExtensionCommand('/plan'))throw new Error('规划扩展未启用');
        await agent.command(params.mode==='plan'?'/plan on':'/plan off');result=agent.state;break;
      }
      case 'abort': await agent.abort(); result = agent.state; break;
      case 'steer': await agent.steer(params.prompt); result = agent.state; break;
      case 'follow_up': await agent.followUp(params.prompt); result = agent.state; break;
      case 'state': result = { ...agent.state, sessionPath: agent.store.path }; break;
      case 'session_info': result = agent.sessionInfo(); break;
      case 'complete': result=await agent.complete(params);break;
      case 'thinking': result=await agent.setThinking(params.level);break;
      case 'set_name': agent.session.setSessionName(params.name);await agent.save();result=agent.state;break;
      case 'copy_session': result=await agent.copySession(params);break;
      case 'export_jsonl': result=await agent.exportJsonl(params.path);break;
      case 'bug_bundle': result=await agent.bugBundle(params);break;
      case 'compact': result = await agent.compact(params.instructions); break;
      case 'export_html': result = await agent.exportHtml(params.path);break;
      case 'history': result = history(); break;
      case 'changes': result = agent.store.branch().flatMap(entry => entry.data.kind === 'file_change' ? [entry.data.change] : []); break;
      case 'set_model': await agent.setModel(params.key); result = agent.state; break;
      case 'branch': await agent.branch(params.entryId); result = agent.state; break;
      case 'clear_queues': agent.clearQueues(); result = agent.state; break;
      case 'close': await agent.close(); result = { closed: true }; break;
      default: throw new Error('Unknown worker command');
    }
    send({ type: 'response', id, result });
  } catch (error) { send({ type: 'response', id, error: error instanceof Error ? error.message : 'Worker operation failed' }); }
});
send({ type: 'ready' });
