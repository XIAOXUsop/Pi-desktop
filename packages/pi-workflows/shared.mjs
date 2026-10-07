export const contentText = content => typeof content==='string' ? content : (content || []).filter(p=>p.type==='text').map(p=>p.text).join('\n');
export function restore(ctx,type) {return [...ctx.sessionManager.getBranch()].reverse().find(e=>e.type==='custom' && e.customType===type)?.data;}
export function toolResult(text,details={},isError=false) {return {content:[{type:'text',text}],details,...(isError?{isError:true}:{})};}
export function completions(values) {return prefix=>values.filter(v=>v.startsWith(prefix)).map(value=>({value,label:value}));}
export function publish(pi,ctx,id,state,actions=[]) {
  const card={id,...state,actions};pi.events.emit('workbench:workflow',card);
  ctx.ui.setStatus('local-'+id,state.status==='idle'?undefined:state.title+' · '+state.statusText);
  // Portable fallback for Pi TUI/RPC; desktop renders the structured card instead.
  ctx.ui.setWidget('local-'+id,state.status==='idle'?undefined:[state.title,state.body || '',state.reason || ''].filter(Boolean));
}
export const usageTokens = usage => usage?.totalTokens > 0 ? usage.totalTokens : ((usage?.input || 0)+(usage?.output || 0)+(usage?.cacheRead || 0)+(usage?.cacheWrite || 0));
