import {readFile,readdir,lstat,unlink,rmdir} from 'node:fs/promises';
import {relative,sep,basename,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Workspace} from './tools/workspace.js';
import {StateDirectory,checkedId,UUID,durableBytes,durableJson,readJson} from './durable-files.js';
const exec=promisify(execFile),HASH=/^[a-f0-9]{64}$/;
const excluded=new Set(['.git','.agent','node_modules','.npm-cache','.profile','dist','build','coverage','.next','.venv','__pycache__','target']);
const sensitive=(path:string)=>path.split('/').some(p=>/^\.env(?:\.|$)/i.test(p)||/\.(?:pem|key|p12|pfx)$/i.test(p)||/^(?:auth|keys|credentials)\.json$|^\.npmrc$|^\.git-credentials$/i.test(p));
export const checkpointDefaults={maxFileBytes:16*1024*1024,maxRunBytes:128*1024*1024,maxStorageBytes:512*1024*1024,keepTasks:20,maxFiles:20000};
export type CheckpointLimits=typeof checkpointDefaults;
export function checkpointLimits(value: Partial<CheckpointLimits>={}):CheckpointLimits {
  const result={...checkpointDefaults,...value};
  for(const [key,number] of Object.entries(result))if(!Number.isSafeInteger(number)||number<1||number>(key==='keepTasks'?1000:key==='maxFiles'?100000:8*1024*1024*1024))throw new Error('Invalid checkpoint limit');
  if(result.maxRunBytes<result.maxFileBytes||result.maxStorageBytes<result.maxRunBytes)throw new Error('Checkpoint capacity order is invalid');
  return result;
}
export interface ByteSnapshot {exists:boolean;hash:string|null;blob:string|null;bytes:number;mode:number}
export interface CheckpointFile {path:string;before:ByteSnapshot;after:ByteSnapshot;source:'file_tool'|'observed';callIds:string[]}
export interface CheckpointManifest {
  version:1;workspace:string;sessionId:string;runId:string;branch:string|null;createdAt:number;state:'capturing'|'finalized'|'incomplete';
  coverage:'scoped'|'partial'|'none';inventoryMode:'git'|'walk'|'file_tools';limits:CheckpointLimits;
  files:Record<string,CheckpointFile>;omissions:{path:string;reason:string}[];pinned?:boolean;
  initialPaths?:string[];excludedPaths?:string[];
}
const missing=():ByteSnapshot=>({exists:false,hash:null,blob:null,bytes:0,mode:0o644});
export function validateSnapshot(value:ByteSnapshot,unavailable=false):void {
  if(!value||typeof value.exists!=='boolean'||!Number.isSafeInteger(value.bytes)||value.bytes<0||!Number.isSafeInteger(value.mode))throw new Error('Corrupt byte snapshot');
  if(value.exists){if(!value.hash||!HASH.test(value.hash)||value.blob!==null&&value.blob!==value.hash)throw new Error('Corrupt blob reference');}
  else if(value.bytes!==0||value.blob!==null||value.hash!==null&&!(unavailable&&value.hash==='unavailable'))throw new Error('Corrupt missing snapshot');
}
export function validateCheckpointPath(path:string):void {if(typeof path!=='string'||!path||path.includes('\\')||path.includes(':')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Corrupt checkpoint path');}
export class CheckpointStore {
  objectBytes?:number;
  private constructor(readonly workspace:Workspace,readonly directory:StateDirectory,readonly limits:CheckpointLimits){}
  static async open(root:string,limits:Partial<CheckpointLimits>={}) {return new CheckpointStore(await Workspace.open(root),await StateDirectory.open(root),checkpointLimits(limits));}
  manifestPath(sessionId:string,runId:string,create=false){return this.directory.path(['.agent','checkpoints',checkedId(sessionId),checkedId(runId),'manifest.json'],create);}
  async load(sessionId:string,runId:string):Promise<CheckpointManifest> {
    const m=await readJson(await this.manifestPath(sessionId,runId),64*1024*1024);
    if(m.version!==1||m.workspace!==this.workspace.root||m.sessionId!==sessionId||m.runId!==runId||!m.files||Array.isArray(m.files)||!Array.isArray(m.omissions)||!['capturing','finalized','incomplete'].includes(m.state)||!['scoped','partial','none'].includes(m.coverage)||!Number.isFinite(m.createdAt))throw new Error('Corrupt checkpoint');
    for(const [path,file] of Object.entries(m.files) as [string,CheckpointFile][]){validateCheckpointPath(path);if(path!==file.path||!['file_tool','observed'].includes(file.source)||!Array.isArray(file.callIds))throw new Error('Corrupt checkpoint file');validateSnapshot(file.before);validateSnapshot(file.after,true);}
    m.files=Object.assign(Object.create(null),m.files);return m;
  }
  async persist(m:CheckpointManifest){await durableJson(await this.manifestPath(m.sessionId,m.runId,true),m);}
  async allManifests():Promise<CheckpointManifest[]> {
    const probe=await this.directory.path(['.agent','checkpoints','probe.json']),folder=resolve(probe,'..'),result:CheckpointManifest[]=[];
    for(const session of await readdir(folder).catch(e=>{if(e.code!=='ENOENT')throw e;return [];})) {
      if(session==='objects')continue;
      if(!UUID.test(session))throw new Error('Unknown checkpoint directory; cleanup refused');
      const p=await this.directory.path(['.agent','checkpoints',session,'probe.json']);
      for(const run of await readdir(resolve(p,'..'))) {
        if(!UUID.test(run))throw new Error('Unknown checkpoint task; cleanup refused');
        result.push(await this.load(session,run));
      }
    }
    return result;
  }
  async maintenance() {
    const manifests=await this.allManifests(),references=new Set<string>();let opaqueTemporary=false;
    const operations=async(m:CheckpointManifest)=>{
      const folder=resolve(await this.manifestPath(m.sessionId,m.runId),'..'),values:any[]=[];
      for(const name of await readdir(folder)) {
        if(name==='manifest.json')continue;
        if(/^\.(?:manifest\.json|rollback-[a-f0-9-]{36}\.json)\.[a-f0-9-]{36}\.tmp$/i.test(name)) {
          const temp=await readJson(await this.directory.path(['.agent','checkpoints',m.sessionId,m.runId,name]),64*1024*1024).catch(()=>null);
          if(!temp||temp.workspace!==this.workspace.root||temp.sessionId!==m.sessionId||temp.runId!==m.runId)opaqueTemporary=true;
          const snapshots=temp?.files?Object.values(temp.files).flatMap((file:any)=>[file.before,file.after]):[];
          values.push({state:'prepared',steps:[...snapshots.map(target=>({target})),...(temp?.steps||[])]});continue;
        }
        if(!/^rollback-[a-f0-9-]{36}\.json$/i.test(name))throw new Error('Unknown checkpoint file; cleanup refused');
        const op=await readJson(await this.directory.path(['.agent','checkpoints',m.sessionId,m.runId,name]));
        if(op.version!==1||op.workspace!==this.workspace.root||op.sessionId!==m.sessionId||op.runId!==m.runId||!Array.isArray(op.steps)||!['preview','prepared','applying','committed'].includes(op.state)||'rollback-'+op.operationId+'.json'!==name)throw new Error('Corrupt rollback; cleanup refused');
        for(const step of op.steps){validateCheckpointPath(step.path);for(const snapshot of [step.target,step.expected,step.backup])if(snapshot)validateSnapshot(snapshot,true);}
        values.push(op);
      }return values;
    };
    const closed:CheckpointManifest[]=[];
    // Validate every reference before deleting any manifest or object.
    for(const m of manifests){for(const file of Object.values(m.files))for(const snapshot of [file.before,file.after])if(snapshot.blob&&!HASH.test(snapshot.blob))throw new Error('Invalid blob reference');await operations(m);}
    for(const m of manifests) {
      const ops=await operations(m);
      const run=await readJson(await this.directory.path(['.agent','runs',m.sessionId,m.runId+'.json'])).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      if(run&&(run.version!==1||run.workspace!==this.workspace.root||run.sessionId!==m.sessionId||run.runId!==m.runId))throw new Error('Corrupt run; cleanup refused');
      if(m.state!=='capturing'&&!m.pinned&&run&&['completed','failed','cancelled','limit','interrupted'].includes(run.status)&&
        !ops.some(op=>['prepared','applying'].includes(op.state)||op.state==='preview'&&op.expiresAt>Date.now()))closed.push(m);
    }
    closed.sort((a,b)=>b.createdAt-a.createdAt);
    for(const m of closed.slice(this.limits.keepTasks)) {
      const runPath=await this.directory.path(['.agent','runs',m.sessionId,m.runId+'.json']),record=await readJson(runPath);await durableJson(runPath,{...record,checkpointExpired:true});
      const folder=resolve(await this.manifestPath(m.sessionId,m.runId),'..');
      for(const name of await readdir(folder))await unlink(await this.directory.path(['.agent','checkpoints',m.sessionId,m.runId,name]));
      await rmdir(folder);
    }
    for(const m of await this.allManifests()) {
      for(const f of Object.values(m.files))for(const snapshot of [f.before,f.after])if(snapshot.blob){if(!HASH.test(snapshot.blob))throw new Error('Invalid blob reference');references.add(snapshot.blob);}
      for(const op of await operations(m))for(const step of op.steps)for(const snapshot of [step.target,step.expected,step.backup])if(snapshot?.blob){if(!HASH.test(snapshot.blob))throw new Error('Invalid rollback reference');references.add(snapshot.blob);}
    }
    const probe=await this.directory.path(['.agent','checkpoints','objects','probe.bin']);
    if(!opaqueTemporary)for(const name of await readdir(resolve(probe,'..')).catch(e=>{if(e.code!=='ENOENT')throw e;return [];}))if(/^[a-f0-9]{64}\.bin$/.test(name)&&!references.has(name.slice(0,-4)))await unlink(await this.blobPath(name.slice(0,-4)));
    this.objectBytes=await this.storageBytes();
  }
  async blobPath(hash:string,create=false){if(!HASH.test(hash))throw new Error('Invalid blob');return this.directory.path(['.agent','checkpoints','objects',hash+'.bin'],create);}
  async blob(snapshot:ByteSnapshot):Promise<Buffer> {
    if(!snapshot.exists||!snapshot.blob||snapshot.blob!==snapshot.hash)throw new Error('Snapshot unavailable');
    const bytes=await readFile(await this.blobPath(snapshot.blob));
    if(bytes.length!==snapshot.bytes||createHash('sha256').update(bytes).digest('hex')!==snapshot.hash)throw new Error('Snapshot checksum mismatch');
    return bytes;
  }
  async storageBytes():Promise<number> {
    const probe=await this.directory.path(['.agent','checkpoints','objects','probe.bin']);
    let total=0;
    for(const name of await readdir(resolve(probe,'..')).catch(e=>{if(e.code!=='ENOENT')throw e;return [];}))if(/^[a-f0-9]{64}\.bin$/.test(name))total+=(await lstat(await this.blobPath(name.slice(0,-4)))).size;
    return total;
  }
  async capture(path:string,retain=true):Promise<ByteSnapshot> {
    if(sensitive(path))throw new Error('Sensitive file excluded from checkpoints');
    const target=await this.workspace.path(path);
    let info;try{info=await lstat(target);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return missing();throw e;}
    if(!info.isFile()||info.nlink>1||info.size>this.limits.maxFileBytes)throw new Error('Checkpoint requires a regular file within the size limit');
    const bytes=await readFile(target),after=await lstat(await this.workspace.path(path));
    if(bytes.length>this.limits.maxFileBytes||info.size!==after.size||info.mtimeMs!==after.mtimeMs||after.nlink>1)throw new Error('File changed during capture');
    const hash=createHash('sha256').update(bytes).digest('hex'),snapshot={exists:true,hash,blob:retain?hash:null,bytes:bytes.length,mode:info.mode&0o777};
    if(retain) {
      const blob=await this.blobPath(hash,true),exists=await lstat(blob).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      if(exists)await this.blob(snapshot);
      else {this.objectBytes??=await this.storageBytes();if(this.objectBytes+bytes.length>this.limits.maxStorageBytes)throw new Error('Checkpoint storage capacity exceeded');await durableBytes(blob,bytes);this.objectBytes+=bytes.length;}
    }
    return snapshot;
  }
  async inventory():Promise<{paths:string[];seen:string[];excludedPaths:string[];mode:'git'|'walk';omissions:{path:string;reason:string}[]}> {
    const omissions:{path:string;reason:string}[]=[],excludedPaths:string[]=[];let gitPaths:string[]|undefined;
    try {
      const {stdout}=await exec('git',['-C',this.workspace.root,'ls-files','-z','--cached','--others','--exclude-standard'],{windowsHide:true,timeout:5000,maxBuffer:16*1024*1024});
      const paths=[...new Set(stdout.split('\0').filter(Boolean))].filter(p=>!p.split('/').some(part=>['.agent','.git'].includes(part))&&!sensitive(p));
      if(paths.length>this.limits.maxFiles)omissions.push({path:'.',reason:'File inventory limit'});
      gitPaths=paths.slice(0,this.limits.maxFiles);
    } catch(error) {if(!['ENOENT',128,1].includes((error as any).code))omissions.push({path:'.',reason:'Git inventory unavailable; using bounded walk'});}
    const paths:string[]=[];
    type Rule={regex:RegExp;negate:boolean};const rules:Rule[]=[];
    async function walk(this:CheckpointStore,folder:string) {
      if(paths.length>=this.limits.maxFiles){omissions.push({path:folder||'.',reason:'File inventory limit'});return;}
      const ignore=await readFile(resolve(this.workspace.root,folder,'.gitignore'),'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return '';});
      const local=[...rules];
      for(let line of ignore.split(/\r?\n/)) {
        line=line.trim();if(!line||line.startsWith('#'))continue;
        const negate=line.startsWith('!');if(negate)line=line.slice(1);
        if(line.length>1024||/[\[\]{}]/.test(line)){omissions.push({path:(folder?folder+'/':'')+'.gitignore',reason:'Unsupported ignore pattern'});continue;}
        const anchored=line.startsWith('/'),directory=line.endsWith('/');line=line.replace(/^\/|\/$/g,'');
        let pattern='';for(let i=0;i<line.length;i++){const c=line[i]!;if(c==='*'){if(line[i+1]==='*'){pattern+='.*';i++;}else pattern+='[^/]*';}else if(c==='?')pattern+='[^/]';else pattern+=/[a-z0-9 _/\-]/i.test(c)?c:'\\'+c;}
        const base=folder?folder.split('/').map(p=>p.replace(/\./g,'\\.')).join('/')+'/':'';
        local.push({regex:new RegExp('^'+base+(anchored||line.includes('/')?'':'(?:.*/)?')+pattern+(directory?'(?:/.*)?':'(?:/.*)?')+'$'),negate});
      }
      for(const entry of await readdir(resolve(this.workspace.root,folder),{withFileTypes:true})) {
        const path=(folder?folder+'/':'')+entry.name;if(excluded.has(entry.name.toLowerCase())||sensitive(path)){excludedPaths.push(path);continue;}
        let ignored=false;for(const rule of local)if(rule.regex.test(path))ignored=!rule.negate;if(ignored){excludedPaths.push(path);continue;}
        if(entry.isSymbolicLink()){omissions.push({path,reason:'Link excluded'});continue;}
        if(entry.isDirectory()) {const saved=rules.splice(0,rules.length,...local);await walk.call(this,path);rules.splice(0,rules.length,...saved);}
        else if(entry.isFile()) {if(paths.length<this.limits.maxFiles)paths.push(path);else omissions.push({path,reason:'File inventory limit'});}
      }
    }
    await walk.call(this,'');return {paths:gitPaths||paths,seen:paths,excludedPaths,mode:gitPaths?'git':'walk',omissions};
  }
}
export class TaskCheckpoint {
  private constructor(readonly store:CheckpointStore,readonly manifest:CheckpointManifest){}
  static async resume(store:CheckpointStore,sessionId:string,runId:string) {
    const manifest=await store.load(sessionId,runId);
    if(manifest.state==='capturing')for(const file of Object.values(manifest.files))file.source='observed';
    return new TaskCheckpoint(store,manifest);
  }
  static async create(store:CheckpointStore,sessionId:string,runId:string,branch:string|null,observe=false) {
    const manifest:CheckpointManifest={version:1,workspace:store.workspace.root,sessionId:checkedId(sessionId),runId:checkedId(runId),branch,createdAt:Date.now(),state:'capturing',coverage:'none',inventoryMode:'file_tools',limits:store.limits,files:Object.create(null),omissions:[]};
    const task=new TaskCheckpoint(store,manifest);await store.persist(manifest);
    if(observe) {
      const inventory=await store.inventory();manifest.inventoryMode=inventory.mode;manifest.omissions=inventory.omissions;
      manifest.initialPaths=[...new Set([...inventory.seen,...inventory.paths])];manifest.excludedPaths=inventory.excludedPaths;
      for(const path of inventory.paths)try {const before=await task.capture(path);manifest.files[path]={path,before,after:before,source:'observed',callIds:[]};}
      catch(error){task.omit(path,error);}
      manifest.coverage=manifest.omissions.length?'partial':'scoped';await store.persist(manifest);
    }
    return task;
  }
  private omit(path:string,error:unknown){this.manifest.omissions.push({path,reason:error instanceof Error?error.message:'Capture failed'});this.manifest.coverage='partial';}
  private usedBytes(extra?:ByteSnapshot):number {
    const snapshots=[...Object.values(this.manifest.files).flatMap(f=>[f.before,f.after]),...(extra?[extra]:[])];
    const unique=new Map(snapshots.filter(s=>s.exists&&s.hash).map(s=>[s.hash,s.bytes]));return [...unique.values()].reduce((a,b)=>a+b,0);
  }
  private async capture(path:string) {
    const snapshot=await this.store.capture(path,false);
    if(this.usedBytes(snapshot)>this.store.limits.maxRunBytes)throw new Error('Checkpoint task capacity exceeded');
    return this.store.capture(path);
  }
  async before(path:string,callId:string) {
    const canonical=await this.store.workspace.path(path),rel=relative(this.store.workspace.root,canonical).split(sep).join('/');
    const current=await this.capture(rel),existing=this.manifest.files[rel];
    if(!existing)this.manifest.files[rel]={path:rel,before:current,after:current,source:'file_tool',callIds:[callId]};
    else {if(current.hash===existing.after.hash&&current.exists===existing.after.exists)existing.source='file_tool';existing.callIds.push(callId);}
    if(this.manifest.coverage==='none')this.manifest.coverage='scoped';await this.store.persist(this.manifest);return rel;
  }
  async after(path:string) {
    const file=this.manifest.files[path];if(!file)throw new Error('Missing baseline');
    try {file.after=await this.capture(path);}catch(error){this.omit(path,error);file.after=await this.store.capture(path,false).catch(()=>({...missing(),hash:'unavailable'}));}
    await this.store.persist(this.manifest);
  }
  async finalize() {
    if(this.manifest.inventoryMode!=='file_tools') {
      const inventory=await this.store.inventory();this.manifest.omissions.push(...inventory.omissions);
      for(const path of inventory.paths)if(!Object.hasOwn(this.manifest.files,path)) {
        if(this.manifest.initialPaths?.includes(path)||this.manifest.omissions.length||this.manifest.excludedPaths?.some(p=>path===p||path.startsWith(p+'/'))){this.omit(path,new Error('No reliable baseline for this observed file'));continue;}
        this.manifest.files[path]={path,before:missing(),after:missing(),source:'observed',callIds:[]};
      }
    }
    for(const path of Object.keys(this.manifest.files))await this.after(path);
    this.manifest.state=this.manifest.omissions.length?'incomplete':'finalized';
    if(this.manifest.omissions.length)this.manifest.coverage='partial';
    await this.store.persist(this.manifest);return {coverage:this.manifest.coverage,files:Object.values(this.manifest.files).filter(f=>f.before.hash!==f.after.hash||f.before.exists!==f.after.exists).length,omissions:this.manifest.omissions.length};
  }
}
