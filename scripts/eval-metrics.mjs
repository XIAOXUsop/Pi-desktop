import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {assistantPresentation} from '../desktop/ui/assistant-presentation.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Read measured events and submitted files; never ask a model to judge itself.
export async function taskMetrics(folder,task,report) {
  const events=(await readFile(resolve(folder,'trajectory.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const started=events.find(e=>e.type==='run_start')?.timestamp??Date.parse(report.startedAt),texts=new Map(),seen=new Set(),mainUsage={input:0,output:0,cacheRead:0,cacheWrite:0};
  let firstModelTextMs=null,firstAnswerMs=null,bufferedAnswer=false,toolFailures=0;
  const calls=new Map(),durations=[],changes=[];
  for(const event of events) {
    if(event.type==='text_delta') {
      firstModelTextMs ??= Math.max(0,event.timestamp-started);
      const text=(texts.get(event.messageId)||'')+event.text;texts.set(event.messageId,text);
      const view=assistantPresentation(text,event.phase);
      if(view.phase==='final_answer'&&view.text.trim())firstAnswerMs ??= Math.max(0,event.timestamp-started);
    }
    if(event.type==='message'&&event.message?.role==='assistant'&&!seen.has(event.entryId)) {
      seen.add(event.entryId);for(const key of Object.keys(mainUsage))mainUsage[key]+=event.message.usage?.[key]||0;
      if(firstAnswerMs===null&&event.message.phase==='final_answer'&&event.message.text){firstAnswerMs=Math.max(0,event.timestamp-started);bufferedAnswer=true;}
    }
    if(event.type==='tool_start')calls.set(event.call.id,{name:event.call.name,started:event.timestamp});
    if(event.type==='tool_end') {const call=calls.get(event.call.id);if(call)durations.push({name:call.name,milliseconds:Math.max(0,event.timestamp-call.started)});if(event.result?.isError)toolFailures++;}
  }
  for(const path of task.allowed){const bytes=await readFile(resolve(folder,'project',path)),before=Buffer.from(task.files[path]);if(!bytes.equals(before))changes.push({path,beforeSha256:hash(before),afterSha256:hash(bytes),beforeBytes:before.length,afterBytes:bytes.length});}
  return {firstModelTextMs,firstAnswerMs,answerWasBuffered:bufferedAnswer,durationMs:report.durationMs??null,
    usage:{main:mainUsage,total:report.usage??null,totalKnownTokens:report.usedTokens,unattributedTokens:Math.max(0,report.usedTokens-Object.values(mainUsage).reduce((a,b)=>a+b,0)),unknownUsage:!!report.unknownUsage,cost:null},
    modelRequests:report.requests,recordedRetries:events.filter(e=>e.type==='retry_start').length,
    tools:{started:calls.size,finished:durations.length,failures:toolFailures,durations},effectiveChanges:changes,reopened:!!report.reopened,goalStatus:report.goalStatus??null};
}
