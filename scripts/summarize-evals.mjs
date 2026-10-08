import {readFile,writeFile,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {tasks} from '../test/agent-evals/catalog.mjs';
import {grade,testFiles} from '../test/agent-evals/grader.mjs';
import {taskMetrics} from './eval-metrics.mjs';
const path=resolve(process.argv[2]),ledger=JSON.parse(await readFile(path)),python=process.env.EVAL_PYTHON||'python';
let reclaimed=0;for(const trial of ledger.trials){
  let report;try{report=JSON.parse(await readFile(trial.report));}catch{continue;}
  const task=tasks.find(t=>t.id===trial.task),folder=dirname(trial.report);
  if(trial.status==='finished'&&Number.isSafeInteger(report.chargedTokens)&&report.chargedTokens>=report.usedTokens&&report.chargedTokens<=trial.allowance&&trial.chargedTokens>report.chargedTokens){trial.originalChargedTokens ??= trial.chargedTokens;reclaimed+=trial.chargedTokens-report.chargedTokens;trial.chargedTokens=report.chargedTokens;trial.reservationNote='Final report retains each unconfirmed request upper bound; unused trial capacity released.';}
  const hashes=Object.fromEntries(Object.entries({...task.files,...testFiles(task)}).filter(([p])=>!task.allowed.includes(p)).map(([p,text])=>[p,createHash('sha256').update(text).digest('hex')]));
  const result=await grade(task,resolve(folder,'project'),resolve(folder,'regrade'),{python,protectedHashes:hashes});
  trial.regraded={timestamp:new Date().toISOString(),graderVersion:2,result,reason:'Windows grader accepts UTF-8 or Windows Chinese console encoding; original report retained.'};
  trial.passed=report.result?.status==='completed'&&result.passed;trial.durationMs=report.durationMs;trial.firstVisibleMs=report.firstVisibleMs;trial.toolFailures=report.toolFailures;
  trial.failureClass=trial.passed?null:report.result?.error?.includes('reservation')?'trial_budget_limit':report.scenario==='plan'&&!report.result?'workflow_incomplete':report.error?.includes('workflow')||report.error?.includes('Planning')?'workflow_incomplete':result.category||'interrupted_evaluation';
  trial.metrics=await taskMetrics(folder,task,report);
}
ledger.spent=ledger.trials.reduce((n,t)=>n+(t.chargedTokens||0),0);ledger.summary={};
for(const trial of ledger.trials){const key=trial.base===ledger.baseline?'baseline':'candidate',s=ledger.summary[key] ||= {trials:0,passed:0,firstTrials:0,firstPassed:0,failures:{}};s.trials++;s.passed+=Number(trial.passed);if(trial.repeat===1){s.firstTrials++;s.firstPassed+=Number(trial.passed);}if(!trial.passed)s.failures[trial.failureClass]=(s.failures[trial.failureClass]||0)+1;}
ledger.reconciledAt=new Date().toISOString();await writeFile(path+'.tmp',JSON.stringify(ledger,null,2));await rename(path+'.tmp',path);console.log(JSON.stringify({spent:ledger.spent,reclaimed,remaining:ledger.budget-ledger.spent,summary:ledger.summary}));
