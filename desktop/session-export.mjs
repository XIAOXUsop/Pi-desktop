import {writeFile} from 'node:fs/promises';
const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Pi's HTML exporter requires a file-backed manager. Desktop keeps Pi in memory and exports its journal.
export async function exportDesktopSession(agent,path) {
  if(agent.busy) throw new Error('请先停止当前任务，再导出会话');
  const info=agent.sessionInfo();
  const messages=agent.store.branch().filter(e=>e.data.kind==='message').map(entry=>{
    const m=entry.data.message,label={user:'你的任务',assistant:'模型回答',tool:'工具 · '+m.name}[m.role];
    const thinking=(m.reasoning || []).filter(p=>p.text && !p.redacted).map(p=>p.text).join('\n\n');
    const body=`${thinking ? '<details><summary>思考过程</summary><pre>'+escape(thinking)+'</pre></details>' : ''}<pre>${escape(m.text)}</pre>${m.toolCalls?.length ? '<details><summary>工具调用</summary><pre>'+escape(m.toolCalls.map(c=>c.name+' '+c.arguments).join('\n'))+'</pre></details>' : ''}`;
    return m.role==='tool' ? `<details class="message"><summary>${escape(label)}</summary>${body}</details>` : `<article class="message"><h2>${escape(label)}</h2>${body}</article>`;
  }).join('\n');
  const summaries=agent.manager.getBranch().filter(e=>e.type==='compaction').map(e=>`<details class="message"><summary>上下文摘要</summary><pre>${escape(e.summary)}</pre></details>`).join('\n');
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><title>会话 ${escape(info.sessionId)}</title><style>body{margin:0;background:#faf9f6;color:#292824;font:16px/1.8 "Segoe UI","Microsoft YaHei UI",sans-serif}main{max-width:960px;margin:40px auto;padding:0 24px}h1{font-size:24px}h2,summary{font-size:13px;color:#67625a}header p{font-size:13px;overflow-wrap:anywhere}.message{margin:24px 0;padding:16px 20px;background:#fff;border:1px solid #ddd9d1;border-radius:12px}pre{margin:12px 0;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer}</style></head><body><main><header><h1>会话记录</h1><p>${escape(info.model)} · ${escape(info.sessionId)}</p><p>当前分支 · ${new Date().toISOString()}</p></header>${messages || '<p>当前会话还没有消息。</p>'}${summaries}</main></body></html>`;
  await writeFile(path,html,'utf8');return path;
}
