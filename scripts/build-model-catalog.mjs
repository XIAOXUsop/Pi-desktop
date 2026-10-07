// Build the bundled directory from captured official documentation, not a third-party registry.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {aliyunContent,nextPayload,jsonAt,plain} from './model-source-utils.mjs';
const dir='.agent/verification/model-catalog-sources/',date='2026-10-05';
const files=await readdir(dir),catalog={reviewedAt:date,providers:{}};
const read=id=>readFile(dir+id+'.txt','utf8');
const token=value=>{const m=String(value).replace(/,/g,'').trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);return m?Math.round(Number(m[1])*(m[2]?.toLowerCase()==='k'?1024:m[2]?.toLowerCase()==='m'?1000000:1)):undefined;};
const categories={text:'对话',vision:'视觉理解',image:'图像生成',video:'视频生成',audio:'语音',embedding:'向量',rerank:'重排序',decision:'决策',special:'专用接口'};
function add(provider,entry){
  if(!entry.id||entry.id.length>200)return;
  const list=catalog.providers[provider]??=[],existing=list.find(m=>m.id===entry.id);
  const item={name:entry.id,category:'对话',tools:true,status:'active',...existing,...entry,reviewedAt:date};
  item.limitsVerified=Number.isInteger(item.contextWindow)&&Number.isInteger(item.maxOutputTokens)&&item.maxOutputTokens>0&&item.maxOutputTokens<=item.contextWindow&&entry.limitsVerified!==false;
  if(existing?.limitsVerified&&entry.contextWindow===undefined&&entry.maxOutputTokens===undefined)item.limitsUrl=existing.limitsUrl;
  if(item.tools===false&&!item.unavailableReason)item.unavailableReason='此型号不支持当前编程对话';
  if(existing){for(const [k,v]of Object.entries(item))if(v!==undefined&&(k!=='limitsVerified'||item.limitsVerified))existing[k]=v;}else list.push(item);
}
function task(id){return /embedding/i.test(id)?'向量':/rerank/i.test(id)?'重排序':/image|cogview|flux|stable-diffusion|kolors/i.test(id)?'图像生成':/video|vidu|wan\d|wanx|hailuo|happyoyster|happyhorse/i.test(id)?'视频生成':/audio|speech|realtime|tts|asr|whisper|transcrib|music/i.test(id)?'语音':/decision|typesafe|moderation|ocr|autoglm|3d|doc-turbo|mt-/i.test(id)?'专用接口':'对话';}

// OpenAI: every model linked from All models, plus aliases/snapshots on its own page.
const urls=JSON.parse(await readFile(dir+'openai-urls.json','utf8'));
const oaListing=await read('openai-web');
for(const url of urls){
 const id=url.split('/').at(-1),raw=await read('openai-'+id),body=raw.replace(/L\d+:\s*/g,'');
 const context=body.match(/([\d,]+) context window/),output=body.match(/([\d,]+) max output tokens/);
 const status=oaListing.includes('†'+id+' Deprecated')||urls.indexOf(url)>=51?'deprecated':'active';
 const category=task(id),tools=/Function calling\s+Supported/.test(body)&&category==='对话';
 const aliases=body.split('Snapshots').slice(1).join('Snapshots').split('Rate limits')[0];
 const ids=new Set([id,...Array.from(aliases.matchAll(/(?:^|\n)\s*((?:gpt|o[134]|chatgpt|codex|text|omni|tts|whisper|babbage|davinci)[a-z0-9._-]+)\s*(?:\n|$)/g),m=>m[1])]);
 for(const modelId of ids)add('openai',{id:modelId,contextWindow:context?token(context[1]):undefined,maxOutputTokens:output?token(output[1]):undefined,category,tools,status,limitsUrl:url,...(/gpt-oss/.test(id)?{tools:false,unavailableReason:'开放权重型号，需自行部署或使用托管服务'}:{}),...(/pro$/.test(id)&&!/Streaming\s+Supported/.test(body)?{tools:false,unavailableReason:'官方未提供当前客户端需要的流式接口'}:{})});
}

