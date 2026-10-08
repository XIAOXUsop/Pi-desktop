import {readFile,writeFile,mkdir,mkdtemp,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {tasks} from '../test/agent-evals/catalog.mjs';
import {persistentKey} from '../desktop/environment-keys.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const offline=process.argv.includes('--offline'),pilot=process.argv.includes('--pilot');
const python=process.env.EVAL_PYTHON||'python',budget=Number(process.env.EVAL_TOKEN_BUDGET||3000000);
const repeats=pilot?1:Number(process.env.EVAL_REPEATS||3),baseline=process.argv.find(s=>s.startsWith('--baseline='))?.slice(11);
if(!Number.isSafeInteger(budget)||budget<1||budget>3000000||!Number.isInteger(repeats)||repeats<1||repeats>3)throw new Error('Invalid evaluation limits');
const resume=process.argv.find(s=>s.startsWith('--resume='))?.slice(9);
const parent=resolve(root,'.agent/evals');await mkdir(parent,{recursive:true});const folder=resume?resolve(resume):await mkdtemp(resolve(parent,'run-'));
const ledger=resume?JSON.parse(await readFile(resolve(folder,'ledger.json'))):{startedAt:new Date().toISOString(),budget,pilot,offline,model:'deepseek/deepseek-flash',settings:{maxOutputTokens:4096,perTrialTokenReservation:120000,maxSeconds:180,permissions:['read','list','write','edit','shell']},spent:0,reserved:0,trials:[],baseline:baseline||null};
if(resume&&(ledger.budget!==budget||ledger.reserved!==0))throw new Error('Resume requires the original budget and no unresolved reservations');
let saving=Promise.resolve();
const save=()=>{const snapshot=JSON.stringify(ledger,null,2);saving=saving.then(async()=>{const path=resolve(folder,'ledger.json'),temporary=path+'.tmp';await writeFile(temporary,snapshot);await rename(temporary,path);});return saving;};await save();
const only=process.argv.find(s=>s.startsWith('--only='))?.slice(7).split(',');
if(only?.some(id=>!tasks.some(t=>t.id===id)))throw new Error('Unknown task selector');
const selected=only?tasks.filter(t=>only.includes(t.id)):pilot?tasks.filter(t=>['js-basket','py-csv','java-overflow'].includes(t.id)):tasks;
if(offline){const {materialize,grade}=await import('../test/agent-evals/grader.mjs');for(const task of selected){const project=resolve(folder,task.id);await mkdir(project);const protectedHashes=await materialize(task,project),result=await grade(task,project,resolve(folder,'trusted'),{python,protectedHashes});if(result.passed)throw new Error('Baseline fixture passes: '+task.id);ledger.trials.push({task:task.id,baselineFailed:true,reason:result.reason});}await save();console.log(JSON.stringify({folder,fixtures:ledger.trials.length,baselineFailuresProven:true}));process.exit(0);}
const key=await persistentKey('DEEPSEEK_API_KEY');if(!key)throw new Error('DEEPSEEK_API_KEY unavailable');
const jobs=[];for(let repeat=1;repeat<=repeats;repeat++)for(const task of selected)for(const base of baseline?[baseline,root]:[root])jobs.push({task,base,repeat});
async function run(job,index){
  const allowance=Math.min(120000,budget-ledger.spent-ledger.reserved);if(allowance<32768)return;
  const destination=await mkdtemp(resolve(folder,'trial-'+index+'-'));
  ledger.reserved+=allowance;const trial={task:job.task.id,repeat:job.repeat,base:job.base,allowance,status:'running',report:resolve(destination,'report.json')};ledger.trials.push(trial);await save();
  const child=spawn(process.execPath,[resolve(root,'scripts/agent-eval-child.mjs'),job.base,destination,job.task.id,String(allowance),python],{cwd:root,env:{...process.env,DEEPSEEK_API_KEY:key},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const timeout=setTimeout(()=>child.kill(),210000);let code;
  try{code=await new Promise((accept,reject)=>{child.once('close',accept);child.once('error',reject);});}catch(error){output+='\n'+error.message;}finally{clearTimeout(timeout);}
  await writeFile(resolve(destination,'launch.log'),output);
  let report;try{report=JSON.parse(await readFile(resolve(destination,'report.json')));}catch{}
  // Missing usage, child loss, or missing reports retain the full reservation.
  const charge=code===0&&Number.isSafeInteger(report?.chargedTokens)&&report.chargedTokens>=report.usedTokens&&report.chargedTokens<=allowance?report.chargedTokens:allowance;
  ledger.reserved-=allowance;ledger.spent+=charge;Object.assign(trial,{status:code===0?'finished':'failed',report:resolve(destination,'report.json'),passed:!!report?.passed,usedTokens:report?.usedTokens,chargedTokens:charge,category:report?.grader?.category||report?.error});
  await save();console.log(JSON.stringify({completed:ledger.trials.filter(t=>t.status!=='running').length,total:jobs.length,task:job.task.id,version:report?.version,repeat:job.repeat,passed:trial.passed,usedTokens:report?.usedTokens,budgetCharged:ledger.spent}));
}
const pending=jobs.filter(job=>!ledger.trials.some(trial=>trial.task===job.task.id&&trial.base===job.base&&trial.repeat===job.repeat));
const startIndex=ledger.trials.length;for(let index=0;index<pending.length;index+=3)await Promise.all(pending.slice(index,index+3).map((job,offset)=>run(job,startIndex+index+offset)));
ledger.endedAt=new Date().toISOString();ledger.plannedTrials=jobs.length;ledger.complete=ledger.trials.length===jobs.length;ledger.summary={};
for(const trial of ledger.trials){const key=trial.base===root?'candidate':'baseline',summary=ledger.summary[key] ||= {trials:0,passed:0,firstTrials:0,firstPassed:0};summary.trials++;summary.passed+=Number(trial.passed);if(trial.repeat===1){summary.firstTrials++;summary.firstPassed+=Number(trial.passed);}}
await save();console.log(JSON.stringify({folder,complete:ledger.complete,spent:ledger.spent,summary:ledger.summary}));
