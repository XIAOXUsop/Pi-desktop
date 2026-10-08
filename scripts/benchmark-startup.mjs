import {readFile,writeFile,mkdir,mkdtemp,readdir,realpath} from 'node:fs/promises';
import {resolve,dirname,basename,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const development=process.argv.includes('--development'),empty=process.argv.includes('--empty');
const missingProject=process.argv.includes('--missing-project');
const interrupted=process.argv.includes('--interrupted'),manyCheckpoints=process.argv.includes('--many-checkpoints');
const corruptSession=process.argv.includes('--corrupt-session');
if((interrupted||manyCheckpoints)&&(empty||missingProject))throw new Error('Recovery fixtures require an existing copied session');
if(process.platform!=='win32')throw new Error('This benchmark currently measures the Windows desktop application');
const runs=Number(process.argv.find(arg=>arg.startsWith('--runs='))?.split('=')[1] || 3);
if(!Number.isInteger(runs)||runs<1||runs>10)throw new Error('Runs must be 1–10');
const destination=resolve(root,'.agent/verification/startup');await mkdir(destination,{recursive:true});
const folder=await mkdtemp(resolve(destination,'run-')),profile=resolve(folder,'profile');await mkdir(profile);
const source=resolve(process.env.APPDATA,'Pi-desktop');
let original={};try{original=JSON.parse(await readFile(resolve(source,'settings.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const workspace=resolve(folder,'project');await mkdir(workspace);const canonical=await realpath(workspace);
const data={mode:original.mode || 'build',preferences:original.preferences,selectedModel:original.selectedModel,permissions:original.permissions || {write:false,shell:false},recentProjects:empty?[]:[canonical],projectSessions:{},sessionMetadata:{}};
let journals=0,journalBytes=0;
if(!empty){
  data.lastProject=missingProject?resolve(folder,'missing-project'):canonical;
  if(missingProject)data.recentProjects=[data.lastProject];
  if(original.lastProject&&!missingProject){
    for(const relative of ['.agent/sessions','.agent/pi-state']){
      const origin=resolve(original.lastProject,relative),target=resolve(canonical,relative);await mkdir(target,{recursive:true});
      for(const name of await readdir(origin).catch(error=>{if(error.code==='ENOENT')return [];throw error;})){
        if(!/^[a-f0-9-]{36}\.(jsonl|json)$/i.test(name))continue;
        const text=await readFile(resolve(origin,name),'utf8');
        if(name.endsWith('.jsonl')){
          const end=text.indexOf('\n'),header=JSON.parse(end<0?text:text.slice(0,end));
          if(header.workspace!==original.lastProject)continue;
          header.workspace=canonical;await writeFile(resolve(target,name),JSON.stringify(header)+(end<0?'\n':text.slice(end)));journals++;journalBytes+=Buffer.byteLength(text);
        }else{
          const snapshot=JSON.parse(text);if(snapshot.workspace!==original.lastProject)continue;
          snapshot.workspace=canonical;if(snapshot.header?.cwd)snapshot.header.cwd=canonical;
          await writeFile(resolve(target,name),JSON.stringify(snapshot));
        }
      }
    }
    data.sessionMetadata[canonical]=original.sessionMetadata?.[original.lastProject] || {};
    const id=original.projectSessions?.[original.lastProject] || (original.lastSession && basename(original.lastSession,'.jsonl'));
    if(id){data.projectSessions[canonical]=id;data.lastSession=resolve(canonical,'.agent/sessions',id+'.jsonl');}
  }
}
let fixture={};
if(corruptSession){if(!data.lastSession)throw new Error('Corruption verification needs a saved copied session');await writeFile(data.lastSession,'corrupt fixture\n');fixture.corruptSessionSha256=createHash('sha256').update(await readFile(data.lastSession)).digest('hex');}
if(interrupted||manyCheckpoints){
  const sessionId=data.projectSessions[canonical];if(!sessionId)throw new Error('Choose a project with a saved session before measuring recovery fixtures');
  const {RunStore}=await import('../dist/src/run-store.js'),runs=await RunStore.open(canonical,sessionId),generation=randomUUID();
  if(interrupted){const run=await runs.create({workerGeneration:generation,branchStart:null,origin:'startup_fixture',input:'Verify the interrupted task without model requests'});await runs.update(run.runId,{status:'running'});fixture.interruptedRunId=run.runId;}
  if(manyCheckpoints){const {CheckpointStore,TaskCheckpoint}=await import('../dist/src/checkpoints.js'),store=await CheckpointStore.open(canonical);for(let i=0;i<200;i++){const run=await runs.create({workerGeneration:generation,branchStart:null,origin:'startup_fixture'});const task=await TaskCheckpoint.create(store,sessionId,run.runId,null);await task.finalize();await runs.update(run.runId,{status:'completed'});}const objects=resolve(canonical,'.agent/checkpoints/objects');await mkdir(objects,{recursive:true});for(let i=0;i<5000;i++){const bytes=Buffer.from('startup-object-'+i),hash=createHash('sha256').update(bytes).digest('hex');await writeFile(resolve(objects,hash+'.bin'),bytes);}fixture={...fixture,checkpointManifests:200,objects:5000};}
}
await writeFile(resolve(profile,'settings.json'),JSON.stringify(data));
try{await writeFile(resolve(profile,'models.json'),await readFile(resolve(source,'models.json')));}catch(error){if(error.code!=='ENOENT')throw error;}
const candidate=process.argv.find(arg=>arg.startsWith('--executable='))?.slice('--executable='.length);
if(candidate && (!isAbsolute(candidate) || development))throw new Error('A candidate must be an absolute packaged executable path');
const binary=candidate || (development?createRequire(import.meta.url)('electron'):resolve(root,'release/win-unpacked/Pi-desktop.exe'));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const name of Object.keys(env))if(/API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name))delete env[name];
const samples=[];
for(let iteration=0;iteration<runs;iteration++){
  const started=performance.now();
  const args=[...(development?[resolve(root,'desktop/bootstrap.cjs')]:[]),'--startup-benchmark','--test-profile',profile];
  const child=spawn(binary,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const timeout=setTimeout(()=>child.kill(),90000);
  const code=await new Promise((accept,reject)=>{child.once('error',reject);child.once('close',accept);}).finally(()=>clearTimeout(timeout));
  await writeFile(resolve(folder,`launch-${iteration+1}.log`),output);
  if(code!==0)throw new Error(`Startup benchmark exited ${code}; inspect ${folder}`);
  const result=JSON.parse(await readFile(resolve(profile,'startup-result.json'),'utf8'));
  const stage=name=>result.stages.find(item=>item.stage===name)?.milliseconds;
  assert(stage('window-created')<stage('settings-ready'),'Window creation must not wait for environment keys');
  if(stage('pi-core-ready')!==undefined)assert(stage('window-created')<stage('pi-core-ready'),'Pi core loading must happen after window creation');
  assert.equal(result.ui.locked,false,'Controls unlock when the conversation is ready');
  assert.equal(result.ui.busy,'false');assert.equal(result.ui.error,corruptSession,'Startup reports damaged session while preserving the file');
  if(!result.earlyUI.backendReady){assert(result.earlyUI.locked,'Controls stay locked during restoration');assert.equal(result.earlyUI.busy,'true');}
  if(!empty&&journals&&!corruptSession)assert(result.restoredSession,'Speed must not come from skipping session restoration');
  if(corruptSession){assert.equal(result.restoredSession,false);assert(result.validation?.restoreFailure&&!/is not defined|TypeError/.test(result.validation.restoreFailure),'Restoration must fail for corrupt data, not missing code bindings');assert.equal(createHash('sha256').update(await readFile(data.lastSession)).digest('hex'),fixture.corruptSessionSha256,'Damaged journal must not be overwritten');}
  if(empty||missingProject)assert.equal(result.restoredSession,false);
  const sample={iteration:iteration+1,wallMilliseconds:Math.round(performance.now()-started),...result};samples.push(sample);console.log(JSON.stringify(sample));
}
await writeFile(resolve(folder,'results.json'),JSON.stringify({executable:binary,development,empty,missingProject,fixture,journals,journalBytes,samples},null,2));
console.log(JSON.stringify({results:resolve(folder,'results.json'),journals,journalBytes}));