// Claude: official lifecycle table is the authoritative list, with model-specific specs.
const life=await read('claude-life-web');
for(const m of life.matchAll(/\[Button: (claude-[\w-]+)\]\s*\|\s*(Active|Deprecated|Retired)/g)){
 const id=m[1],slug=id.replace(/^claude-/,'').replace(/-\d{8}$/,'');
 let html=await read('claude-'+slug).catch(()=>''),body=plain(html);
 // SSR can return a shell; retain the entry and make unverified capacities editable.
 const ctx=body.match(/(?:Context window|Context length)\s*(?:\([^)]*\))?\s*([\d,.]+\s*[MK]?)/i),out=body.match(/(?:Max output|Maximum output)\s*(?:tokens)?\s*([\d,.]+\s*[MK]?)/i);
 const latest=/fable-5-1|opus-5-5|sonnet-5-5/.test(id),haiku=/haiku-4-5/.test(id);
 add('anthropic',{id,status:m[2].toLowerCase(),contextWindow:latest?1000000:haiku?200000:ctx?token(ctx[1]):undefined,maxOutputTokens:latest?128000:haiku?64000:out?token(out[1]):undefined,limitsUrl:'https://platform.claude.com/docs/en/models/'+slug+'/overview',...(m[2]==='Retired'?{tools:false,unavailableReason:'官方已下线'}:{})});
 if(haiku)add('anthropic',{id:'claude-haiku-4-5',contextWindow:200000,maxOutputTokens:64000,limitsUrl:'https://platform.claude.com/docs/en/models/overview'});
}

// GLM overview tables: includes text, vision, free and specialist models.
const z=await read('zhipu');
for(const line of z.split('\n')){
 const m=line.match(/^\s*\| \[([^\]]+)\]\(([^)]+)\) \|/);if(!m)continue;
 const id=m[1].toLowerCase().replace(/ /g,'-'),cols=line.split('|').slice(1,-1),category=task(id);
 const spec=(await read('zhipu-'+m[2].split('/').at(-1)).catch(()=>''));
 const stated=Array.from(spec.matchAll(/(?:model["']?\s*[:=]\s*["']|"model"\s*:\s*")([a-zA-Z0-9._-]+)["']/g),m=>m[1]);
 const actual=stated.find(x=>x.toLowerCase()===id)||id,variants=/vidu/.test(id)?[...new Set(stated.filter(x=>x.startsWith('vidu')))]:[actual];
 for(const apiId of variants)add('zhipu',{id:apiId,name:variants.length>1?apiId:m[1],category,tools:category==='对话',contextWindow:cols[2]?token(cols[2]):undefined,maxOutputTokens:cols[3]?token(cols[3]):undefined,limitsUrl:'https://docs.bigmodel.cn'+m[2]});
}
for(const [id,category]of [['codegeex-4','代码补全'],['rerank','重排序']])add('zhipu',{id,category,tools:false,limitsUrl:'https://docs.bigmodel.cn/cn/guide/start/model-overview'});

