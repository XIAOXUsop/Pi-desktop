import { startup } from './startup.mjs';
import { app, BrowserWindow, ipcMain, dialog, protocol, safeStorage, utilityProcess, clipboard, shell } from 'electron';
import { readFile, mkdir, readdir, stat, lstat, realpath, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore } from './settings.mjs';
import { WorkerClient } from './worker-client.mjs';
import { ProjectFiles, CONTEXT_FILE_LIMITS } from './project-files.mjs';
import { deleteSessionFiles } from './session-files.mjs';
import { listProjectSessions, selectProjectSession } from './project-sessions.mjs';
import { providerPresets, providerName, officialModelLimits } from './provider-presets.mjs';
import { ResourceMarket } from './resource-market.mjs';
import {randomUUID} from 'node:crypto';
import {Diagnostics,redact} from './diagnostics.mjs';
const resourceMarket = new ResourceMarket();
let piBuiltinCommands=[];
startup.mark('imports-ready');

const directory = dirname(fileURLToPath(import.meta.url)); const project = resolve(directory, '..');
const reliabilitySmoke=process.argv.includes('--reliability-smoke');
const liveSmoke = process.argv.includes('--live-smoke');
const navigationBenchmark = process.argv.includes('--navigation-benchmark');
const packageCheck = process.argv.includes('--package-check');
const startupBenchmark = process.argv.includes('--startup-benchmark');
const demo = reliabilitySmoke || packageCheck || liveSmoke || navigationBenchmark || process.argv.includes('--smoke') || process.argv.includes('--demo');
const smoke = reliabilitySmoke || startupBenchmark || packageCheck || liveSmoke || navigationBenchmark || process.argv.includes('--smoke');
const ENTRY = 'local-agent://app/index.html';
protocol.registerSchemesAsPrivileged([{ scheme: 'local-agent', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if(reliabilitySmoke || packageCheck || startupBenchmark){const folder=process.argv[process.argv.indexOf('--test-profile')+1];if(!folder||!isAbsolute(folder))throw new Error('Verification requires an absolute test profile');app.setPath('userData',folder);}
else if (!app.isPackaged) app.setPath('userData', resolve(project, '.agent', smoke ? `desktop-smoke-profile/run-${Date.now()}` : 'desktop-profile'));
else app.setPath('userData',resolve(app.getPath('appData'),'Pi-desktop'));
if(!smoke){if(!app.requestSingleInstanceLock())app.quit();app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});}
let window; let settings; let resources; let worker; let workerOpening; let current; let lastResult; let changing = false; let shuttingDown = false; let initialization;
let diagnostics;let coordinator;let coordinatorOpening;let workerContext;let commandSupervisor;
let recoveringWorker;
let restoreError;
let restoreFailure;
async function ensureRecoveryWorker() {
  if(recoveringWorker)return recoveringWorker;
  if(worker)return;
  const selected=current;
  recoveringWorker=exclusive(()=>openProject(selected.workspace,selected.sessionPath,{force:true})).finally(()=>{recoveringWorker=undefined;});
  return recoveringWorker;
}
async function hostRequest(client, method, params, update) {
  if(worker!==client||!workerContext||params.workspace!==workerContext.workspace)throw new Error('执行进程或项目已切换');
  if(!coordinator||coordinator.store.sessionId!==params.sessionId) {
    coordinatorOpening ||= (async()=>{const {RunCoordinator}=await import('./run-coordinator.mjs');const value=await RunCoordinator.open(params.workspace,params.sessionId,client.generation,diagnostics);await value.initialize();return value;})();
    coordinator=await coordinatorOpening;coordinatorOpening=undefined;
  }
  if(worker!==client||coordinator.store.sessionId!==params.sessionId)throw new Error('会话已切换');
  if(workerContext.sessionId&&params.sessionId!==workerContext.sessionId)throw new Error('会话不匹配');
  if(method==='command_execute'||method==='command_cancel') {
    const record=await coordinator.store.get(params.runId);
    if(record.workerGeneration!==client.generation)throw new Error('命令所属执行进程已失效');
    if(!commandSupervisor){const {CommandSupervisor}=await import('./command-supervisor.mjs');commandSupervisor=new CommandSupervisor();}
    if(worker!==client||!workerContext||params.workspace!==workerContext.workspace)throw new Error('执行进程已切换');
    if(method==='command_cancel')return commandSupervisor.cancel({...params,generation:client.generation});
    if(coordinator.active!==params.runId||!settings.data.permissions.shell||record.mode==='plan'||record.tools[params.callId]?.name!=='shell')throw new Error('该命令超出当前任务权限');
    return commandSupervisor.execute({...params,generation:client.generation},update);
  }
  return coordinator.handle(method,params);
}
const navigationPerformance = {workerStarts:0,switches:[]};
function tools() { return ['list', 'read', ...(settings.data.permissions.write ? ['write', 'edit'] : []), ...(settings.data.permissions.shell ? ['shell'] : [])]; }
function modelKey() { return settings.data.selectedModel ?? settings.config.defaultModel; }
function notify(message) { if (window && !window.isDestroyed()) window.webContents.send('agent:notification', message); }
async function sessions() { return listProjectSessions(current?.workspace, settings, current?.sessionPath); }
async function state() {
  if (workerOpening) await workerOpening;
  const [agent,sessionList]=await Promise.all([worker ? worker.request('state') : null,sessions()]);
  return { project: current?.workspace ?? null, projectName: current?.workspace ? basename(current.workspace) : null,
    models: [...settings.config.models.map(model => ({ ...model, key: `${model.provider}/${model.id}`, officialLimits:officialModelLimits(settings.config.providers.find(p => p.id === model.provider),model.id) })), { provider: 'demo', id: 'offline', key: 'demo/offline', tools: true }], attachmentLimits: CONTEXT_FILE_LIMITS, checkpointLimits:settings.data.checkpoints,
    piCommands:piBuiltinCommands,scopedModels:settings.data.scopedModels || [],thinkingLevel:settings.data.thinkingLevel || 'off',providers: settings.config.providers.map(provider => ({ id: provider.id, name: providerName(provider), protocol: provider.protocol, baseUrl: provider.baseUrl })), presets: providerPresets(), keyStatus: settings.keyStatus(),
    selectedModel: agent ? `${agent.model.provider}/${agent.model.id}` : modelKey(), permissions: settings.data.permissions, mode: agent?.mode || settings.data.mode, preferences: settings.data.preferences,
    recentProjects: settings.data.recentProjects, sessions: sessionList, agent, lastResult:lastResult || agent?.lastResult, keyLoadError: settings.keyLoadError,restoreError,
    ...(smoke ? {verification:{workerStarts:navigationPerformance.workerStarts,switches:[...navigationPerformance.switches]}} : {}) };
}
async function idle() { if (worker && (await worker.request('state'))?.busy) throw new Error('请先停止当前任务，再切换项目、模型设置或权限'); }
async function exclusive(operation) {
  if (changing) throw new Error('正在切换会话，请稍候'); changing = true;
  try { await idle(); return await operation(); } finally { changing = false; }
}
async function stopWorker() { const old = worker;if(old){await commandSupervisor?.cancel({generation:old.generation});try{await old.close();}finally{if(worker===old)worker=undefined;await coordinator?.interrupt();}} }
async function openProject(path, resume, {createNew = false, force = false} = {}) {
  const started = performance.now();
  try { return await openProjectImpl(path,resume,{createNew,force}); }
  finally { if (smoke) navigationPerformance.switches.push({milliseconds:performance.now()-started,createNew,force}); }
}
async function openProjectImpl(path, resume, {createNew = false, force = false} = {}) {
  const canonical = await realpath(path); if (!(await stat(canonical)).isDirectory()) throw new Error('请选择项目文件夹');
  resume = await selectProjectSession(canonical, settings, {resume,createNew});
  if (!force && !createNew && current?.workspace === canonical && current?.sessionPath === resume && (worker || !resume)) return state();
  if(force) await stopWorker(); lastResult = null;
  if (!resume && !createNew) {
    if(worker) await worker.request('release');
    current = {workspace:canonical};
    await rememberProject();restoreError=undefined; return state();
  }
  let client=worker;
  if(!client) {
    const child = utilityProcess.fork(resolve(directory, 'worker.mjs'), [], { cwd: canonical, env: settings.workerEnvironment(), stdio: 'pipe', serviceName: 'Pi-desktop Worker' });
    navigationPerformance.workerStarts++;
    const generation=randomUUID();diagnostics ||= new Diagnostics(resolve(app.getPath('userData'),'logs'),{secrets:Object.values(settings.keys||{})});
    client = new WorkerClient(child,{generation,diagnostics,hostRequest:(method,params,update)=>hostRequest(client,method,params,update)}); worker = client;
    client.on('notification', message => {
    if (worker !== client) return;
    if (message.type === 'event' && message.event.type === 'run_start') lastResult = null;
    if (message.type === 'event' && message.event.type === 'run_end') lastResult = message.event.result;
    notify(message);
  });
    client.on('stopped', code => { if (worker === client && !shuttingDown&&!client.closing) {const owner=coordinator;worker=undefined;void(async()=>{await commandSupervisor?.cancel({generation:client.generation});await owner?.interrupt();notify({type:'worker_stopped',code});})().catch(()=>notify({type:'worker_stopped',code}));void diagnostics?.event('worker_exit',{generation:client.generation,exitCode:code});} });
  }
  try {
    coordinator=undefined;coordinatorOpening=undefined;workerContext={workspace:canonical};
    workerOpening = (async () => client.request('open', { workspace: canonical, resume, workerGeneration:client.generation,reliabilityFixtures:reliabilitySmoke||packageCheck, checkpointLimits:settings.data.checkpoints, restoreModel:!!resume && !force, config: settings.config, modelKey: modelKey(), tools: tools(), mode: settings.data.mode, agentDir: resources.folder, thinkingLevel:settings.data.thinkingLevel,scopedModels:settings.data.scopedModels,resources:await resources.runtime(canonical) }))();
    current = await workerOpening; workerOpening = undefined;
    workerContext.sessionId=current.sessionId;
    notify({type:'worker_ready',sessionId:current.sessionId,workspace:canonical,generation:client.generation});
    if(!coordinator){const {RunCoordinator}=await import('./run-coordinator.mjs');coordinator=await RunCoordinator.open(canonical,current.sessionId,client.generation,diagnostics);await coordinator.initialize();}
    if(resume && !force) settings.data.selectedModel=`${current.model.provider}/${current.model.id}`;
    await rememberProject();
    restoreError=undefined;
    return await state();
  } catch (error) { workerOpening = undefined; await stopWorker(); current = undefined; throw error; }
}
async function rememberProject() {
  const path = current.workspace;
  settings.data.recentProjects = [path, ...settings.data.recentProjects.filter(item => item !== path)].slice(0,12);
  settings.data.lastProject = path;
  if (current.sessionId) { settings.data.projectSessions[path] = current.sessionId; settings.data.lastSession = current.sessionPath; }
  else { delete settings.data.projectSessions[path]; delete settings.data.lastSession; }
  await settings.save();
}
async function reloadWorker() { if (current?.sessionPath) await openProject(current.workspace, current.sessionPath, {force:true}); else await stopWorker(); }
let hostModule;
async function checkpointHost(){const {checkpointActions}=await import('./checkpoint-actions.mjs');return checkpointActions({current:()=>current,worker:()=>worker,coordinator:()=>coordinator,settings,exclusive,reloadWorker,state});}
async function commandHost() {
  const {piHostActions}=await (hostModule ??= import('./pi-host-actions.mjs'));
  return piHostActions({settings,resources,worker:()=>worker,current:()=>current,window:()=>window,dialog,app,state,exclusive,openProject,reloadWorker,desktopDiagnostics:()=>actions.exportDiagnostics({preview:true})});
}
async function knownProject(path=current?.workspace) {
  if(typeof path!=='string' || !settings.data.recentProjects.includes(path)) throw new Error('请通过打开项目选择文件夹');
  const canonical=await realpath(path);if(!(await stat(canonical)).isDirectory()) throw new Error('项目文件夹不可用');return canonical;
}
const actions = {
  state,
  ...Object.fromEntries(['listCheckpoints','previewRollback','applyRollback','inverseRollback','resumeRollback','pinCheckpoint','setCheckpointLimits'].map(method=>[method,async input=>(await checkpointHost())[method](input)])),
  async startupReady({phase}={}) { if(!['renderer-state','renderer-history','renderer-ready'].includes(phase))throw new Error('Invalid startup stage');startup.mark(phase);return null; },
  async extensionCommand({prompt}) {if(changing || !worker || typeof prompt!=='string' || prompt.length>256*1024)throw new Error('请选择有效扩展指令');return worker.request('command',{prompt});},
  async extensionResponse(input) {if(!worker || changing)throw new Error('会话已切换');return worker.request('extension_response',input);},
  completePrompt:async input=>(await commandHost()).completePrompt(input),
  piAction:async input=>(await commandHost()).piAction(input),
  async listProjectSessions({path}={}) {const workspace=await knownProject(path);return {path:workspace,sessions:await listProjectSessions(workspace,settings,current?.workspace===workspace?current.sessionPath:undefined)};},
  async searchResourceMarket(input) { return resourceMarket.search(input); },
  async resourceMarketDetail(input) { return resourceMarket.detail(input); },
  async createResource(input) { return exclusive(async () => {await resources.create(input,current?.workspace);await reloadWorker();return actions.listResources();}); },
  async listResources() { if(workerOpening) await workerOpening; const list = await resources.list(current?.workspace); if(workerOpening) await workerOpening; const runtime = worker ? await worker.request('state') : null; return {...list,items:list.items.map(item => ({...item,loadState:item.type === 'extensions' && item.enabled ? runtime?.loadedExtensions.includes(item.path) ? 'loaded' : runtime ? 'error' : 'pending' : undefined})),diagnostics:[...list.diagnostics,...(runtime?.resourceDiagnostics || [])]}; },
  async previewResource(input) { return resources.preview(input, current?.workspace); },
  async addResource(input) { return exclusive(async () => { await resources.add(input,current?.workspace); await reloadWorker(); return actions.listResources(); }); },
  async chooseResource({kind,scope}) { return exclusive(async () => {
    if(!['directory','extension'].includes(kind)) throw new Error('无效资源类型');
    const selected = await dialog.showOpenDialog(window,{title:kind === 'directory' ? '选择 skill 或 Pi 包目录' : '选择 Pi 扩展文件',properties:[kind === 'directory' ? 'openDirectory' : 'openFile'],...(kind === 'extension' ? {filters:[{name:'Pi 扩展',extensions:['ts','js','mjs','cjs']}]} : {})});
    if(!selected.canceled) {await resources.add({source:selected.filePaths[0],scope},current?.workspace); await reloadWorker();}
    return actions.listResources();
  }); },
  async toggleResource(input) { return exclusive(async () => {await resources.toggle(input,current?.workspace); await reloadWorker(); return actions.listResources();}); },
  async removeResource(input) { return exclusive(async () => {await resources.remove(input,current?.workspace); await reloadWorker(); return actions.listResources();}); },
  async reloadResources() { return exclusive(async () => {await reloadWorker(); return actions.listResources();}); },
  async sessionInfo() {if(workerOpening) await workerOpening;if(!worker || !current?.sessionId) throw new Error('请先选择或新建会话');return worker.request('session_info');},
  async compactSession({instructions=''}={}) {return exclusive(async()=>{if(!worker || !current?.sessionId) throw new Error('请先选择会话');const result=await worker.request('compact',{instructions},600000);return {result,state:await state()};});},
  exportSession:async input=>(await commandHost()).exportSession(input),
  async copyText({ text }) { if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) throw new Error('复制内容过大'); await clipboard.writeText(text); return true; },
  async openLink({ url }) { if (typeof url !== 'string' || url.length > 4096) throw new Error('无效链接'); const target = new URL(url); if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('只打开网页链接'); await shell.openExternal(target.href); return true; },
  async chooseProject() {
    return exclusive(async () => { const result = await dialog.showOpenDialog(window, { title: '选择本地项目', properties: ['openDirectory'] });
      return result.canceled ? await state() : await openProject(result.filePaths[0]); });
  },
  async openRecent({ path }) {
    if (!settings.data.recentProjects.includes(path)) throw new Error('请通过打开项目选择文件夹'); return exclusive(() => openProject(path));
  },
  async newSession() { if (!current) throw new Error('请先打开项目'); return exclusive(() => openProject(current.workspace, undefined, {createNew:true})); },
  async resume({ id, path }) { return exclusive(async () => {
    const workspace=await knownProject(path);
    if (!(await listProjectSessions(workspace,settings)).some(session => session.id === id)) throw new Error('找不到这个项目的会话');
    return openProject(workspace, resolve(workspace, '.agent/sessions', id + '.jsonl'));
  }); },
  async setModel({ key }) { return exclusive(async () => {
    if (key !== 'demo/offline' && !settings.config.models.some(model => `${model.provider}/${model.id}` === key)) throw new Error('请选择已配置的模型');
    if (worker && current?.sessionId) await worker.request('set_model', { key }); settings.data.selectedModel = key; await settings.save(); return state();
  }); },
  async setPermissions({ write, shell }) { return exclusive(async () => {
    if ((await state()).mode === 'plan') throw new Error('规划模式只读取文件，请先切换到执行模式');
    if (typeof write !== 'boolean' || typeof shell !== 'boolean') throw new Error('Invalid permissions');
    settings.data.permissions = { write, shell }; await settings.save(); await reloadWorker(); return state();
  }); },
  async setMode({ mode }) { return exclusive(async () => { if (!['build', 'plan'].includes(mode)) throw new Error('无效工作模式');const runtime=worker?await worker.request('state'):null;settings.data.mode=mode;await settings.save();if(runtime?.commands.some(c=>c.source==='extension' && c.command==='/plan'))await worker.request('set_mode',{mode});else await reloadWorker();return state(); }); },
  async updateSession({ id, patch, path }) { return exclusive(async () => { const workspace=await knownProject(path);if (!(await listProjectSessions(workspace,settings)).some(session => session.id === id)) throw new Error('找不到会话'); await settings.updateSession(workspace, id, patch);if(patch.title && current?.workspace===workspace && current.sessionId===id && worker)await worker.request('set_name',{name:patch.title}); if (patch.archived === true && current?.workspace===workspace && current.sessionId === id) await openProject(workspace); return state(); }); },
  async deleteSession({ id, path }) { return exclusive(async () => {
    const workspace=await knownProject(path);
    if (!(await listProjectSessions(workspace,settings)).some(session => session.id === id)) throw new Error('找不到会话');
    const sessionPath = current?.sessionPath; const active = current?.workspace===workspace && current.sessionId === id;
    if (active) await stopWorker();
    try { await deleteSessionFiles(workspace, id); }
    catch (error) { if (active) await openProject(workspace, await stat(sessionPath).then(() => sessionPath, () => undefined)); throw error; }
    try { await settings.removeSession(workspace, id); }
    finally { if (active) await openProject(workspace); }
    return state();
  }); },
  async setPreferences(patch) { return settings.setPreferences(patch); },
  async listFiles({ path = '' } = {}) { if (!current) throw new Error('请先打开项目'); return (await ProjectFiles.open(current.workspace)).list(path); },
  async readFile({ path }) { if (!current) throw new Error('请先打开项目'); return (await ProjectFiles.open(current.workspace)).read(path); },
  async run({ prompt, files = [] }) { if (changing || !worker) throw new Error('请先打开项目'); if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 256 * 1024) throw new Error('请输入有效任务（最多 256 KiB）'); const client = worker; const runtime=await client.request('state');if(piBuiltinCommands.some(c=>c.command===prompt.trim().split(/\s/,1)[0]))throw new Error('请通过聊天输入框执行 Pi 内置指令');const extension=runtime.commands.some(c=>c.source==='extension' && c.command===prompt.trim().split(/\s/,1)[0]);const text=extension ? prompt : await (await ProjectFiles.open(current.workspace)).prompt(prompt, files, runtime.model); if (client !== worker || changing) throw new Error('项目已切换，请重新发送'); return client.request('run', { prompt: text }); },
  async steer({ prompt, files = [] }) { if (changing || !worker || typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 256 * 1024) throw new Error('请输入插话内容'); const client = worker; const runtime=await client.request('state');if(piBuiltinCommands.some(c=>c.command===prompt.trim().split(/\s/,1)[0]))throw new Error('请通过聊天输入框执行 Pi 内置指令');const extension=runtime.commands.some(c=>c.source==='extension' && c.command===prompt.trim().split(/\s/,1)[0]);const text=extension ? prompt : await (await ProjectFiles.open(current.workspace)).prompt(prompt, files, runtime.model); if (client !== worker || changing) throw new Error('项目已切换，请重新发送'); return client.request('steer', { prompt: text }); },
  async followUp({ prompt, files = [] }) { if (changing || !worker || typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 256 * 1024) throw new Error('请输入后续任务'); const client = worker; const runtime=await client.request('state');if(piBuiltinCommands.some(c=>c.command===prompt.trim().split(/\s/,1)[0]))throw new Error('请通过聊天输入框执行 Pi 内置指令');const extension=runtime.commands.some(c=>c.source==='extension' && c.command===prompt.trim().split(/\s/,1)[0]);const text=extension ? prompt : await (await ProjectFiles.open(current.workspace)).prompt(prompt, files, runtime.model); if (client !== worker || changing) throw new Error('项目已切换，请重新发送'); return client.request('follow_up', { prompt: text }); },
  async abort() { if (worker) {await commandSupervisor?.cancel({generation:worker.generation});await worker.request('abort', {}, 150000);}return state(); },
  async listRuns() {return coordinator?coordinator.store.list():[];},
  async getRecoveryState() {
    if(!current?.sessionId)return null;
    await ensureRecoveryWorker();
    return worker.request('recovery');
  },
  async recoverRun(input) {
    if(changing||!current?.sessionId||typeof input.runId!=='string'||typeof input.confirmedUncertain!=='boolean')throw new Error('请选择可恢复的任务');
    await ensureRecoveryWorker();
    const recovery=await worker.request('recovery');
    if(recovery?.run.runId!==input.runId)throw new Error('任务或分支已切换');
    if(recovery.uncertain.length&&!input.confirmedUncertain)throw new Error('请先核实待确认工具和命令');
    return worker.request('recover',input);
  },
  async exportDiagnostics({includeRuntime=false,preview=true}={}) {
    if(typeof includeRuntime!=='boolean'||typeof preview!=='boolean')throw new Error('无效诊断选项');
    diagnostics ||= new Diagnostics(resolve(app.getPath('userData'),'logs'),{secrets:Object.values(settings.keys||{})});
    const bundle=await diagnostics.bundle({version:app.getVersion(),runs:coordinator?(await coordinator.store.list()).map(r=>({runId:r.runId,status:r.status,metrics:r.metrics,error:r.error})):[]},{includeRuntime});
    if(preview)return bundle;
    const choice=await dialog.showSaveDialog(window,{title:'保存诊断',defaultPath:'Pi-desktop-diagnostics.json',filters:[{name:'诊断',extensions:['json']}]});
    if(choice.canceled)return {cancelled:true};await writeFile(choice.filePath,JSON.stringify(bundle,null,2),{mode:0o600});return {saved:true};
  },
  async history() { return worker && current?.sessionId ? worker.request('history') : { entries: [], activeEntryIds: [] }; },
  async changes() { return worker && current?.sessionId ? worker.request('changes') : []; },
  async branch({ entryId }) { return exclusive(async () => { if (!worker || typeof entryId !== 'string') throw new Error('无效历史节点'); await worker.request('branch', { entryId }); return state(); }); },
  async saveKey({ providerId, key, persist }) { return exclusive(async () => { await settings.setKey(providerId, key, persist === true); await reloadWorker(); return state(); }); },
  async addModel(input) { return exclusive(async () => { await settings.addModel(input); await reloadWorker(); return state(); }); },
  async addPreset(input) { return exclusive(async () => { await settings.addPreset(input); await reloadWorker(); return state(); }); },
  async updateModelLimits(input) { return exclusive(async () => {await settings.updateModelLimits(input);await reloadWorker();return state();}); },
  async importConfig() { return exclusive(async () => {
    const result = await dialog.showOpenDialog(window, { title: '导入模型配置', properties: ['openFile'], filters: [{ name: '模型配置', extensions: ['json'] }] });
    if (!result.canceled) { const info = await stat(result.filePaths[0]); if (info.size > 1024 * 1024) throw new Error('配置文件超过 1 MiB');
      await settings.saveConfig(JSON.parse(await readFile(result.filePaths[0], 'utf8'))); settings.data.selectedModel = settings.config.defaultModel;
      for (const provider of settings.config.providers) if (provider.apiKeyEnv && !settings.keys[provider.apiKeyEnv]) { const { persistentKey } = await import('./settings.mjs'); settings.keys[provider.apiKeyEnv] = await persistentKey(provider.apiKeyEnv); }
      await settings.save(); await reloadWorker();
    } return state();
  }); },
};
app.whenReady().then(async () => {
  startup.mark('electron-ready');
  protocol.handle('local-agent', async request => {
    const url = new URL(request.url); const allowed = { '/index.html': 'text/html', '/styles.css': 'text/css', '/renderer.js': 'text/javascript', '/extension-ui.js':'text/javascript', '/pi-commands.js':'text/javascript', '/prompt-completion.js':'text/javascript', '/project-navigation.js':'text/javascript', '/execution-ui.js': 'text/javascript', '/assistant-presentation.js': 'text/javascript', '/resources-ui.js': 'text/javascript', '/message-actions.js': 'text/javascript', '/icons.js': 'text/javascript', '/markdown.js': 'text/javascript', '/rollback-ui.js':'text/javascript','/recovery-ui.js':'text/javascript','/reliability.css':'text/css','/review.js': 'text/javascript', '/marked.js': 'text/javascript' };
    allowed['/provider-avatar.js']='text/javascript';allowed['/provider-logos.svg']='image/svg+xml';allowed['/app-mark.svg']='image/svg+xml';
    if (url.hostname !== 'app' || !Object.hasOwn(allowed, url.pathname)) return new Response('Not found', { status: 404 });
    const asset = url.pathname === '/marked.js' ? resolve(project, 'node_modules/marked/lib/marked.esm.js') : resolve(directory, 'ui', url.pathname.slice(1));
    return new Response(await readFile(asset), { headers: { 'Content-Type': `${allowed[url.pathname]}; charset=utf-8`,
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'" } });
  });
  const vault = {
    available: async () => safeStorage.isAsyncEncryptionAvailable ? safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable(),
    encrypt: async value => safeStorage.encryptStringAsync ? safeStorage.encryptStringAsync(value) : safeStorage.encryptString(value),
    decrypt: async value => safeStorage.decryptStringAsync ? (await safeStorage.decryptStringAsync(value)).result : safeStorage.decryptString(value),
  };
  // Paint the local window while credentials and the Pi session initialize.
  // IPC operations wait for that initialization, so an early click cannot
  // change the project while its saved session is still being restored.
  window = new BrowserWindow({ width: 1450, height: 930, minWidth: 1050, minHeight: 700, show: false, backgroundColor: '#f5f7fa', title: 'Pi-desktop', icon:resolve(project,'build/app.ico'),
    webPreferences: { preload: resolve(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !smoke } });
  startup.mark('window-created');
  window.once('ready-to-show',()=>{startup.mark('window-paint-ready');if(!smoke && !shuttingDown){window.show();window.focus();}});
  window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== ENTRY) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  ipcMain.handle('agent:invoke', async (event, method, params = {}) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== ENTRY) throw new Error('Invalid IPC sender');
    if (!Object.hasOwn(actions, method)) throw new Error('Unknown application action');
    try { if(method!=='startupReady')await initialization;return { ok: true, result: await actions[method](params) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : '操作失败' }; }
  });
  window.on('close', event => { if (!shuttingDown && worker) { event.preventDefault(); shuttingDown = true; void stopWorker().finally(() => app.quit()); } });
  initialization=(async()=>{
    const [loaded,[{ResourceManager},{piBuiltinCommands:commands}]]=await Promise.all([
      new SettingsStore(app.getPath('userData'), resolve(project, 'configs/deepseek.json'), vault,stage=>startup.mark(stage)).load().then(value=>{startup.mark('settings-ready');return value;}),
      Promise.all([import('./resources.mjs'),import('./pi-native.mjs')]).then(value=>{startup.mark('pi-core-ready');return value;}),
    ]);
    settings=loaded;piBuiltinCommands=commands;
    resources = await new ResourceManager(app.getPath('userData')).load();
    await resources.installBundledWorkflows(app.isPackaged ? resolve(process.resourcesPath,'pi-workflows') : resolve(project,'packages/pi-workflows'));
    startup.mark('resources-ready');
    if (demo) {
      const folder = resolve(app.isPackaged ? app.getPath('userData') : project, '.agent/desktop-demo'); await mkdir(folder, { recursive: true });
      const fixture = await mkdtemp(resolve(folder, 'project-')); await writeFile(resolve(fixture, 'hello.txt'), 'Hello, world!\r\n');
      if (liveSmoke) {
        await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test greeting.test.mjs' } }, null, 2));
        await writeFile(resolve(fixture, 'greeting.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\ntest('greeting is updated', async () => assert.equal(await readFile('hello.txt', 'utf8'), 'Hello, coding agent!\\r\\n'));\n");
      }
      settings.data.selectedModel = liveSmoke ? settings.config.defaultModel : 'demo/offline'; settings.data.permissions = { write: true, shell: liveSmoke }; await openProject(fixture, undefined, {createNew:true});
    } else if (settings.data.lastProject) {
      try {
        const remembered=settings.data.projectSessions[settings.data.lastProject] || (settings.data.lastSession&&basename(settings.data.lastSession,'.jsonl'));
        const path=remembered&&!settings.sessionMeta(settings.data.lastProject,remembered).archived?resolve(settings.data.lastProject,'.agent/sessions',remembered+'.jsonl'):undefined;
        const resume=path?await lstat(path).then(()=>path,error=>{if(error.code==='ENOENT')return undefined;throw error;}):undefined;
        await openProject(settings.data.lastProject,resume);
      } catch(error) {if(error.code!=='ENOENT'){restoreError='上次会话未能恢复。原文件已保留，请检查会话或导出诊断后重试。';if(startupBenchmark)restoreFailure=redact(error.message,Object.values(settings.keys||{}));diagnostics ||= new Diagnostics(resolve(app.getPath('userData'),'logs'),{secrets:Object.values(settings.keys||{})});await diagnostics.event('restore_failed',{version:app.getVersion(),stage:'session_restore',code:error.code||'invalid_state'}).catch(()=>{});}}
    }
    startup.mark('project-ready');
  })();
  let earlyUI;
  await Promise.all([initialization,window.loadURL(ENTRY).then(async()=>{
    startup.mark('document-loaded');
    if(startupBenchmark)earlyUI={backendReady:startup.stages.some(item=>item.stage==='project-ready'),...await window.webContents.executeJavaScript("({locked:document.body.inert,busy:document.body.getAttribute('aria-busy')})")};
  })]);
  if(startupBenchmark) {
    await Promise.race([startup.finished,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Startup benchmark timed out')),60000))]);
    const ui=await window.webContents.executeJavaScript("({locked:document.body.inert,busy:document.body.getAttribute('aria-busy'),error:!document.getElementById('operation-error').hidden})");
    const agent=worker?await worker.request('state'):null;
    const report={stages:startup.snapshot(),packaged:app.isPackaged,workerStarts:navigationPerformance.workerStarts,restoredSession:!!current?.sessionId,earlyUI,ui,validation:{version:app.getVersion(),sessionId:current?.sessionId||null,keyLoadError:settings.keyLoadError||null,keyStatus:settings.keyStatus(),resourceOverrides:resources.data.overrides,commands:agent?.commands.map(c=>c.command)||[],resourceErrors:agent?.resourceDiagnostics.filter(d=>d.type==='error').length||0,...(restoreFailure?{restoreFailure}:{})}};
    await writeFile(resolve(app.getPath('userData'),'startup-result.json'),JSON.stringify(report,null,2));
    shuttingDown=true;await stopWorker();app.quit();return;
  }
  if (smoke) { const checks = await import(reliabilitySmoke ? './reliability-smoke.mjs' : packageCheck ? './packaging-smoke.mjs' : navigationBenchmark ? './navigation-benchmark.mjs' : './smoke.mjs'); await (reliabilitySmoke ? checks.runReliabilitySmoke : packageCheck ? checks.runPackagingSmoke : navigationBenchmark ? checks.runNavigationBenchmark : liveSmoke ? checks.runLiveSmoke : checks.runSmoke)({ window, actions, settings, project,killWorker:()=>worker?.child.kill(),ownedCommands:()=>commandSupervisor?.commands.size||0 }); shuttingDown = true; await stopWorker(); app.quit(); }
}).catch(error => { console.error(error instanceof Error ? error.stack : 'Desktop startup failed'); app.exit(1); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (worker && !shuttingDown) { shuttingDown = true; worker.child.kill(); } });
