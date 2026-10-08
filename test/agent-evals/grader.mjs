import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,cp,mkdtemp,readdir} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),hash=value=>createHash('sha256').update(value).digest('hex');
export function testFiles(task) {
  if(task.language==='javascript')return {'test/acceptance.mjs':`import assert from 'node:assert/strict';import * as m from '../${task.entry}';${task.expression}\n`};
  if(task.language==='python')return {'test/acceptance.py':`import importlib.util\nspec=importlib.util.spec_from_file_location('task','src/main.py')\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n${task.check}\n`};
  if(task.language==='java')return {'test/Verify.java':`public class Verify {public static void main(String[] args){${task.check}}}`};
  return {};
}
export async function materialize(task,root) {
  const files={...task.files,...testFiles(task)};
  for(const [path,text]of Object.entries(files)){await mkdir(dirname(resolve(root,path)),{recursive:true});await writeFile(resolve(root,path),text);}
  return Object.fromEntries(Object.entries(files).filter(([p])=>!task.allowed.includes(p)).map(([p,text])=>[p,hash(text)]));
}
export function command(task,python) {
  return task.language==='python'?`& '${python.replaceAll("'","''")}' test/acceptance.py`:task.language==='java'?'javac -d out src/Task.java test/Verify.java; if ($LASTEXITCODE -eq 0) { java -cp out Verify }':task.language==='powershell'?"& ./src/read.ps1 -Path '资料 空格/[样例].txt'":'node test/acceptance.mjs';
}
export async function grade(task,root,folder,{python='python',protectedHashes={}}={}) {
  try{
    for(const[path,expected]of Object.entries(protectedHashes))assert.equal(hash(await readFile(resolve(root,path))),expected,'Protected file changed: '+path);
    async function paths(dir=''){const result=[];for(const ent of await readdir(resolve(root,dir),{withFileTypes:true})){const p=dir?dir+'/'+ent.name:ent.name;if(ent.isSymbolicLink())throw new Error('Linked evaluation output');if(ent.isDirectory()){if(!['.agent','out','__pycache__','.git'].includes(ent.name))result.push(...await paths(p));}else result.push(p);}return result;}
    for(const path of await paths())assert(task.allowed.includes(path)||path in task.files||path in testFiles(task),'Unexpected output file: '+path);
    // A fresh environment uses original tests and only permitted submitted code.
    await mkdir(folder,{recursive:true});const isolated=await mkdtemp(resolve(folder,'grade-'));await materialize(task,isolated);
    for(const path of task.allowed){await mkdir(dirname(resolve(isolated,path)),{recursive:true});await cp(resolve(root,path),resolve(isolated,path));}
    if(task.exact)assert.deepEqual(await readFile(resolve(isolated,task.entry)),Buffer.from(task.exact,'base64'),'Unrelated original bytes changed');
    let result;
    const options={cwd:isolated,windowsHide:true,timeout:15000,maxBuffer:1024*1024,env:{...process.env,DEEPSEEK_API_KEY:''}};
    if(task.language==='javascript')result=await exec(process.execPath,['test/acceptance.mjs'],options);
    else if(task.language==='python')result=await exec(python,['test/acceptance.py'],options);
    else if(task.language==='java'){await exec('javac',['-d','out','src/Task.java','test/Verify.java'],options);result=await exec('java',['-cp','out','Verify'],options);}
    else {result=await exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File','src/read.ps1','-Path','资料 空格/[样例].txt'],{...options,encoding:'buffer'});const values=[result.stdout.toString('utf8').trim(),new TextDecoder('gbk').decode(result.stdout).trim()];assert(values.includes('中文 fixture'),'Unexpected literal-path result: '+JSON.stringify(values));}
    return {passed:true,protectedFilesUnchanged:true};
  }catch(error){return {passed:false,reason:error.message.slice(0,2000),category:/Protected|Unexpected|Linked/.test(error.message)?'invalid_submission':'acceptance_failed'};}
}