// Kimi separates available models from the retired section.
const kimi=await read('kimi');
for(const m of kimi.split('## 已下线')[0].matchAll(/\| `([^`]+)` \|/g)){
 const k3=m[1]==='kimi-k3';add('moonshot',{id:m[1],contextWindow:k3?1048576:262144,maxOutputTokens:k3?1048576:undefined,limitsUrl:k3?'https://platform.kimi.com/docs/api/chat':'https://platform.kimi.com/docs/models',outputNote:k3?'官方最大生成长度；输入与输出共享上下文。':'官方模型目录未给出单次输出上限，请按账号文档填写。'});
}

// MiniMax OpenAI schema, plus specialist models from its model overview.
const mm=await read('minimax');
for(const m of mm.matchAll(/MiniMax-M[\d.]+(?:-[a-zA-Z]+)*|speech-[\d.]+-(?:hd|turbo)|music-[\d.]+(?:-large)?|music-cover|image-[\d]+/gi)){
 const id=/^music-/i.test(m[0])?m[0].toLowerCase():m[0],text=/MiniMax-M/.test(id),m3=/MiniMax-M3/.test(id),preview=/Preview/.test(id);
 add('minimax',{id,category:text?'对话':task(id),tools:text&&!preview,contextWindow:text?(m3?1000000:204800):undefined,maxOutputTokens:text?(m3?524288:id==='MiniMax-M2'?131072:204800):undefined,limitsUrl:text?'https://platform.minimax.io/docs/api-reference/text-chat-openai':'https://platform.minimax.io/docs/guides/models-intro',...(preview?{unavailableReason:'此型号仅面向 M Plan / MiniMax Code，当前预设为按量 API'}:{})});
}
for(const file of files.filter(f=>/^minimax-video-.*\.txt$/.test(f))){const spec=await read(file.slice(0,-4)),part=spec.split(/\n\s+model:\s*\n/)[1]?.split(/\n\s{6,8}\w+:/)[0]||'';for(const match of part.matchAll(/- ([\w.-]+)/g))add('minimax',{id:match[1],category:'视频生成',tools:false,limitsUrl:'https://platform.minimax.io/docs/api-reference/'+file.slice(8,-4)});}

// SiliconFlow's own public model page embeds the complete public catalogue.
const sf=nextPayload(await read('siliconflowSite')),sfModels=jsonAt(sf,sf.indexOf('"data":[')+7);
for(const m of sfModels){const category=m.subType==='embedding'?'向量':m.subType==='rerank'?'重排序':categories[m.type]||task(m.modelName);add('siliconflow',{id:m.modelName,name:m.DisplayName||m.modelName,category,tools:m.functionCallSupport===true&&m.type==='text',contextWindow:m.contextLen||undefined,limitsUrl:'https://siliconflow.cn/models',status:m.status==='normal'?'active':'deprecated',outputNote:'官方公开目录未标注单次输出上限，请按服务文档填写。'});}

// Alibaba: all IDs explicitly published in the overview and linked model pages.
const aliFiles=['dashscope','dashscopeText','dashscopeVision',...files.filter(f=>f.startsWith('aliyun-')&&f.endsWith('.txt')).map(f=>f.slice(0,-4))];
for(const file of aliFiles){
 const html=aliyunContent(await read(file)),source=file.startsWith('aliyun-')?'https://help.aliyun.com/zh/model-studio/'+file.slice(7):'https://help.aliyun.com/zh/model-studio/models';
 const names=new Set();
 for(const m of html.matchAll(/(?:model\/market\/detail\/|<code>)([\w./-]+)(?:["<]|<\/code>)/g))names.add(m[1]);
 if(file==='dashscopeText')for(const m of html.matchAll(/<a[^>]*>([^<]+)<\/a>/g)){const id=plain(m[1]);if(/^[\w]+[\w./-]*[-/][\w./-]+$/.test(id)&&!/^https|aliyun/.test(id))names.add(id);}
 for(const id of names){
  if(!/^(qwen|qwq|qvq|deepseek|glm|kimi|MiniMax|mimo|xiaomi|stepfun|ZHIPU|siliconflow|vanchin|unisound|wan|happy|Tripo|fun-|paraformer|sensevoice|cosyvoice|sambert|text-embedding|gte|multimodal|tongyi|farui|llama|baichuan|chatglm|bge|yi-|decision)/i.test(id)||/\/$/.test(id))continue;
  const category=task(id);add('dashscope',{id,category,tools:category==='对话',limitsUrl:source,outputNote:'不同地域、快照与思考模式可能有不同限制；未核实的参数可自行填写。'});
 }
 // Capacity rows are parsed only when the table explicitly names both fields.
 for(const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)){
  const rows=Array.from(table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g),m=>Array.from(m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g),c=>plain(c[1])));
  const header=rows.find(r=>r.some(x=>/上下文/.test(x))&&r.some(x=>/最大输出/.test(x)));if(!header)continue;
  const ci=header.findIndex(x=>/上下文/.test(x)),oi=header.findIndex(x=>/最大输出/.test(x));
  for(const row of rows){for(const id of names){if(!row[0]?.split(/\s+/).includes(id))continue;const ctx=token(row[ci]),out=token(row[oi]);if(ctx&&out)add('dashscope',{id,contextWindow:ctx,maxOutputTokens:out,limitsUrl:source});}}
 }
}

// Public gateway APIs preserve their own IDs, capacities and endpoint requirements.
const router=JSON.parse(await read('openrouter'));
for(const m of router.data){const text=m.architecture?.output_modalities?.includes('text'),tools=text&&m.supported_parameters?.includes('tools');add('openrouter',{id:m.id,name:m.name,category:text?'对话':task(m.id),tools:!!tools,contextWindow:m.context_length,maxOutputTokens:m.top_provider?.max_completion_tokens||undefined,limitsUrl:'https://openrouter.ai/api/v1/models',outputNote:'按 OpenRouter 路由目录；实际提供方可能有更低上限。'});}
const go=JSON.parse(await read('opencode'))['opencode-go'];
for(const m of Object.values(go.models)){
 const npm=m.provider?.npm||go.npm,protocol=npm.includes('anthropic')?'anthropic':npm==='@ai-sdk/openai'?'openai-responses':'openai-chat';
 add('opencode-go',{id:m.id,name:m.name,contextWindow:m.limit.context,maxOutputTokens:m.limit.output,tools:!!m.tool_call,category:'对话',status:m.status||'active',limitsUrl:'https://models.opencode.ai/api.json',...(protocol==='openai-chat'?{}:{provider:{protocol,baseUrl:protocol==='anthropic'?'https://opencode.ai/zen/go':'https://opencode.ai/zen/go/v1'}})});
}
const goat=JSON.parse(await read('goat'));
for(const m of goat.data){const endpoints=m.supported_endpoints||[],protocol=endpoints.includes('/messages')?'anthropic':endpoints.includes('/chat/completions')?'openai-chat':'openai-responses',supported=endpoints.some(e=>['/messages','/responses','/chat/completions'].includes(e));add('command-code-goat',{id:m.id,name:m.name,contextWindow:m.context_length,maxOutputTokens:supported?32768:undefined,limitsVerified:false,tools:supported,category:supported?'对话':'决策',limitsUrl:'https://api.commandcode.ai/provider/v1/models',outputNote:'官方目录未公开输出上限；先填官方 Pi 插件默认的 32,768，可调整。',...(protocol==='openai-chat'?{}:{provider:{protocol,baseUrl:protocol==='anthropic'?'https://api.commandcode.ai/provider':'https://api.commandcode.ai/provider/v1'}})});}

// DeepSeek exposes aliases as well as model IDs in its published API docs.
const ds=plain(await read('deepseek-details'));
for(const id of new Set(ds.match(/deepseek-(?:flash|v4[\w.-]*|chat|reasoner)/g)||[]))add('deepseek',{id,contextWindow:1048576,maxOutputTokens:393216,limitsUrl:'https://api-docs.deepseek.com/quick_start/pricing',...(!['deepseek-flash','deepseek-v4-pro'].includes(id)?{status:'deprecated',limitsVerified:false}:{} )});
// Existing documented aliases remain valid even when the pricing page shows only the family.
add('deepseek',{id:'deepseek-flash',name:'DeepSeek Flash',contextWindow:1048576,maxOutputTokens:393216,limitsUrl:'https://api-docs.deepseek.com/api/list-models/'});
add('deepseek',{id:'deepseek-v4-pro',name:'DeepSeek V4 Pro',contextWindow:1048576,maxOutputTokens:393216,limitsUrl:'https://api-docs.deepseek.com/api/list-models/'});

for(const list of Object.values(catalog.providers))list.sort((a,b)=>a.id.localeCompare(b.id));
await writeFile('desktop/model-catalog.json',JSON.stringify(catalog,null,2)+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(catalog.providers).map(([id,models])=>[id,{total:models.length,chat:models.filter(m=>m.tools).length,verified:models.filter(m=>m.limitsVerified).length}]))));
