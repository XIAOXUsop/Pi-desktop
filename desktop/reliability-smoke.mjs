import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
export async function runReliabilitySmoke({window,actions,settings,project,killWorker,ownedCommands}) {
  const checks=[];async function until(check){for(let i=0;i<400;i++){if(await check())return;await delay(25);}throw new Error('reliability smoke timed out: '+await window.webContents.executeJavaScript("document.getElementById('operation-error').textContent"));}
  await actions.setMode({mode:'build'});await actions.setPermissions({write:true,shell:false});
  const before=await actions.state();await actions.run({prompt:'修改 hello.txt 并给出结果'});
  await until(async()=>{const runs=await actions.listRuns();return runs[0]?.status==='running'&&Object.values(runs[0].tools).some(t=>t.name==='edit'&&t.status==='finished');});
  const old=(await actions.listRuns())[0],bytes=await readFile(resolve(before.project,'hello.txt'));killWorker();
  await until(async()=>{const record=(await actions.listRuns()).find(r=>r.runId===old.runId);return record?.status==='interrupted';});checks.push('utility process crash is durable');
  await until(async()=>window.webContents.executeJavaScript("!document.getElementById('recovery-card').hidden"));checks.push('recovery entry appears without an automatic model request');
  await window.webContents.executeJavaScript("document.querySelector('#recovery-card button').click()");
  await until(async()=>window.webContents.executeJavaScript("document.querySelector('dialog.reliability-dialog').open"));
  await window.webContents.executeJavaScript("document.querySelector('dialog.reliability-dialog .send-button').click()");
  await until(async()=>(await actions.listRuns()).some(r=>r.parentRunId===old.runId&&r.status==='completed'));
  assert.deepEqual(await readFile(resolve(before.project,'hello.txt')),bytes);checks.push('resume retains file state and completed tool results');
  const next=(await actions.listRuns()).find(r=>r.parentRunId===old.runId);assert(!Object.values(next.tools).some(t=>t.name==='edit'));checks.push('resume does not replay confirmed edits');
  const bundle=await actions.exportDiagnostics({preview:true});assert(!bundle.runtime);assert.equal(bundle.metadata.runs.length,2);checks.push('default diagnostic export contains no raw runtime output');
  await window.webContents.executeJavaScript("document.getElementById('changes-tab').click()");
  await until(()=>window.webContents.executeJavaScript("!document.getElementById('rollback-preview').disabled"));
  await window.webContents.executeJavaScript("document.getElementById('rollback-preview').click()");
  await until(()=>window.webContents.executeJavaScript("document.getElementById('rollback-dialog').open"));
  await window.webContents.executeJavaScript("for(const box of document.querySelectorAll('#rollback-dialog input:not(:disabled)')){if(!box.checked)box.click()} ");
  await window.webContents.executeJavaScript("document.querySelector('#rollback-dialog .send-button').click()");
  await until(()=>readFile(resolve(before.project,'hello.txt'),'utf8').then(text=>text==='Hello, world!\r\n'));
  checks.push('real renderer previews and restores the interrupted task raw bytes');
  await until(()=>window.webContents.executeJavaScript("!document.getElementById('rollback-dialog').open&&!document.getElementById('rollback-inverse').hidden"));
  await window.webContents.executeJavaScript("document.getElementById('rollback-inverse').click()");
  await until(()=>window.webContents.executeJavaScript("document.getElementById('rollback-dialog').open"));
  await window.webContents.executeJavaScript("document.querySelector('#rollback-dialog .send-button').click()");
  await until(()=>readFile(resolve(before.project,'hello.txt')).then(value=>value.equals(bytes)));checks.push('undo of rollback restores the pre-undo bytes');
  await until(()=>window.webContents.executeJavaScript("!document.getElementById('rollback-dialog').open"));
  await actions.setPermissions({write:true,shell:true});await actions.newSession();await actions.run({prompt:'[command-supervisor-check]'});
  await until(()=>ownedCommands()===1);killWorker();await until(()=>ownedCommands()===0);checks.push('main process cleans up its command after worker death');
  await until(async()=>!!(await actions.getRecoveryState()));
  const folder=resolve(settings.folder,'verification');await mkdir(folder,{recursive:true});await writeFile(resolve(folder,'reliability-smoke.json'),JSON.stringify({timestamp:new Date().toISOString(),checks},null,2));
  console.log(JSON.stringify({checks:checks.length,status:'passed'}));return {checks};
}
