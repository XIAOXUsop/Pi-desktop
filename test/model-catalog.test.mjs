import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {providerPresets,presetModelProvider,officialModelLimits,providerName} from '../desktop/provider-presets.mjs';
import {SettingsStore} from '../desktop/settings.mjs';

async function fixture(t){const folder=await mkdtemp(resolve(tmpdir(),'model-directory-'));t.after(()=>rm(folder,{recursive:true,force:true}));const path=resolve(folder,'defaults.json');await writeFile(path,JSON.stringify({defaultModel:'fixture/model',providers:[{id:'fixture',protocol:'openai-chat',baseUrl:'https://fixture.invalid/v1'}],models:[{id:'model',provider:'fixture',contextWindow:8192,maxOutputTokens:1024,tools:true}]}));const vault={available:async()=>true,encrypt:async text=>Buffer.from(text),decrypt:async bytes=>bytes.toString()};return new SettingsStore(folder,path,vault).load();}
const preset=id=>providerPresets().find(p=>p.id===id);

test('full directory preserves exact public IDs, snapshots and distinct gateway identities',()=>{
 const expected={openai:['gpt-6.1-sol','gpt-6-astra','gpt-4.1-2025-04-14','text-embedding-3-large'],anthropic:['claude-opus-5-5','claude-fable-5-1','claude-sonnet-4-6','claude-haiku-4-5-20251001'],zhipu:['glm-5.3-flashx','glm-4.7-flash','glm-4.5-air','viduq1-text','vidu2-reference'],moonshot:['kimi-k3','kimi-k2.7-code','kimi-k2.7-code-highspeed','kimi-k2.6'],minimax:['MiniMax-M3','MiniMax-M2.7-highspeed','speech-2.8-hd'],dashscope:['qwen3.8-max','qwen3-coder-plus','qwen-plus'],siliconflow:['Pro/moonshotai/Kimi-K2.6','deepseek-ai/DeepSeek-V4-Flash'],openrouter:['deepseek/deepseek-v4-flash'],'opencode-go':['qwen3.8-max','gpt-6-luna','minimax-m3'],'command-code-goat':['claude-sonnet-5-5','gpt-6.1-sol','moonshotai/Kimi-K3']};
 for(const [id,models]of Object.entries(expected))for(const modelId of models)assert(preset(id).models.some(m=>m.id===modelId),id+': '+modelId);
 for(const p of providerPresets()){assert.equal(new Set(p.models.map(m=>m.id)).size,p.models.length);for(const m of p.models){assert(m.id.length<=200);assert.equal(new URL(m.limitsUrl).protocol,'https:');if(m.limitsVerified!==false){assert(Number.isInteger(m.contextWindow));assert(m.maxOutputTokens>0&&m.maxOutputTokens<=m.contextWindow);}}}
 const copy=providerPresets();copy[0].models[0].id='mutated';assert.notEqual(providerPresets()[0].models[0].id,'mutated');
});

test('Go and GOAT choose native Messages or Responses without changing the existing chat provider',async t=>{
 const settings=await fixture(t);
 for(const [id,modelId,protocol,baseUrl]of [['opencode-go','minimax-m3','anthropic','https://opencode.ai/zen/go'],['opencode-go','gpt-6-luna','openai-responses','https://opencode.ai/zen/go/v1'],['command-code-goat','claude-sonnet-5-5','anthropic','https://api.commandcode.ai/provider']]){
  const p=preset(id),m=p.models.find(m=>m.id===modelId),template=presetModelProvider(p,m);
  const selected=await settings.addPreset({presetId:id,modelId,key:'directory-fixture',persist:false});
  assert.equal(selected,template.id+'/'+modelId);const configured=settings.config.providers.find(p=>p.id===template.id);
  assert.equal(configured.protocol,protocol);assert.equal(configured.baseUrl,baseUrl);assert.equal(configured.apiKeyEnv,p.provider.apiKeyEnv);assert.equal(providerName(configured),p.name);
  if(id==='opencode-go')assert.equal(officialModelLimits(configured,modelId).contextWindow,m.contextWindow);
 }
 await settings.addPreset({presetId:'opencode-go',modelId:'kimi-k3'});
 assert.equal(settings.config.providers.find(p=>p.id==='opencode-go').protocol,'openai-chat');
 assert.equal(settings.config.providers.find(p=>p.id==='opencode-go-messages').protocol,'anthropic');
 const restored=await new SettingsStore(settings.folder,resolve(settings.folder,'defaults.json'),settings.vault).load();assert.equal(restored.config.providers.find(p=>p.id==='opencode-go-responses').protocol,'openai-responses');
});

test('specialist and retired entries cannot modify settings or accept credentials',async t=>{
 const settings=await fixture(t),before=JSON.stringify(settings.config);
 for(const [presetId,modelId]of [['openai','text-embedding-3-large'],['zhipu','viduq1-text'],['anthropic','claude-3-haiku-20240307'],['minimax','MiniMax-M3.1-Flash-Preview']])await assert.rejects(settings.addPreset({presetId,modelId,key:'must-not-save',persist:true}));
 assert.equal(JSON.stringify(settings.config),before);assert.equal(settings.data.selectedModel,null);assert.deepEqual(settings.keys,{});await assert.rejects(readFile(resolve(settings.folder,'keys.json')),e=>e.code==='ENOENT');
});

test('unpublished capacities require explicit values and remain editable after restart',async t=>{
 const settings=await fixture(t),p=preset('siliconflow'),id='Pro/moonshotai/Kimi-K2.6';assert.equal(p.models.find(m=>m.id===id).maxOutputTokens,undefined);
 await assert.rejects(settings.addPreset({presetId:p.id,modelId:id}));
 const key=await settings.addPreset({presetId:p.id,modelId:id,maxOutputTokens:16384});assert.equal(officialModelLimits(p.provider,id),undefined);
 await settings.updateModelLimits({key,contextWindow:262144,maxOutputTokens:32768});
 const restored=await new SettingsStore(settings.folder,resolve(settings.folder,'defaults.json'),settings.vault).load();assert.equal(restored.config.models.find(m=>m.provider===p.id).maxOutputTokens,32768);
});

test('alternate protocol custom endpoints use isolated credentials and keep official limits editable',async t=>{
 const settings=await fixture(t);await settings.addPreset({presetId:'command-code-goat',modelId:'claude-sonnet-5-5',providerId:'private-claude',baseUrl:'https://example.invalid/provider',contextWindow:200000,maxOutputTokens:4096,key:'isolated-fixture'});
 const p=settings.config.providers.find(p=>p.id==='private-claude');assert.equal(p.protocol,'anthropic');assert.equal(p.apiKeyEnv,'LOCAL_AGENT_PRIVATE_CLAUDE_KEY');assert.equal(settings.keys.CMD_API_KEY,undefined);assert.equal(officialModelLimits(p,'claude-sonnet-5-5'),undefined);
});
