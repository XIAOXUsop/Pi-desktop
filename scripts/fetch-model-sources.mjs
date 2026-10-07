import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const folder=resolve('.agent/verification/model-catalog-sources');await mkdir(folder,{recursive:true});
const sources={
  deepseek:'https://api-docs.deepseek.com/api/list-models/',
  zhipu:'https://docs.bigmodel.cn/cn/guide/start/model-overview.md',
  kimi:'https://platform.kimi.com/docs/models.md',
  kimiChat:'https://platform.kimi.com/docs/api/chat.md',
  minimax:'https://platform.minimax.io/docs/guides/models-intro.md',
  minimaxChat:'https://platform.minimax.io/docs/api-reference/text-chat-openai.md',
  openai:'https://developers.openai.com/api/docs/models/all.md',
  anthropic:'https://platform.claude.com/docs/en/models/overview',
  anthropicLifecycle:'https://platform.claude.com/docs/en/about-claude/model-deprecations',
  dashscope:'https://help.aliyun.com/zh/model-studio/models',
  siliconflow:'https://api.siliconflow.cn/v1/models',
  siliconflowDocs:'https://docs.siliconflow.cn/cn/userguide/introduction.md',
  siliconflowSite:'https://siliconflow.cn/models',
  openrouter:'https://openrouter.ai/api/v1/models',
  opencode:'https://models.opencode.ai/api.json',
  goat:'https://api.commandcode.ai/provider/v1/models',
  deepseekPricing:'https://api-docs.deepseek.com/quick_start/pricing-details',
  kimiCode:'https://platform.kimi.com/docs/guide/kimi-k2.7-code.md',
  kimiK26:'https://platform.kimi.com/docs/guide/kimi-k2.6.md',
  minimaxAnthropic:'https://platform.minimax.io/docs/api-reference/text-anthropic-api.md',
  siliconflowIndex:'https://docs.siliconflow.cn/llms.txt',
  dashscopeText:'https://help.aliyun.com/zh/model-studio/model-list-text-generation/',
  dashscopeVision:'https://help.aliyun.com/zh/model-studio/vision-model',
};
if(process.argv[2])for(const id of Object.keys(sources))if(!process.argv[2].split(',').includes(id))delete sources[id];
const report=await Promise.all(Object.entries(sources).map(async([id,url])=>{
  try {
    const r=await fetch(url,{signal:AbortSignal.timeout(30000)}),body=await r.text();
    await writeFile(resolve(folder,id+'.txt'),body);
    return{id,url,status:r.status,bytes:Buffer.byteLength(body),type:r.headers.get('content-type')};
  }catch(e){return{id,url,error:e.message};}
}));
await writeFile(resolve(folder,'manifest.json'),JSON.stringify({retrievedAt:new Date().toISOString(),sources:report},null,2));
for(const item of report)console.log(JSON.stringify(item));
