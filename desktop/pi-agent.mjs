import { readFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createAgentSession, ModelRuntime, DefaultResourceLoader, SessionManager, SettingsManager, withFileMutationQueue } from './pi-runtime.mjs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { streamSimple as openAIChatStream } from '@earendil-works/pi-ai/api/openai-completions';
import { Workspace, SessionStore, trackedFileTools, shellTool, DEFAULT_SYSTEM } from '../dist/src/index.js';
import { ProjectFiles, projectListTool } from './project-files.mjs';
import { DESKTOP_RESPONSE_STYLE } from './response-style.mjs';
import { atomicJson } from './settings.mjs';
import { desktopProviderHeaders } from './provider-presets.mjs';
import { exportDesktopSession } from './session-export.mjs';
import {completePiPrompt,commandProvider} from './pi-completion.mjs';
import {copyPiBranch} from './session-transfer.mjs';
import {serializeSessionBranch,piModule,piBuiltinCommands} from './pi-native.mjs';
import {assistantPresentation,nativeTextPhase} from './ui/assistant-presentation.js';
import {ExtensionBridge} from './extension-bridge.mjs';
import {AnswerStage} from './answer-stage.mjs';
import {RunCoordinator} from './run-coordinator.mjs';
import {durableJson} from '../dist/src/durable-files.js';
import {redact} from './diagnostics.mjs';

const text = content => typeof content === 'string' ? content : (content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input:0, output:0, cacheRead:0, cacheWrite:0, total:0 } });
export function desktopMessage(m,phaseHint) {
  if (m.role === 'user') return { role:'user', text:text(m.content), timestamp:m.timestamp };
  if (m.role === 'toolResult') return { role:'tool', callId:m.toolCallId, name:m.toolName, text:text(m.content), isError:m.isError, timestamp:m.timestamp, ...(m.details !== undefined ? { details:m.details } : {}) };
  if (m.role === 'assistant') {
    const reasoning = m.content.flatMap((c,index) => c.type === 'thinking' && (c.thinking || c.redacted) ? [{index,text:c.redacted ? '' : c.thinking, ...(c.redacted ? {redacted:true} : {})}] : []);
    const presentation = assistantPresentation(text(m.content),['commentary','final_answer'].includes(phaseHint)?phaseHint:nativeTextPhase(m.content));
    // An interrupted unknown fragment never proved it was an answer. Preserve
    // it as process so settlement and history cannot expose it after stopping.
    if(presentation.phase === 'pending' && ['aborted','error'].includes(m.stopReason)) presentation.phase = 'commentary';
    return { role:'assistant', text:presentation.text, ...(presentation.phase !== 'pending' ? {phase:presentation.phase} : {}), ...(reasoning.length ? {reasoning} : {}), executionStatus:m.stopReason === 'length' ? 'limit' : m.stopReason === 'aborted' ? 'cancelled' : m.stopReason === 'error' ? 'failed' : 'completed', finishReason:m.rawStopReason || m.stopReason, toolCalls:m.content.filter(c => c.type === 'toolCall').map(c => ({ id:c.id, name:c.name, arguments:JSON.stringify(c.arguments) })), provider:m.provider, model:m.model, stopReason:m.stopReason === 'toolUse' ? 'tool_use' : m.stopReason === 'length' ? 'length' : 'stop', usage:{ input:m.usage.input, output:m.usage.output, cacheRead:m.usage.cacheRead || 0, cacheWrite:m.usage.cacheWrite || 0 }, timestamp:m.timestamp };
  }
  if (m.role === 'custom' && m.display) return {role:'assistant',text:text(m.content),toolCalls:[],provider:'extension',model:m.customType,stopReason:'stop',usage:{input:0,output:0},timestamp:m.timestamp || Date.now()};
}
function piMessage(m) {
  if (m.role === 'user') return { role:'user', content:m.text, timestamp:m.timestamp };
  if (m.role === 'tool') return { role:'toolResult', toolCallId:m.callId, toolName:m.name, content:[{ type:'text', text:m.text }], isError:m.isError, details:m.details, timestamp:m.timestamp };
  return { role:'assistant', content:[...(m.providerState?.protocol === 'openai-chat' ? [{type:'thinking',thinking:m.providerState.reasoningContent}] : (m.reasoning || []).filter(p => !p.redacted).map(p => ({type:'thinking',thinking:p.text}))),...(m.text ? [{type:'text',text:m.text}] : []), ...m.toolCalls.map(c => ({type:'toolCall',id:c.id,name:c.name,arguments:JSON.parse(c.arguments)}))], api:'openai-completions', provider:m.provider, model:m.model, usage:{...zeroUsage(),...m.usage}, stopReason:m.stopReason === 'tool_use' ? 'toolUse' : m.stopReason, timestamp:m.timestamp };
}
export function demoStream(provider) {
  return (model, context, options = {}) => {
    const stream = createAssistantMessageEventStream();
    const message = { role:'assistant', content:[], api:model.api, provider:model.provider, model:model.id, usage:zeroUsage(), stopReason:'stop', timestamp:Date.now() };
    void (async () => {
      try {
        stream.push({type:'start',partial:message});
        for await (const event of provider.stream({ model:{...model,maxOutputTokens:model.maxTokens}, system:getCurrentSystemPrompt(context.messages), messages:context.messages.map(desktopMessage).filter(Boolean), tools:getCurrentTools(context.messages), signal:options.signal || new AbortController().signal })) {
          if (event.type === 'text_delta' || event.type === 'thinking_delta') {
            const type = event.type === 'thinking_delta' ? 'thinking' : 'text';
            let index = message.content.findIndex(c => c.type === type);
            if (index < 0) { index = message.content.length; message.content.push({type,[type]:''}); stream.push({type:type+'_start',contentIndex:index,partial:message}); }
            message.content[index][type] += event.text; stream.push({type:type+'_delta',contentIndex:index,delta:event.text,partial:message});
          } else if (event.type === 'done') {
            const final = piMessage(event.message); final.api = model.api;
            stream.push({type:'done',reason:final.stopReason,message:final}); stream.end(final);
          }
        }
      } catch (error) { message.stopReason = options.signal?.aborted ? 'aborted' : 'error'; message.errorMessage = error.message; stream.push({type:'error',reason:message.stopReason,error:message}); stream.end(message); }
    })();
    return stream;
  };
}

