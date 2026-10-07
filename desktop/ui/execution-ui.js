// Select an output by task/run boundaries, never by English phrases or text length.
export function finalOutputs(entries) {
  const outputs = new Map(), byId = new Map(entries.map(entry => [entry.id,entry]));let candidate;
  const settle = () => {
    if(candidate && candidate.data.message.phase !== 'commentary' && !candidate.data.message.toolCalls.length && candidate.data.message.stopReason !== 'tool_use') {
      const message = candidate.data.message;outputs.set(candidate.id,message.stopReason === 'length' ? 'limit' : message.executionStatus || 'completed');
    }
    candidate = undefined;
  };
  for(const entry of entries) {
    if(entry.data.kind === 'message' && entry.data.message.role === 'user') settle();
    if(entry.data.kind === 'message' && entry.data.message.role === 'assistant') candidate = entry;
    if(entry.data.kind === 'run_result') {
      const selected = byId.get(entry.data.assistantEntryId)?.data.message;
      if(selected?.role === 'assistant' && selected.phase !== 'commentary' && !selected.toolCalls.length && selected.stopReason !== 'tool_use') outputs.set(entry.data.assistantEntryId,selected.stopReason === 'length' ? 'limit' : entry.data.result.status);
      candidate = undefined;
    }
  }
  settle();return outputs;
}

// Keep disclosure nodes stable while Pi streams; content updates never change `open`.
export function executionView({messages,node,icon}) {
  let current, anchor, unanchoredOutput, running = false;
  const thoughts = new Map(), groups = [], answered = new Set();
  const labels = {completed:'完成',cancelled:'已停止',failed:'失败',limit:'输出未完成',interrupted:'已中断'};
  function summary(group) {
    group.count.textContent = [group.progress.size ? `说明 ${group.progress.size} 段` : '',group.thoughts.length ? `思考 ${group.thoughts.length} 段` : '',group.tools.length ? `工具 ${group.tools.length} 次` : ''].filter(Boolean).join(' · ');
    const pendingTool = group.tools.some(t => t.status === 'running');
    const pendingThought = group.thoughts.some(t => t.status === 'running');
    group.status.textContent = labels[group.result] || (pendingTool ? '正在执行' : pendingThought ? '正在思考' : running ? group.outputRunning ? '正在输出' : '正在处理' : '完成');
    group.status.classList.toggle('failed',['failed','limit'].includes(group.result) || group.tools.some(t => t.status === 'failed'));
    if (group.result === 'completed' && group.tools.some(t => t.status === 'failed')) group.status.textContent = '完成 · 有工具失败';
  }
  function ensure() {
    if(current) return current;
    const root = node('details','execution-group'), heading = node('summary','execution-heading');
    const count = node('span','execution-count'), status = node('span','execution-status'); status.setAttribute('aria-live','polite');
    heading.append(icon('chevron'),node('strong','','执行过程'),count,status);
    const body = node('div','execution-body'); root.append(heading,body);
    messages.querySelector('.welcome')?.remove();
    if(anchor?.isConnected) anchor.after(root); else messages.append(root);
    current = {root,body,count,status,thoughts:[],tools:[],progress:new Set()}; groups.push(current);summary(current);return current;
  }
  function updateThought(event,final = false,status = 'completed') {
    const key = `${event.messageId}:${event.index}`;
    let part = thoughts.get(key);
    if(!part && !event.text && !event.redacted) return;
    if(!part) {
      const group = ensure(), root = node('details','thinking-step'), heading = node('summary');
      const phase = node('span','step-status','正在思考');
      heading.append(icon('chevron'),node('strong','','思考内容'),phase);
      const note = node('p','thinking-note','模型返回的思考内容或摘要'), content = node('div','thinking-content');
      root.append(heading,note,content);group.body.append(root);
      part = {root,content,phase,group,messageId:event.messageId,status:'running'};thoughts.set(key,part);group.thoughts.push(part);
    }
    // Encrypted provider signatures never enter display content.
    if(event.redacted) part.content.textContent = '提供方隐藏了这段思考内容。';
    else if(final || event.type === 'thinking_end') part.content.textContent = event.text;
    else part.content.textContent += event.text;
    if(final || event.type === 'thinking_end' || answered.has(event.messageId)) { part.status = status;part.phase.textContent = labels[status] || '完成';if(answered.has(event.messageId))part.group.outputRunning=true; }
    else if(event.type === 'thinking_delta') {part.status = 'running';part.phase.textContent = '正在思考';}
    summary(part.group);
  }
  return {
    reset() {current = undefined;anchor = undefined;unanchoredOutput = undefined;running = false;thoughts.clear();answered.clear();groups.length = 0;},
    start() {current = undefined;anchor = undefined;unanchoredOutput = undefined;running = true;answered.clear();},
    user(item) {
      if(current && !anchor) {anchor = item;if(item) {item.after(current.root);if(current.output?.isConnected)current.root.after(current.output);}unanchoredOutput = undefined;return;}
      if(current) {current.result ||= 'completed';summary(current);}
      current = undefined;anchor = item;if(item && unanchoredOutput?.isConnected)item.after(unanchoredOutput);unanchoredOutput = undefined;
    },
    thinking:event => updateThought(event),
    answerStarted(messageId) {
      answered.add(messageId);
      // Pi chat adapters may defer thinking_end until the entire message ends.
      // Visible answer text still marks the transition out of thinking now.
      for(const part of thoughts.values()) if(part.messageId === messageId && part.status === 'running') {
        part.status = 'completed';part.phase.textContent = '完成';summary(part.group);
      }
    },
    commentary(root) {const group = ensure();if(group.output === root) {group.output = undefined;group.outputRunning = false;}if(!group.progress.has(root)) {group.progress.add(root);group.body.append(root);}summary(group);},
    output(root,{streaming=false}={}) {
      if(current) {
        current.progress.delete(root);current.output = root;current.outputRunning = streaming;current.root.after(root);summary(current);
        if(!current.progress.size && !current.thoughts.length && !current.tools.length) {current.root.remove();groups.splice(groups.indexOf(current),1);current = undefined;if(!anchor?.isConnected && running)unanchoredOutput = root;}
      }
      else if(anchor?.isConnected) anchor.after(root);else {messages.append(root);if(running)unanchoredOutput = root;}
    },
    assistant(messageId,message) {
      for(const part of message.reasoning || []) updateThought({...part,messageId},true,message.executionStatus || 'completed');
      if(current && !running && message.executionStatus && !message.toolCalls.length) {current.result = message.stopReason === 'length' ? 'limit' : message.executionStatus;summary(current);}
    },
    tool(root) {const group = ensure(), item = {root,status:'running',group};group.tools.push(item);group.body.append(root);summary(group);return item;},
    toolEnd(item,failed) {item.status = failed ? 'failed' : 'completed';summary(item.group);},
    finish(status) {
      running = false;
      for(const group of groups) {
        const pending = [...group.tools,...group.thoughts].filter(p => p.status === 'running');
        for(const part of pending) {part.status = group.result && group.result !== 'completed' ? group.result : status;if(part.phase) part.phase.textContent = labels[part.status] || '已中断';}
        if(group === current) group.result = status;else if(pending.length && !group.result) group.result = 'interrupted';
        summary(group);
      }
    },
    historyEnd() {
      for(const group of groups) {
        if(group.tools.some(t => t.status === 'running')) {group.result = 'interrupted';for(const t of group.tools.filter(t => t.status === 'running')) {t.status = 'interrupted';t.root.querySelector('.step-status').textContent = '已中断';}}
        summary(group);
      }
    }
  };
}
