import {SessionManager} from './pi-core.mjs';
import {SessionStore} from '../dist/src/index.js';
import {atomicJson} from './settings.mjs';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';

export function parsePiImport(jsonl,workspace) {
  if(typeof jsonl!=='string' || Buffer.byteLength(jsonl)>64*1024*1024) throw new Error('导入会话最多 64 MiB');
  const entries=jsonl.split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s));
  const header=entries.shift();
  if(header?.type!=='session' || !Number.isInteger(header.version) || header.version<1 || header.version>3) throw new Error('请选择官方 Pi JSONL 会话文件');
  const ids=new Set();
  for(const entry of entries) {
    if(!entry || typeof entry.id!=='string' || ids.has(entry.id) || (entry.parentId!==null && !ids.has(entry.parentId)) || typeof entry.type!=='string') throw new Error('Pi 会话节点或分支关系无效');
    ids.add(entry.id);
  }
  const manager=SessionManager.inMemory(workspace,undefined,[{...header,cwd:workspace},...entries]);
  manager.buildSessionProjection();
  return manager;
}
export async function copyPiBranch(agent,{entryId,mode='clone',jsonl}={},convert) {
  if(agent.busy) throw new Error('请先停止当前任务，再复制或导入会话');
  let entries,editorText='',sourceHeader=agent.manager.getHeader();
  if(jsonl!==undefined) {const imported=parsePiImport(jsonl,agent.workspace.root);entries=imported.getBranch();sourceHeader=imported.getHeader();}
  else {
    let native=agent.manager.getLeafId();
    if(mode==='fork') {
      const desktop=agent.store.all().find(e=>e.id===entryId);
      if(desktop?.data.kind!=='message' || desktop.data.message.role!=='user' || !agent.mapping[entryId]) throw new Error('请选择可恢复的历史任务');
      editorText=desktop.data.message.text;native=agent.mapping[entryId];
    }
    if(!native) throw new Error('当前会话没有可复制的内容');
    const result=await agent.session.extensionRunner.emit({type:'session_before_fork',entryId:native,position:mode==='fork'?'before':'at'});
    if(result?.cancel) throw new Error('扩展取消了会话复制');
    entries=agent.manager.getBranch(native);
    if(mode==='fork') entries=entries.slice(0,-1);
  }
  // Validate/convert everything before creating any new desktop journal.
  const messages=entries.flatMap(e=>{
    const m=e.type==='message' ? e.message : e.type==='custom_message' ? {role:'custom',customType:e.customType,content:e.content,display:e.display,timestamp:Date.parse(e.timestamp)} : null;
    if(!m)return [];const data=convert(m);return data ? [{nativeId:e.id,data}] : [];
  });
  const store=await SessionStore.create(agent.workspace.root),mapping={};
  try {
    for(const message of messages) {const e=await store.append({kind:'message',message:message.data});mapping[e.id]=message.nativeId;}
    const snapshotPath=resolve(agent.workspace.root,'.agent/pi-state',store.id+'.json');await mkdir(resolve(snapshotPath,'..'),{recursive:true});
    await atomicJson(snapshotPath,{version:1,id:store.id,workspace:agent.workspace.root,header:{...sourceHeader,id:store.id,cwd:agent.workspace.root},entries,leaf:entries.at(-1)?.id || null,mapping});
    return {path:store.path,id:store.id,editorText};
  } finally {await store.close();}
}
