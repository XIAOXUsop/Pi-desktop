import {spawn} from 'node:child_process';
import {mkdir,readdir,readFile,writeFile,copyFile,stat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
const live = process.argv.includes('--live');
const folder = resolve(root,'.agent/verification/full',new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(folder,{recursive:true});
const report = {startedAt:new Date().toISOString(),node:process.version,platform:process.platform,liveRequested:live,folder,phases:[]};
const cleanEnv = {...process.env};
for(const name of Object.keys(cleanEnv)) if(/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) delete cleanEnv[name];
delete cleanEnv.ELECTRON_RUN_AS_NODE;
// Only test-created profiles/projects are mutated; Windows user variables stay intact.
async function save() {await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2));}
async function phase(name,operation) {
  const result={name,startedAt:new Date().toISOString(),status:'running'};report.phases.push(result);await save();console.log(`[START] ${name}`);
  try {Object.assign(result,await operation());result.status='passed';}
  catch(error) {result.status='failed';result.error=error.message;console.error(`[FAIL] ${name}: ${error.message}`);}
  result.endedAt=new Date().toISOString();result.seconds=Math.round((Date.parse(result.endedAt)-Date.parse(result.startedAt))/100)/10;await save();console.log(`[${result.status.toUpperCase()}] ${name} (${result.seconds}s)`);
  return result;
}
async function run(name,executable,args,env=cleanEnv,timeout=300000) {
  const logPath=resolve(folder,name+'.log');const output=createWriteStream(logPath);
  const child=spawn(executable,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill();},timeout);
  const code=await new Promise((accept,reject)=>{child.once('error',reject);child.once('close',accept);}).finally(()=>clearTimeout(timer));
  await new Promise(accept=>output.end(accept));
  if(timedOut) throw new Error(`${name} 超时；日志：${logPath}`);
  if(code !== 0) throw new Error(`${name} 退出码 ${code}；日志：${logPath}`);
  return {exitCode:code,log:logPath};
}
async function files(directory) {
  const result=[];
  for(const entry of await readdir(resolve(root,directory),{withFileTypes:true})) {
    const path=resolve(root,directory,entry.name);if(entry.isDirectory()) result.push(...await files(relative(root,path)));else if(/\.(?:mjs|cjs|js)$/.test(entry.name)) result.push(relative(root,path));
  }
  return result;
}
await phase('typecheck',()=>run('typecheck',process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json','--noEmit']));
const build=await phase('build',()=>run('build',process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json']));
await phase('javascript-syntax',async()=>{const paths=[...await files('desktop'),...await files('scripts')];for(const [index,path] of paths.entries()) await run('syntax-'+index,process.execPath,['--check',path]);return {files:paths.length};});
if(build.status === 'passed') {
  await phase('all-unit-and-integration-with-coverage',async()=>{
    const core=(await files('dist/test')).filter(path=>/\.test\.js$/.test(path));
    const desktop=(await files('test')).filter(path=>/\.test\.mjs$/.test(path));
    const result=await run('automated-tests',process.execPath,['--test','--experimental-test-coverage','--test-coverage-include=dist/src/**','--test-coverage-include=desktop/**',
      '--test-reporter=spec',`--test-reporter-destination=${resolve(folder,'tests.txt')}`,'--test-reporter=./scripts/test-summary-reporter.mjs',`--test-reporter-destination=${resolve(folder,'test-events.ndjson')}`,
      '--test-reporter=lcov',`--test-reporter-destination=${resolve(folder,'coverage.lcov')}`,...core,...desktop]);
    const events=(await readFile(resolve(folder,'test-events.ndjson'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const summary=events.filter(event=>event.type==='test:summary').at(-1)?.data;assert(summary,'Missing test summary');
    const coverage=events.filter(event=>event.type==='test:coverage').at(-1)?.data?.summary;
    assert(coverage?.files?.length,'Missing module coverage');
    await writeFile(resolve(folder,'coverage.json'),JSON.stringify(coverage,null,2));
    return {...result,testFiles:core.length+desktop.length,summary,coverageTotals:coverage?.totals,coverageScope:'Only modules exercised by Node tests; renderer/main-process end-to-end coverage is not included.'};
  });
  await phase('cli-demo',async()=>{
    const result=await run('cli-demo',process.execPath,['dist/src/cli.js','demo']);const lines=(await readFile(result.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const demo=lines.find(event=>event.type==='demo_result');assert(demo);assert.equal(demo.file,'Hello, coding agent!\r\n');return {...result,workspace:demo.workspace,fileVerified:true};
  });
  const electron=createRequire(import.meta.url)('electron');
  await phase('desktop-offline-end-to-end',async()=>{
    const started=Date.now();const result=await run('desktop-offline',electron,['desktop/main.mjs','--smoke']);
    const smoke=JSON.parse(await readFile(resolve(root,'.agent/verification/desktop-smoke.json'),'utf8'));assert(Date.parse(smoke.timestamp)>=started);assert.deepEqual(smoke.errors,[]);
    await copyFile(resolve(root,'.agent/verification/desktop-smoke.json'),resolve(folder,'desktop-smoke.json'));return {...result,checks:smoke.checks.length,rendererErrors:smoke.errors.length,engine:'official Pi'};
  });
  if(live) {
    await phase('public-pi-market-read',async()=>{
      const {ResourceMarket}=await import('../desktop/resource-market.mjs');const market=new ResourceMarket();const found=await market.search({query:'theme'});assert(found.items.length>0);
      const detail=await market.detail(found.items[0]);assert.equal(detail.source,`npm:${found.items[0].name}@${found.items[0].version}`);
      await writeFile(resolve(folder,'market.json'),JSON.stringify({items:found.items,detail},null,2));return {results:found.items.length,versionVerified:true,installed:false};
    });
    const {persistentKey}=await import('../desktop/settings.mjs');const key=await persistentKey('DEEPSEEK_API_KEY');const liveEnv={...cleanEnv,DEEPSEEK_API_KEY:key || ''};
    await phase('deepseek-cli-live-acceptance',async()=>{
      assert(key,'DEEPSEEK_API_KEY is unavailable');const started=Date.now();const result=await run('deepseek-cli-live',process.execPath,['scripts/live-acceptance.mjs'],liveEnv,600000);
      const path=resolve(root,'.agent/acceptance/latest-report.json');assert((await stat(path)).mtimeMs>=started);const data=JSON.parse(await readFile(path,'utf8'));
      assert(data.baselineFailed && data.testsPassed && data.testFilesUnchanged && data.failedTestObserved && data.successfulTestObserved);
      assert.equal(data.cancelled.status,'cancelled');assert.equal(data.resumed.status,'completed');await copyFile(path,resolve(folder,'deepseek-cli.json'));
      return {...result,model:data.model,repair:data.repair.status,cancel:data.cancelled.status,resume:data.resumed.status,testFileUnchanged:data.testFilesUnchanged,usage:data.usage};
    });
    await phase('deepseek-pi-desktop-live-acceptance',async()=>{
      assert(key,'DEEPSEEK_API_KEY is unavailable');const started=Date.now();const result=await run('deepseek-desktop-live',electron,['desktop/main.mjs','--live-smoke'],liveEnv,240000);
      const path=resolve(root,'.agent/verification/desktop-deepseek.json');const data=JSON.parse(await readFile(path,'utf8'));assert(Date.parse(data.timestamp)>=started);assert.equal(data.result.status,'completed');assert.equal(data.testFileUnchanged,true);
      await copyFile(path,resolve(folder,'deepseek-desktop.json'));return {...result,model:data.model,result:data.result.status,testFileUnchanged:data.testFileUnchanged,changes:data.changes,usage:data.usage};
    });
  }
} else report.phases.push({name:'dependent-tests',status:'blocked',error:'Build failed; stale compiled outputs are not executed.'});
report.endedAt=new Date().toISOString();report.status=report.phases.every(phase=>phase.status==='passed')?'passed':'failed';await save();
await mkdir(resolve(root,'.agent/verification'),{recursive:true});await copyFile(resolve(folder,'report.json'),resolve(root,'.agent/verification/full-test-latest.json'));
console.log(JSON.stringify(report,null,2));if(report.status!=='passed') process.exitCode=1;
