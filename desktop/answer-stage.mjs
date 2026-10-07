import {assistantPresentation,nativeTextPhase} from './ui/assistant-presentation.js';

// Untyped tool-capable streams cannot safely be exposed as answers: a tool call
// may arrive after any amount of prose. Use a native Pi continuation, rather
// than replaying a completed buffer or guessing from wording/time thresholds.
export class AnswerStage {
  constructor(host) {this.host=host;this.phases=new WeakMap();this.unclassified=new WeakSet();}
  reset() {this.finalStage=false;this.requestPhase=undefined;this.nativePhases=new Set();this.streamPhase=undefined;this.streamText='';this.answerVisible=false;this.lateFinal=false;this.goalRequest=false;}
  enabled(message) {return message.provider!=='demo';}
  phase(message) {return this.phases.get(message) || nativeTextPhase(message.content);}
  start(message) {if(this.requestPhase)this.phases.set(message,this.requestPhase);}
  delta(part) {
    this.streamText=(this.streamText || '')+part.delta;
    const phase=this.requestPhase || this.streamPhase || nativeTextPhase(part.partial.content);
    const presentation=assistantPresentation(this.streamText,phase);
    if(presentation.phase==='final_answer' && presentation.text)this.answerVisible=true;
    return phase;
  }
  end(message) {
    if(message.role!=='assistant')return;
    if(this.requestPhase || this.streamPhase)this.phases.set(message,this.requestPhase || this.streamPhase);
    const presentation=assistantPresentation(message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'),this.phase(message));
    if(this.enabled(message) && (presentation.phase==='pending' || (!this.requestPhase && (this.lateFinal || this.nativePhases.size>1))) && message.content.some(c=>c.type==='text' && c.text)){this.phases.set(message,'commentary');this.unclassified.add(message);}
    this.host.bridge.events.emit('workbench:answer-phase',{pending:this.unclassified.has(message) && message.stopReason==='stop' && !message.content.some(c=>c.type==='toolCall')});
  }
  extension(pi) {
    pi.on('before_provider_request',event=>{
      this.requestPhase=this.finalStage?'final_answer':undefined;
      this.nativePhases=new Set();this.streamPhase=undefined;this.streamText='';this.answerVisible=false;this.lateFinal=false;this.rawResponseText='';this.rawAnswerDeclared=false;
      this.goalRequest=['active','checking'].includes(this.host.bridge.cards.get('goal')?.status);
      if(!this.finalStage)return;
      const payload=event.payload;
      if(!payload || typeof payload!=='object')throw new Error('最终回答请求格式无效');
      delete payload.parallel_tool_calls;
      // Keep Anthropic declarations for prior tool-use history, but prohibit
      // further calls. Chat/Responses use their string-valued none choice.
      if(this.host.session.model.api==='anthropic-messages')payload.tool_choice={type:'none'};
      else {delete payload.tools;payload.tool_choice='none';}
      return payload;
    });
    pi.on('provider_stream_event',event=>{
      // Pi 1.0.1 writes the Responses text signature only at item.done. Read
      // an already-public phase from item.added before text deltas arrive.
      const data=event.data;
      if(event.api!=='openai-responses')return;
      if(data?.type==='response.output_text.delta') {
        this.rawResponseText+=data.delta || '';
        const presentation=assistantPresentation(this.rawResponseText,this.requestPhase || this.streamPhase);
        if(presentation.phase==='final_answer' && presentation.text)this.rawAnswerDeclared=true;
        return;
      }
      if(!['response.output_item.added','response.output_item.done'].includes(data?.type) || data.item?.type!=='message' || !['commentary','final_answer'].includes(data.item.phase))return;
      this.nativePhases.add(data.item.phase);
      // Raw provider callbacks may run ahead of normalized Pi UI events when
      // multiple SSE records arrive in one network packet. Use wire order.
      if(data.type==='response.output_item.done' && data.item.phase==='final_answer' && !this.rawAnswerDeclared && this.rawResponseText)this.lateFinal=true;
      this.streamPhase=this.nativePhases.size===1 && !this.lateFinal?data.item.phase:'commentary';
      if(this.nativePhases.size>1)this.host.emit({type:'assistant_progress',messageId:this.host.activeMessageId});
      this.host.emit({type:'assistant_phase',messageId:this.host.activeMessageId,phase:this.requestPhase || this.streamPhase});
    });
    pi.on('tool_call',(_event,ctx)=>{
      if(!this.finalStage)return;
      this.host.extensionError='模型在最终回答阶段返回了工具调用，已停止。';ctx.abort();
      return {block:true,reason:'最终回答阶段禁止工具调用'};
    });
    pi.on('agent_before_settle',(event,ctx)=>{
      const wasFinal=this.finalStage;this.finalStage=false;
      const last=this.host.lastAssistant;
      const goal=this.host.bridge.cards.get('goal');
      if(wasFinal || !last || !this.enabled(last) || event.outcome!=='completed' || last.stopReason!=='stop' || last.content.some(c=>c.type==='toolCall') || ctx.signal?.aborted || this.host.cancelled || event.continue || ctx.hasPendingMessages() || event.context.pendingMessages.length || (this.goalRequest && goal && ['paused','blocked','budget_limited','turn_limited'].includes(goal.status)))return;
      // Only repair genuinely unclassified completions, never deliberate
      // commentary, length-limited output, failures or cancellations.
      const raw=last.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
      if(!raw.trim() || !this.unclassified.has(last))return;
      this.finalStage=true;
      this.host.emit({type:'answer_stage_start',messageId:this.host.lastAssistantId});
      return {entries:[...event.entries,{type:'custom_message',customType:'desktop-final-answer',display:false,content:'The desktop could not classify the preceding response while it streamed. Work for this task is now finished. Generate the actual final answer to the latest user task in their requested language and format, using the already available work and evidence. Preserve facts, results, uncertainty and limitations; do not add work or invent checks. Do not repeat process narration or private reasoning. Tools are disabled in this final answer stage. Write the answer body directly; presentation prefixes are unnecessary.'}],continue:true};
    });
  }
}
