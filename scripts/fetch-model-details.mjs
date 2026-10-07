import {readFile,writeFile} from 'node:fs/promises';
import {aliyunContent} from './model-source-utils.mjs';
const dir='.agent/verification/model-catalog-sources/',sources=new Map();
for(const file of ['dashscope','dashscopeText','dashscopeVision']){
 const html=aliyunContent(await readFile(dir+file+'.txt','utf8'));
 for(const m of html.matchAll(/href="(\/zh\/model-studio\/[^"#?]+)"/g))if(!/get-api|billing|pricing|compatibility|api-key|quick-start/.test(m[1]))sources.set('aliyun-'+m[1].split('/').filter(Boolean).at(-1),'https://help.aliyun.com'+m[1]);
}
const z=await readFile(dir+'zhipu.txt','utf8');for(const m of z.matchAll(/\]\((\/cn\/guide\/models\/[^)]+)\)/g))sources.set('zhipu-'+m[1].split('/').at(-1),'https://docs.bigmodel.cn'+m[1]+'.md');
const c=await readFile(dir+'claude-life-web.txt','utf8');for(const m of c.matchAll(/\[Button: (claude-[\w-]+)\]\s*\|\s*(Active|Deprecated)/g)){
 const slug=m[1].replace(/^claude-/,'').replace(/-\d{8}$/,'');sources.set('claude-'+slug,'https://platform.claude.com/docs/en/models/'+slug+'/overview');
}
const mm=await readFile(dir+'minimax.txt','utf8');for(const m of mm.matchAll(/\]\((\/docs\/api-reference\/[^)]+)\)/g))sources.set('minimax-'+m[1].split('/').at(-1),'https://platform.minimax.io'+m[1]+'.md');
sources.set('deepseek-details','https://api-docs.deepseek.com/quick_start/pricing');
if(process.argv.includes('--extra-only'))for(const key of [...sources.keys()])if(!key.startsWith('claude-')&&!key.startsWith('deepseek-'))sources.delete(key);
if(process.argv.includes('--minimax-only'))for(const key of [...sources.keys()])if(!key.startsWith('minimax-'))sources.delete(key);
const list=[...sources],report=[];
for(let i=0;i<list.length;i+=8)await Promise.all(list.slice(i,i+8).map(async([id,url])=>{
 try{const r=await fetch(url,{signal:AbortSignal.timeout(30000)}),body=await r.text();await writeFile(dir+id+'.txt',body);report.push({id,url,status:r.status,bytes:Buffer.byteLength(body)});}catch(e){report.push({id,url,error:e.message});}
}));
await writeFile(dir+'details-manifest.json',JSON.stringify({retrievedAt:new Date().toISOString(),sources:report},null,2));
console.log(JSON.stringify({requested:list.length,downloaded:report.filter(r=>r.status===200).length,failures:report.filter(r=>r.status!==200)}));
