import {CombinedAutocompleteProvider,fuzzyFilter} from '@earendil-works/pi-tui';
import {piBuiltinCommands} from './pi-native.mjs';

const matching=(items,prefix)=>fuzzyFilter(items,prefix,i=>`${i.value} ${i.label} ${i.description || ''}`);
export function commandProvider({workspace,session,models=[],providers=[],scopedModels=[],wrappers=[]}) {
  const commands=piBuiltinCommands.map(c=>({...c}));
  const set=(name,fn)=>{commands.find(c=>c.name===name).getArgumentCompletions=fn;};
  set('model',prefix=>matching(models.filter(m=>!scopedModels.length || scopedModels.includes(m.key)).map(m=>({value:m.key,label:m.id || m.key,description:m.provider})),prefix));
  set('thinking',prefix=>matching((session?.getAvailableThinkingLevels() || ['off']).map(value=>({value,label:value})),prefix));
  set('login',prefix=>matching(providers.map(p=>({value:p.id,label:p.name || p.id,description:p.id})),prefix));
  const reserved=new Set(commands.map(c=>c.name));
  if(session) {
    commands.push(...session.promptTemplates.filter(c=>!reserved.has(c.name)).map(c=>({name:c.name,description:'提示模板 · '+c.description,argumentHint:c.argumentHint})));
    commands.push(...session.extensionRunner.getRegisteredCommands().filter(c=>!reserved.has(c.name)).map(c=>({name:c.invocationName,description:'插件命令 · '+(c.description || c.name),getArgumentCompletions:c.getArgumentCompletions})));
    commands.push(...session.resourceLoader.getSkills().skills.map(c=>({name:'skill:'+c.name,description:'技能 · '+c.description})));
  }
  let provider=new CombinedAutocompleteProvider(commands,workspace || process.cwd());
  for(const wrap of wrappers)provider=wrap(provider);
  return provider;
}
export async function completePiPrompt(input,context,signal=new AbortController().signal) {
  if(typeof input?.text!=='string' || Buffer.byteLength(input.text)>256*1024 || !Number.isInteger(input.cursor) || input.cursor<0 || input.cursor>input.text.length) throw new Error('无效补全请求');
  const before=input.text.slice(0,input.cursor),lines=input.text.split('\n'),cursorLine=before.split('\n').length-1,cursorCol=before.length-(before.lastIndexOf('\n')+1);
  // File attachments keep the desktop's existing bounded file picker. This
  // endpoint only invokes Pi's slash branch, never its arbitrary path walker.
  if(!lines[cursorLine].slice(0,cursorCol).trimStart().startsWith('/')) return null;
  const provider=context.provider || commandProvider(context);
  if(input.item) {
    const candidates=await provider.getSuggestions(lines,cursorLine,cursorCol,{signal});
    const item=candidates?.items.find(i=>i.value===input.item.value);
    if(!item || signal.aborted) return null;
    const applied=provider.applyCompletion(lines,cursorLine,cursorCol,item,candidates.prefix);
    return {text:applied.lines.join('\n'),cursor:applied.lines.slice(0,applied.cursorLine).reduce((n,s)=>n+s.length+1,0)+applied.cursorCol};
  }
  const suggestions=await provider.getSuggestions(lines,cursorLine,cursorCol,{signal});
  return signal.aborted ? null : suggestions;
}
