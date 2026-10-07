// Chat-completions text has no intrinsic final-answer channel. Never infer one
// from wording, timing or the absence of tools in a still-open response.
export const ANSWER_HEADER = '[[agent:answer]]';
export const PROGRESS_HEADER = '[[agent:progress]]';
const headers = [[ANSWER_HEADER,'final_answer'],[PROGRESS_HEADER,'commentary']];

export function assistantPresentation(raw, hint) {
  const text = String(raw || ''), start = text.replace(/^(?:\uFEFF)?[ \t\r\n]*/, '');
  for(const [header,phase] of headers) {
    if(start.startsWith(header)) return {phase:['commentary','final_answer'].includes(hint)?hint:phase,text:start.slice(header.length).replace(/^\r?\n/, '')};
    if(header.startsWith(start)) return {phase:'pending',text:''};
  }
  return {phase:['commentary','final_answer'].includes(hint) ? hint : 'pending',text};
}

// Pi keeps Responses message phases in a versioned text signature. Only the
// public phase is projected; neither signature ids nor opaque data reach UI.
export function nativeTextPhase(content) {
  const phases = new Set();
  for(const block of content || []) {
    if(block.type !== 'text' || typeof block.textSignature !== 'string' || !block.textSignature.startsWith('{')) continue;
    try {
      const signature = JSON.parse(block.textSignature);
      if(signature.v === 1 && typeof signature.id === 'string' && ['commentary','final_answer'].includes(signature.phase)) phases.add(signature.phase);
    } catch { /* Legacy and opaque signatures have no presentation phase. */ }
  }
  return phases.size === 1 ? [...phases][0] : undefined;
}
