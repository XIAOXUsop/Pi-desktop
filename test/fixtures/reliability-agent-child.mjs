import {PiDesktopAgent} from '../../desktop/pi-agent.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const options=JSON.parse(process.argv[2]);let step=0,agent;
process.on('message',()=>{});
const provider={id:'demo',async *stream(request){
  step++;
  if(step===1)yield {type:'done',message:{role:'assistant',text:'[[agent:progress]]\n修改文件',toolCalls:[{id:'confirmed-write',name:'write',arguments:JSON.stringify({path:'hello.txt',content:'after\r\n'})}],provider:'demo',model:'offline',stopReason:'tool_use',usage:{input:20,output:10},timestamp:Date.now()}};
  else {
    yield {type:'text_delta',text:'[[agent:answer]]\n尚未完成的输出'};
    await delay(1200);await agent.pending;await agent.flushPartial();
    process.send({type:'ready_to_kill',sessionPath:agent.store.path,runId:agent.runState.id});
    await new Promise(()=>{});
  }
}};
agent=await PiDesktopAgent.create(options,provider);void agent.run('修改 hello.txt 后返回结果');