/** Official Pi owns execution and context; the existing journal remains the desktop's presentation log. */
export class PiDesktopAgent {
  constructor(options, store) { this.options = options; this.store = store; this.listeners = new Set(); this.sequence = 0; this.pending = Promise.resolve(); this.mapping = {}; this.diagnostics = []; this.answerStage=new AnswerStage(this); }
  static async create(options, demoProvider) {
    const workspace = await Workspace.open(options.workspace);
    const store = options.resume ? await SessionStore.resume(options.resume) : await SessionStore.create(workspace.root);
    if (store.workspace !== workspace.root) { await store.close(); throw new Error('Session project does not match selected project'); }
    const host = new PiDesktopAgent(options, store); host.workspace = workspace;
    try { await host.initialize(demoProvider); return host; }
    catch (error) { host.session?.dispose(); await store.close(); throw error; }
  }
  async initialize(demoProvider) {
    const o = this.options;
    this.snapshotPath = resolve(this.workspace.root, '.agent/pi-state', `${this.store.id}.json`);
    for(const path of [resolve(this.workspace.root,'.agent'),dirname(this.snapshotPath),this.snapshotPath]) {
      const info = await lstat(path).catch(error => {if(error.code !== 'ENOENT') throw error; return null;});
      if(info?.isSymbolicLink() || (info && await realpath(path) !== path)) throw new Error('Pi 会话路径包含链接');
    }
    let saved;
    try { saved = JSON.parse(await readFile(this.snapshotPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved && (saved.workspace !== this.workspace.root || saved.id !== this.store.id)) throw new Error('Pi 会话不属于当前项目');
    this.manager = saved ? SessionManager.inMemory(this.workspace.root, {id:this.store.id}, [saved.header, ...saved.entries]) : SessionManager.inMemory(this.workspace.root, {id:this.store.id});
    if (saved) { this.mapping = saved.mapping; if (saved.leaf) this.manager.branch(saved.leaf); else this.manager.resetLeaf(); }
    else for (const entry of this.store.branch()) if (entry.data.kind === 'message') this.mapping[entry.id] = this.manager.appendMessage(piMessage(entry.data.message));
    const agentDir = o.agentDir; await mkdir(agentDir, {recursive:true});
    if(!o.hostCall) {this.coordinator=await RunCoordinator.open(this.workspace.root,this.store.id,randomUUID());await this.coordinator.initialize();}
    const runtime = await ModelRuntime.create({authPath:resolve(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});
    const streamSimple=runtime.streamSimple.bind(runtime);
    runtime.streamSimple=(model,context,options={})=>{
      const stream=createAssistantMessageEventStream(),requestId=randomUUID();
      void(async()=>{
        try {
          const run=await this.ensureRun();
          await this.runCall('run_model',{requestId,status:'started',provider:model.provider,model:model.id});
          for await(const event of streamSimple(model,context,options)) {
            if(event.type==='done'||event.type==='error') {
              const message=event.message||event.error;
              await this.runCall('run_model',{requestId,status:'finished',provider:model.provider,model:model.id,usage:message.usage});
            }
            stream.push(event);
          }
          stream.end();
        } catch(error) {
          const message={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:zeroUsage(),stopReason:options.signal?.aborted?'aborted':'error',errorMessage:error.message,timestamp:Date.now()};
          stream.push({type:'error',reason:message.stopReason,error:message});stream.end(message);
        }
      })();return stream;
    };
    for (const provider of o.config.providers) {
      const api = {'openai-chat':'openai-completions','openai-responses':'openai-responses','anthropic':'anthropic-messages'}[provider.protocol];
      runtime.registerProvider(provider.id, { baseUrl:provider.baseUrl, api, apiKey:provider.apiKeyEnv || 'local-no-key', headers:desktopProviderHeaders(provider,this.store.id),
        ...(api === 'openai-completions' ? {streamSimple:(model,context,options) => openAIChatStream(model,context,{...options,timeoutMs:provider.timeoutMs,onPayload:async (payload,m) => {
          const changed = await options?.onPayload?.(payload,m) || payload;
          const cap = changed.max_tokens ?? changed.max_completion_tokens;
          if(cap === 1 && m.maxTokens > 1) throw new Error('上下文剩余空间不足，无法生成完整输出。请减少上下文或切换到更大上下文的模型后继续。');
          if(provider.thinking) changed.thinking = {type:provider.thinking};
          return changed;
        }})} : {}),
        models:o.config.models.filter(m => m.provider === provider.id).map(m => ({id:m.id,name:m.id,reasoning:!!m.reasoningEffort,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:m.contextWindow,maxTokens:m.maxOutputTokens,
          ...(api === 'openai-completions' ? {compat:{supportsDeveloperRole:false,supportsStore:false,supportsUsageInStreaming:provider.streamUsage !== false,maxTokensField:provider.tokenLimitField || 'max_tokens'}} : {})})) });
      if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) await runtime.setRuntimeApiKey(provider.id, process.env[provider.apiKeyEnv]);
    }
    runtime.registerProvider('demo',{baseUrl:'https://offline.invalid',api:'openai-completions',apiKey:'offline',streamSimple:demoStream(demoProvider),models:[{id:'offline',name:'离线演示',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}]});
    this.runtime = runtime;
    // Pi reserves this room both for the response and its compaction summary.
    const compactionModels = [...o.config.models,{provider:'demo',id:'offline',contextWindow:32000}];
    const modelOverrides = Object.fromEntries(compactionModels.map(m => [`${m.provider}/${m.id}`,{reserveTokens:Math.min(16384,Math.floor(m.contextWindow / 4)),keepRecentTokens:Math.min(8000,Math.floor(m.contextWindow / 8))}]));
    const settings = SettingsManager.inMemory({compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:8000,modelOverrides},retry:{enabled:true,maxRetries:2},enableSkillCommands:true});
    const paths = o.resources || {extensions:[],skills:[],prompts:[],themes:[]};
    if(paths.projectTrusted===false)settings.setProjectTrusted(false);
    const baseNames = new Set(o.tools);
    this.bridge = new ExtensionBridge(event=>this.emit({...event,...(event.type==='extension_state'?{busy:this.busy}:{})}));
    const loader = new DefaultResourceLoader({cwd:this.workspace.root,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:paths.projectTrusted===false,
      eventBus:this.bridge.events,
      additionalExtensionPaths:paths.extensions,additionalSkillPaths:paths.skills,additionalPromptTemplatePaths:paths.prompts,additionalThemePaths:paths.themes,
      appendSystemPrompt:[DEFAULT_SYSTEM,DESKTOP_RESPONSE_STYLE],
      extensionFactories:[pi => {
        pi.on('before_agent_start',async event=>{await this.ensureRun();const context=await this.runCall('rollback_context',{branchIds:this.store.branch().map(e=>e.id)});if(context)return {systemPrompt:event.systemPrompt+'\n'+context};});
        pi.events.on('workbench:workflow-state',workflow=>{this.workflowState=workflow;if(this.runState)this.queuePersistence(()=>this.runCall('run_workflow',{workflow}));});
        pi.on('tool_call', async event => {
        const builtin = ['read','list','edit','write','shell','bash','powershell','grep','find','ls'];
        if ((builtin.includes(event.toolName) && !baseNames.has(event.toolName)) || (this.mode === 'plan' && !['read','list','submit_plan','plan_question','get_goal'].includes(event.toolName))) return {block:true,reason:'该工具超出当前桌面权限'};
        try {await this.ensureRun();await this.runCall('run_tool',{callId:event.toolCallId,name:event.toolName,status:'prepared'});}
        catch(error){this.persistenceError=error;return {block:true,reason:'工具未执行：'+error.message};}
      }); },pi=>this.answerStage.extension(pi)]
    });
    await loader.reload(); this.loader = loader;
    this.diagnostics.push(...loader.getExtensions().errors.map(e => ({type:'error',path:e.path,message:e.error})),...loader.getSkills().diagnostics,...loader.getPrompts().diagnostics,...loader.getThemes().diagnostics);
    const extensionTools = loader.getExtensions().extensions.flatMap(e => [...e.tools.keys()]);
    const names = [...o.tools, ...extensionTools.filter(n => !baseNames.has(n))];
    const shellExecutor=o.hostCall?async(args,context)=>{
      const params={...args,runId:this.runState?.id,sessionId:this.store.id,workspace:this.workspace.root,callId:context.callId};
      const abort=()=>{void o.hostCall('command_cancel',params).catch(()=>{});};
      context.signal.addEventListener('abort',abort,{once:true});
      try {context.signal.throwIfAborted();return await o.hostCall('command_execute',params,context.update);}
      finally{context.signal.removeEventListener('abort',abort);}
    }:undefined;
    const all = [...trackedFileTools(this.workspace,this.store,{maxBackupBytes:o.checkpointLimits?.maxFileBytes}),shellTool(shellExecutor),projectListTool(new ProjectFiles(this.workspace))];
    const customTools = all.map(tool => ({name:tool.name,label:tool.name,description:tool.description,parameters:tool.parameters,
      execute:async (callId,args,signal,onUpdate) => {
        const execute = async () => {
        if (!baseNames.has(tool.name)) throw new Error('该工具超出当前桌面权限');
        const checkpointPath=['write','edit'].includes(tool.name)?await this.runCall('checkpoint_before',{path:args.path,callId}):undefined;
        let result;
        const skillRoots = paths.skills.map(p => dirname(p));
        const selectedReference = tool.name === 'read' && typeof args.path === 'string' && skillRoots.some(root => this.inside(root,resolve(this.workspace.root,args.path)));
        if (selectedReference) {
          // Explicit skill directories are readable for references. Other external paths remain inaccessible.
          const canonical = await realpath(args.path);
          const roots = await Promise.all(skillRoots.map(root => realpath(root)));
          if (!roots.some(root => this.inside(root,canonical))) throw new Error('读取路径超出项目和已启用 skill');
          const source = await readFile(canonical); if (source.length > 128*1024 || source.includes(0)) throw new Error('skill 参考文件过大或为二进制');
          const lines = source.toString('utf8').split('\n'), offset = args.offset || 1, limit = args.limit || 200;
          result = {text:lines.slice(offset-1,offset-1+limit).map((line,i) => `${offset+i}: ${line}`).join('\n')+`\n[${lines.length} lines total]`};
        } else { let partialText = ''; result = await tool.execute(args,{workspace:this.workspace.root,signal:signal || new AbortController().signal,callId,update:delta => {partialText += delta; onUpdate?.({content:[{type:'text',text:partialText}],details:{}});}}); }
        if(checkpointPath)await this.runCall('checkpoint_after',{path:checkpointPath,callId});
        if (result.change) { await this.store.append({kind:'file_change',change:result.change}); this.emit({type:'file_change',change:result.change}); }
        if (result.isError) throw new Error(result.text);
        return {content:[{type:'text',text:result.text}],details:result.details};
        };
        return ['write','edit'].includes(tool.name) ? withFileMutationQueue(resolve(this.workspace.root,args.path),execute) : execute();
      }
    }));
    const [provider,id] = o.modelKey.split(/\/(.*)/s); const model = runtime.getModel(provider,id); if (!model) throw new Error('Pi 找不到所选模型');
    const {session} = await createAgentSession({cwd:this.workspace.root,agentDir,modelRuntime:runtime,model,thinkingLevel:o.thinkingLevel || 'off',resourceLoader:loader,sessionManager:this.manager,settingsManager:settings,tools:names,customTools});
    this.session = session;
    session.setScopedModels((o.scopedModels || []).flatMap(key=>{const [p,id]=key.split(/\/(.*)/s),m=runtime.getModel(p,id);return m ? [{model:m,thinkingLevel:session.thinkingLevel}] : [];}));
    session.subscribe(event => this.handle(event));
    this.autocompleteWrappers=[];
    const ui = this.bridge.ui({autocomplete:factory=>{this.autocompleteWrappers.push(factory);this.completionProvider=undefined;},setEditorText:text=>this.emit({type:'extension_editor_text',text:String(text)})});
    await session.bindExtensions({mode:'rpc',uiContext:ui,onError:error => {this.extensionError = error.error; this.diagnostics.push({type:'error',path:error.extensionPath,message:error.error}); this.bridge.events.emit('workbench:error',{message:error.error}); this.emit({type:'extension_notice',message:error.error,level:'error'});}});
    this.bridge.events.emit('workbench:host-policy',{mode:this.mode});
    await this.store.append({kind:'model',model:this.model});
    await this.save();
    this.restoredRuns=await this.runRecords();
  }
  inside(root,path) { const rel = relative(root,path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..'+sep); }
  get model() { const m = this.session.model; return {provider:m.provider,id:m.id,tools:true,contextWindow:m.contextWindow,maxOutputTokens:m.maxTokens}; }
  get mode() { return this.bridge?.cards.get('plan')?.mode || this.options.mode || 'build'; }
  get busy() { return !!this.active || !!this.runState || !!this.compacting || !!this.bridge?.dialogs.size || this.session.isStreaming || this.session.isCompacting; }
  get commands() {
    return [
      ...this.session.extensionRunner.getRegisteredCommands().filter(c=>!piBuiltinCommands.some(b=>b.name===c.name)).map(c => ({command:'/'+c.invocationName,description:c.description || c.name,source:'extension'})),
      ...this.loader.getSkills().skills.map(s => ({command:'/skill:'+s.name,description:s.description,source:'skill'})),
      ...this.session.promptTemplates.map(p => ({command:'/'+p.name,description:p.description,source:'prompt'})),
    ];
  }
  sessionInfo() { return {...this.session.getSessionStats(),sessionId:this.store.id,sessionFile:this.store.path,model:`${this.model.provider}/${this.model.id}`,tools:this.session.getActiveToolNames(),lastAssistantText:this.session.getLastAssistantText() || ''}; }
  complete(input) {
    this.completionAbort?.abort();this.completionAbort=new AbortController();
    this.completionProvider ||= commandProvider({workspace:this.workspace.root,session:this.session,models:[...this.options.config.models.map(m=>({...m,key:`${m.provider}/${m.id}`})),{key:'demo/offline',id:'offline',provider:'demo'}],providers:this.options.config.providers,scopedModels:this.session.scopedModels.map(s=>`${s.model.provider}/${s.model.id}`),wrappers:this.autocompleteWrappers});
    return completePiPrompt(input,{provider:this.completionProvider},this.completionAbort.signal);
  }
  async setThinking(level) {
    if(this.busy) throw new Error('请先停止当前任务，再调整思考强度');
    if(!this.session.getAvailableThinkingLevels().includes(level)) throw new Error('当前模型可用的思考强度：'+this.session.getAvailableThinkingLevels().join('、'));
    this.session.setThinkingLevel(level);this.completionProvider=undefined;await this.save();return this.session.thinkingLevel;
  }
  copySession(input) {return copyPiBranch(this,input,desktopMessage);}
  async exportJsonl(path) {if(this.busy)throw new Error('请先停止当前任务，再导出会话');const {writeFile}=await import('node:fs/promises');await writeFile(path,serializeSessionBranch(this.manager),'utf8');return path;}
  async bugBundle({hint='',includeSession=false,includeSummary=false}={}) {
    const {collectBugReportMetadata,collectBugReportDiagnostics}=await piModule('core/bug-report.js');
    const bundle={metadata:collectBugReportMetadata({hint,sessionId:this.store.id,cwd:this.workspace.root,includeSession,includeSummary,messageCount:this.session.messages.length,model:this.session.model,modelRuntime:this.runtime,thinkingLevel:this.session.thinkingLevel,extensions:this.loader.getExtensions().extensions,extensionErrors:this.loader.getExtensions().errors,globalSettings:this.session.settingsManager.getGlobalSettings(),projectSettings:this.session.settingsManager.getProjectSettings()}),diagnostics:collectBugReportDiagnostics(this.manager)};
    if(includeSession)bundle.sessionJsonl=serializeSessionBranch(this.manager);
    if(includeSummary)bundle.summary=await this.session.summarizeForBugReport({hint,signal:new AbortController().signal});
    return JSON.parse(redact(bundle,Object.entries(process.env).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([,value])=>value)));
  }
  exportHtml(path) {return exportDesktopSession(this,path);}
  async compact(instructions='') {
    if(this.busy) throw new Error('请先停止当前任务，再压缩上下文');
    if(typeof instructions!=='string' || Buffer.byteLength(instructions)>16384) throw new Error('压缩说明最多 16 KiB');
    this.compacting=true;
    try {const result=await this.session.compact(instructions.trim() || undefined);await this.pending;await this.save();return {tokensBefore:result.tokensBefore,tokensAfter:result.estimatedTokensAfter};}
    catch(error) {if(/Nothing to compact|session too small|No messages to compact/i.test(error.message)) throw new Error('当前会话内容较少，无需压缩');throw error;}
    finally {this.compacting=false;}
  }
  get lastResult() {
    if(this.lastSettledResult)return this.lastSettledResult;
    if(this.recovery?.run)return {status:'interrupted',error:'上次任务已中断，可检查后继续。'};
    const entries = this.store.branch();
    const last = entries.findLast(e => e.data.kind === 'run_result' || (e.data.kind === 'message' && ['user','assistant'].includes(e.data.message.role)));
    if(last?.data.kind === 'run_result') return {...last.data.result,assistantEntryId:last.data.assistantEntryId};
    if(last?.data.kind === 'message' && last.data.message.role === 'assistant') {const m = last.data.message;return {status:m.stopReason === 'length' ? 'limit' : m.executionStatus || (m.toolCalls.length ? 'failed' : 'completed'),turns:0};}
  }
  get recovery() {const ids=new Set(this.store.branch().map(e=>e.id));const run=this.restoredRuns?.find(r=>r.status==='interrupted'&&!r.recoveredBy&&(r.branchStart===null||ids.has(r.branchStart)));return run?{run,uncertain:Object.entries(run.tools).filter(([,v])=>v.status==='uncertain').map(([id,v])=>({id,...v}))}:null;}
  get state() { return {sessionId:this.store.id,workspace:this.store.workspace,model:this.model,mode:this.mode,extensionUI:this.bridge.state,busy:this.busy,lastResult:this.busy ? undefined : this.lastResult,recovery:this.recovery,workerGeneration:this.options.workerGeneration||this.coordinator?.generation,tools:this.session.getActiveToolNames(),commands:this.commands,thinkingLevel:this.session.thinkingLevel,thinkingLevels:this.session.getAvailableThinkingLevels(),scopedModels:this.session.scopedModels.map(s=>`${s.model.provider}/${s.model.id}`),queued:{steering:[...this.session.getSteeringMessages()],followUp:[...this.session.getFollowUpMessages()]},usage:this.store.usage(),leaf:this.store.leaf,engine:'pi',resourceDiagnostics:this.diagnostics,loadedExtensions:this.loader.getExtensions().extensions.map(e => e.path)}; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(data) {
    const event = {...data,sessionId:this.store.id,runId:this.runState?.id,workerGeneration:this.options.workerGeneration||this.coordinator?.generation,sequence:++this.sequence,timestamp:Date.now()};
    if(['text_delta','assistant_phase'].includes(data.type)&&data.messageId) {
      const partial=this.partials?.get(data.messageId)||{messageId:data.messageId,text:'',phase:'pending'};
      partial.text=(partial.text+(data.text||'')).slice(-256*1024);partial.phase=data.phase||partial.phase;
      (this.partials ||= new Map()).set(data.messageId,partial);
      if(!this.partialTimer){this.partialTimer=setTimeout(()=>{this.partialTimer=undefined;void this.flushPartial().catch(()=>{});},1000);this.partialTimer.unref?.();}
    }
    for(const fn of this.listeners) fn(event);
  }
  queuePersistence(operation) {this.runPending=(this.runPending||Promise.resolve()).then(operation);this.runPending.catch(error=>{this.persistenceError=error;});return this.runPending;}
  async runCall(method,data={}) {
    const params={...data,runId:this.runState?.id,sessionId:this.store.id,workspace:this.workspace.root};
    if(!params.runId&&method!=='run_list')throw new Error('No durable run');
    return this.options.hostCall?this.options.hostCall(method,params):this.coordinator.handle(method,params);
  }
  async ensureRun() {const run=this.startRun();await run.ready;if(this.persistenceError)throw this.persistenceError;return run;}
  async runRecords() {return this.options.hostCall?this.options.hostCall('run_list',{sessionId:this.store.id,workspace:this.workspace.root}):this.coordinator.store.list();}
  async recoverRun({runId,confirmedUncertain=false}) {
    if(this.busy)throw new Error('请先停止当前任务');
    this.restoredRuns=await this.runRecords();const recovery=this.recovery;
    if(!recovery||recovery.run.runId!==runId)throw new Error('找不到当前分支可恢复的任务');
    if(recovery.uncertain.length&&!confirmedUncertain)throw new Error('请先核实待确认工具与命令的实际结果');
    const previous=recovery.run,workflow=previous.workflow;
    if(workflow?.data&&previous.metrics.usageUnconfirmed)throw new Error('目标存在未确认用量，请先核实预算，再通过 /goal 恢复');
    if(workflow?.data&&(workflow.data.tokensUsed>=workflow.data.tokenBudget||workflow.data.rounds>=workflow.data.maxTurns))throw new Error('目标预算或轮数已耗尽');
    const branch=this.manager.getBranch();let safe=null,unresolved=new Set();
    for(const entry of branch) {
      if(entry.type==='message'&&entry.message.role==='assistant')for(const item of entry.message.content||[])if(item.type==='toolCall')unresolved.add(item.id);
      if(entry.type==='message'&&entry.message.role==='toolResult')unresolved.delete(entry.message.toolCallId);
      if(!unresolved.size)safe=entry.id;
    }
    if(unresolved.size) {
      const desktop=Object.entries(this.mapping).find(([,id])=>id===safe)?.[0];
      if(safe)this.manager.branch(safe);else this.manager.resetLeaf();
      const marker=this.manager.appendCustomEntry('desktop-recovery',{parentRunId:runId,uncertain:[...unresolved]});
      await this.session.navigateTree(marker,{summarize:false});if(desktop)await this.store.select(desktop);
    }
    if(workflow?.data){const goal={...workflow.data,status:'paused',reason:'上次执行已中断，保留已知预算后恢复。'};this.manager.appendCustomEntry(workflow.type,goal);await this.session.extensionRunner.emit({type:'session_tree'});}
    await this.save();this.lastSettledResult=undefined;this.nextParentRunId=runId;this.nextRunOrigin='recovery';
    const run=this.startRun();await run.ready;await this.runCall('run_recovered',{parentRunId:runId});this.restoredRuns=await this.runRecords();
    const confirmed=Object.entries(previous.tools).filter(([,v])=>v.status==='finished').map(([id,v])=>v.name+' ('+id+')');
    const prompt='上次任务中断。已确认完成的工具：'+(confirmed.join('、')||'无')+'。不要重放这些工具调用；先读取当前文件并核实未确认副作用，再继续未完成工作。'+(recovery.uncertain.length?'用户已核实待确认工具和残留命令，请根据当前文件继续。':'');
    if(workflow?.data){await this.session.sendCustomMessage({customType:'desktop-recovery',content:prompt,display:false},{triggerTurn:false});await this.command('/goal resume');return run.done;}
    return this.runPrepared(run,prompt);
  }
  async flushPartial() {if(this.runState&&!this.runState.finalizing&&this.partials?.size)await this.runCall('run_partial',{partial:{version:1,sequence:this.sequence,messages:[...this.partials.values()].slice(-8),timestamp:Date.now()}});}
  handle(event) {
    if(event.type === 'agent_start') this.startRun();
    if(event.type === 'agent_settled') void this.finishRun();
    if(event.type === 'message_start' && event.message.role === 'assistant') {this.activeMessageId = randomUUID();this.answerStage.start(event.message);}
    if(event.type === 'message_start' && event.message.role === 'assistant') this.emit({type:'assistant_start',messageId:this.activeMessageId,provider:event.message.provider,model:event.message.model});
    if(event.type === 'message_update') {
      const part = event.assistantMessageEvent;
      if(part.type === 'text_delta') this.emit({type:'text_delta',messageId:this.activeMessageId,text:part.delta,phase:this.answerStage.delta(part)});
      // A provider can announce a tool after streaming its introductory text.
      // Reclassify that message as process immediately, before tool execution.
      if(part.type === 'toolcall_start') this.emit({type:'assistant_progress',messageId:this.activeMessageId});
      if(['thinking_start','thinking_delta','thinking_end'].includes(part.type)) {
        const redacted = !!part.partial.content[part.contentIndex]?.redacted;
        this.emit({type:part.type,messageId:this.activeMessageId,index:part.contentIndex,text:redacted ? '' : part.delta ?? part.content ?? '',redacted});
      }
    }
    if(event.type === 'tool_execution_start') this.emit({type:'tool_start',call:{id:event.toolCallId,name:event.toolName,arguments:JSON.stringify(event.args)}});
    if(event.type === 'tool_execution_update') this.emit({type:'tool_update',callId:event.toolCallId,text:text(event.partialResult.content),replace:true});
    if(event.type === 'tool_execution_end') this.emit({type:'tool_end',call:{id:event.toolCallId,name:event.toolName,arguments:'{}'},result:{role:'tool',callId:event.toolCallId,name:event.toolName,text:text(event.result.content),isError:event.isError,details:event.result.details,timestamp:Date.now()}});
    if(event.type === 'queue_update') this.emit({type:'queue_changed',steering:event.steering.length,followUp:event.followUp.length});
    if(event.type === 'turn_start') {this.turns = (this.turns || 0)+1; this.emit({type:'turn_start',turn:this.turns,model:this.model});}
    if(event.type === 'compaction_start') this.emit({type:'compaction_start',reason:event.reason});
    if(event.type === 'compaction_end') {
      this.compactionError = event.errorMessage;
      this.emit({type:'compaction_end',success:!!event.result,willRetry:event.willRetry,aborted:event.aborted,...(event.errorMessage ? {error:'上下文整理未完成，请减少上下文后继续。'} : {})});
    }
    if(event.type === 'auto_retry_start') this.emit({type:'retry_start',attempt:event.attempt});
    if(event.type === 'message_end') {
      this.answerStage.end(event.message);
      const message = desktopMessage(event.message,this.answerStage.phase(event.message));
      const messageId = event.message.role === 'assistant' ? this.activeMessageId : undefined;
      if(event.message.role === 'assistant') {this.lastAssistant = event.message;this.lastAssistantId = messageId;}
      if (message) this.pending = this.pending.then(async () => {
        const entry = await this.store.append({kind:'message',message});
        if(messageId) this.lastAssistantEntryId = entry.id;
        const native = this.manager.getEntries().findLast(e => (e.type === 'message' && e.message === event.message) || (e.type === 'custom_message' && e.customType === event.message.customType && text(e.content) === text(event.message.content)));
        if(native) this.mapping[entry.id] = native.id;
        this.emit({type:'message',entryId:entry.id,messageId,message}); await this.save();
        if(message.role==='tool')await this.runCall('run_tool',{callId:message.callId,name:message.name,status:'finished',entryId:entry.id,isError:message.isError});
        if(messageId)this.partials?.delete(messageId);
      });
      this.pending.catch(error=>{this.persistenceError=error;});
    }
  }
  save() {
    const operation=(this.snapshotQueue || Promise.resolve()).then(async()=>{await mkdir(dirname(this.snapshotPath),{recursive:true});await durableJson(this.snapshotPath,{version:1,id:this.store.id,workspace:this.store.workspace,header:this.manager.getHeader(),entries:this.manager.getEntries(),leaf:this.manager.getLeafId(),mapping:this.mapping});});
    this.snapshotQueue=operation.catch(()=>{});return operation;
  }
  startRun() {
    if(this.runState && !this.runState.finalizing)return this.runState;
    this.answerStage.reset();this.turns=0;this.cancelled=false;this.extensionError=undefined;this.compactionError=undefined;this.persistenceError=undefined;this.lastAssistant=undefined;this.lastAssistantId=undefined;this.lastAssistantEntryId=undefined;this.runPending=Promise.resolve();this.partials=new Map();
    const run={id:randomUUID()};run.done=new Promise(resolve=>run.resolve=resolve);this.runState=run;
    run.ready=this.runCall('run_begin',{branchStart:this.store.leaf,origin:this.nextRunOrigin||'user',parentRunId:this.nextParentRunId,provider:this.model.provider,model:this.model.id,mode:this.mode,toolsEnabled:this.options.tools,checkpointLimits:this.options.checkpointLimits,observeFiles:this.options.tools.includes('shell')||(this.options.resources?.extensions||[]).some(p=>!p.replaceAll('\\','/').includes('/pi-workflows/'))});
    this.nextRunOrigin=undefined;this.nextParentRunId=undefined;
    run.ready.catch(error=>{this.persistenceError=error;});
    this.emit({type:'run_start',runId:run.id});return run;
  }
  async finishRun(thrown) {
    const run=this.runState;if(!run || run.finalizing)return run?.done;run.finalizing=true;
    const last=this.lastAssistant,messageId=this.lastAssistantId,cancelled=this.cancelled,turns=this.turns;
    const goal=this.bridge.cards.get('goal'),workflowStopped=goal && ['paused','blocked','budget_limited','turn_limited'].includes(goal.status),goalLimit=goal && ['budget_limited','turn_limited'].includes(goal.status);
    const finalMessage=last?desktopMessage(last,this.answerStage.phase(last)):undefined;
    const emptyFinal=finalMessage && (finalMessage.phase==='final_answer' || this.answerStage.phase(last)==='final_answer') && !finalMessage.text.trim() && !finalMessage.toolCalls.length;
    const error=thrown?.message || this.extensionError || last?.errorMessage || (workflowStopped?undefined:last?.stopReason==='length'?'输出达到长度限制，内容尚未完成。请减少上下文或切换模型后继续。':this.compactionError && last?.stopReason!=='stop'?'上下文整理失败，任务尚未完成。':last?.stopReason==='toolUse'?'工具执行已结束，但模型未返回最终回答。':emptyFinal?'模型未返回最终回答内容。':finalMessage?.phase==='commentary'?'模型只返回了执行过程，尚未生成最终回答。':undefined);
    let result={status:cancelled?'cancelled':goalLimit?'limit':last?.stopReason==='aborted'?'cancelled':last?.stopReason==='length'?'limit':error || last?.stopReason==='error'?'failed':'completed',text:finalMessage?.text || '',turns,...(error?{error}:{})};
    let entryId;
    try {await run.ready;await this.runPending;await this.pending;if(this.persistenceError)throw this.persistenceError;await this.save();await this.runCall('checkpoint_finalize');entryId=this.lastAssistantEntryId;const {text:answer,...summary}=result;const entry=await this.store.append({kind:'run_result',runId:run.id,assistantEntryId:entryId || null,result:summary});await this.runCall('run_finish',{result:summary,entryId:entry.id,branchEnd:this.store.leaf});}
    catch(error){result={...result,status:'failed',error:'会话结果保存失败：'+error.message};await this.runCall('run_finish',{result:{status:'failed',error:result.error,turns},branchEnd:this.store.leaf}).catch(()=>{});}
    clearTimeout(this.partialTimer);this.partialTimer=undefined;
    this.lastSettledResult=result;this.emit({type:'run_end',result,messageId,entryId});
    if(this.runState===run)this.runState=undefined;
    run.resolve(result);return result;
  }
  isExtensionCommand(prompt) {return this.commands.some(c=>c.source==='extension' && c.command===prompt.trim().split(/\s/,1)[0]);}
  async command(prompt) {
    if(!this.isExtensionCommand(prompt))throw new Error('找不到已启用的扩展指令');
    const previousError=this.extensionError;
    await this.session.prompt(prompt.trim().replace(/^(\/[^\s]+)\s*/, '$1 '));await this.pending;await this.save();return this.extensionError && this.extensionError!==previousError?{status:'failed',error:this.extensionError}:{accepted:true,status:'completed'};
  }
  async run(prompt) {
    if(this.isExtensionCommand(prompt))return this.command(prompt);
    if(this.busy)throw new Error('Agent is busy');const run=this.startRun();try{await run.ready;}catch(error){await this.finishRun(error);return run.done;}
    return this.runPrepared(run,prompt);
  }
  async runPrepared(run,prompt) {
    this.active=(async()=>{try{await this.session.prompt(prompt);}catch(error){await this.finishRun(error);}finally{await this.finishRun();}return run.done;})();
    try{return await this.active;}finally{this.active=undefined;}
  }
  async abort() {this.cancelled=true;this.bridge.events.emit('workbench:stop');this.bridge.cancel();await this.session.abort();if(this.runState)await this.runState.done;if(this.active)await this.active;}
  async steer(prompt) {if(this.isExtensionCommand(prompt))await this.command(prompt);else await this.session.prompt(prompt,{streamingBehavior:'steer'});}
  async followUp(prompt) {if(this.isExtensionCommand(prompt))await this.command(prompt);else await this.session.prompt(prompt,{streamingBehavior:'followUp'});}
  clearQueues() { this.session.clearQueue(); }
  async setModel(key) { if(this.busy) throw new Error('Agent is busy'); const [p,id] = key.split(/\/(.*)/s); const model = this.runtime.getModel(p,id); if(!model) throw new Error('找不到模型'); await this.session.setModel(model);this.completionProvider=undefined; await this.store.append({kind:'model',model:this.model}); await this.save(); }
  async branch(entryId) {
    this.lastSettledResult=undefined;
    if(this.busy) throw new Error('Agent is busy'); const native = this.mapping[entryId]; if(!native) throw new Error('此节点尚未导入 Pi，重新打开会话后重试');
    // Pi's UI navigation re-edits user nodes by selecting their parent. The desktop keeps the selected user message.
    const previous = this.manager.getLeafId(); this.manager.branch(native);
    const marker = this.manager.appendCustomEntry('desktop-branch',{from:native});
    if(previous) this.manager.branch(previous); else this.manager.resetLeaf();
    const navigation = await this.session.navigateTree(marker,{summarize:false});
    if(navigation.cancelled) {if(previous) this.manager.branch(previous); else this.manager.resetLeaf(); throw new Error('扩展取消了历史分支操作');}
    await this.store.select(entryId); await this.save();
  }
  async close() { if(this.busy) await this.abort(); clearTimeout(this.partialTimer);try {await this.pending;await this.session.extensionRunner.emit({type:'session_shutdown',reason:'quit'}); await this.save();} finally {this.bridge.dispose();this.session.dispose(); await this.store.close();} }
}
