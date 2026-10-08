import {readFile,writeFile,mkdir,mkdtemp,readdir,realpath} from 'node:fs/promises';
import {resolve,dirname,basename,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const development=process.argv.includes('--development'),empty=process.argv.includes('--empty');
const missingProject=process.argv.includes('--missing-project');
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
  assert.equal(result.ui.busy,'false');assert.equal(result.ui.error,false,'Startup must restore without UI errors');
  if(!result.earlyUI.backendReady){assert(result.earlyUI.locked,'Controls stay locked during restoration');assert.equal(result.earlyUI.busy,'true');}
  if(!empty&&journals)assert(result.restoredSession,'Speed must not come from skipping session restoration');
  if(empty||missingProject)assert.equal(result.restoredSession,false);
  const sample={iteration:iteration+1,wallMilliseconds:Math.round(performance.now()-started),...result};samples.push(sample);console.log(JSON.stringify(sample));
}
await writeFile(resolve(folder,'results.json'),JSON.stringify({executable:binary,development,empty,missingProject,journals,journalBytes,samples},null,2));
console.log(JSON.stringify({results:resolve(folder,'results.json'),journals,journalBytes}));
