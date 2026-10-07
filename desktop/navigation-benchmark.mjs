import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listProjectSessions } from './project-sessions.mjs';

// Isolated empty Pi sessions and local generated journals; no model requests.
export async function runNavigationBenchmark({actions,settings,project}) {
  const first=await actions.state();
  const other=await realpath(await mkdtemp(resolve(project,'.agent/desktop-demo/benchmark-project-')));
  settings.data.recentProjects.push(other); await settings.save();
  await actions.openRecent({path:other}); await actions.newSession();
  const before=(await actions.state()).verification.workerStarts;
  const switches=[];
  for(let iteration=0;iteration<4;iteration++) for(const path of [first.project,other]) {
    const started=performance.now(); const next=await actions.openRecent({path});
    assert.equal(next.project,path); assert(next.agent?.sessionId);
    switches.push(performance.now()-started);
  }
  const starts=(await actions.state()).verification.workerStarts-before;
  const catalog=await realpath(await mkdtemp(resolve(project,'.agent/desktop-demo/benchmark-catalog-')));
  const folder=resolve(catalog,'.agent/sessions'); await mkdir(folder,{recursive:true});
  for(let index=0;index<6;index++) {
    const id=randomUUID();
    await writeFile(resolve(folder,id+'.jsonl'),[
      {type:'header',version:1,sessionId:id,workspace:catalog},
      {type:'entry',id:'task',parentId:null,data:{kind:'message',message:{role:'user',text:'Large history '+index}}},
      {type:'entry',id:'reply',parentId:'task',data:{kind:'message',message:{role:'assistant',text:'x'.repeat(8*1024*1024)}}},
    ].map(item=>JSON.stringify(item)).join('\n')+'\n');
  }
  const scans=[];
  for(let index=0;index<3;index++) {
    const started=performance.now(); const rows=await listProjectSessions(catalog,settings);
    scans.push(performance.now()-started); assert.equal(rows.length,6);
  }
  const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const result={timestamp:new Date().toISOString(),switchesMs:switches,switchMedianMs:median(switches),workerStartsForEightSwitches:starts,catalogTotalMiB:48,catalogScansMs:scans,catalogMedianMs:median(scans)};
  const verification=resolve(project,'.agent/verification'); await mkdir(verification,{recursive:true});
  const phase=process.argv.includes('--baseline') ? 'before' : 'after';
  await writeFile(resolve(verification,`navigation-performance-${phase}.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}
