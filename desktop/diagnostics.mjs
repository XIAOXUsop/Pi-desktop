import {mkdir, stat, rename, unlink, appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
export function redact(value, secrets = []) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets.filter(v => typeof v === 'string' && v.length > 3).sort((a,b)=>b.length-a.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/(Bearer\s+)[^\s"'<>]+/gi,'$1[redacted]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*["']?)[^\s,"'}]+/gi,'$1[redacted]')
    .replace(/sk-[\w-]{8,}/g,'[redacted]')
    .replace(/[A-Z]:[\\/]Users[\\/][^\\/\s"']+/gi,'[user]');
}
export class Diagnostics {
  constructor(folder, {secrets = [], maxBytes = 5*1024*1024} = {}) {this.folder=folder;this.secrets=secrets;this.maxBytes=maxBytes;this.queue=Promise.resolve();this.rings=new Map();}
  capture(id, channel, chunk) {
    const key=id+':'+channel, state=this.rings.get(key) || {decoder:new StringDecoder('utf8'),text:''};
    state.text=(state.text+state.decoder.write(chunk)).slice(-64*1024);this.rings.set(key,state);
  }
  event(type, metadata = {}) {
    const allowed=['runId','sessionId','provider','model','stage','code','durationMs','exitCode','tokens','version','generation'];
    const data=Object.fromEntries(allowed.filter(k=>metadata[k]!==undefined).map(k=>[k,metadata[k]]));
    const operation=this.queue.then(async()=>{
      await mkdir(this.folder,{recursive:true});const path=resolve(this.folder,'desktop.jsonl');
      if((await stat(path).catch(()=>({size:0}))).size>this.maxBytes) {
        await unlink(path+'.2').catch(e=>{if(e.code!=='ENOENT')throw e;});
        await rename(path+'.1',path+'.2').catch(e=>{if(e.code!=='ENOENT')throw e;});await rename(path,path+'.1');
      }
      await appendFile(path,redact({timestamp:Date.now(),type,...data},this.secrets)+'\n',{mode:0o600});
    });this.queue=operation.catch(()=>{});return operation;
  }
  async bundle(metadata, {includeRuntime=false}={}) {
    await this.queue;return JSON.parse(redact({version:1,createdAt:new Date().toISOString(),metadata,
      ...(includeRuntime?{runtime:[...this.rings].map(([id,v])=>({id,text:v.text}))}:{})},this.secrets));
  }
}
