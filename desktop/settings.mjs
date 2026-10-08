import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseConfig } from '../dist/src/index.js';
import { providerPresets, normalizeBaseUrl, officialModelLimits, presetModelProvider } from './provider-presets.mjs';
import {persistentKey,persistentKeys} from './environment-keys.mjs';
export {persistentKey} from './environment-keys.mjs';

export async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, path);
}
export class SettingsStore {
  constructor(folder, defaultConfig, vault, onStage = () => {}) { this.folder = folder; this.defaultConfig = defaultConfig; this.vault = vault; this.keys = {}; this.saving = Promise.resolve(); this.onStage = onStage; }
  async load() {
    await mkdir(this.folder, { recursive: true });
    try { this.data = JSON.parse(await readFile(resolve(this.folder, 'settings.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.data = { recentProjects: [], selectedModel: null, permissions: { write: false, shell: false } }; }
    this.data.mode ??= 'build'; this.data.sessionMetadata ??= {};
    this.data.projectSessions ??= {};
    this.data.preferences = { theme: 'light', panelWidth: 440, diffStyle: 'unified', panelVisible: false, ...this.data.preferences };
    this.onStage('settings-file-ready');
    try { this.config = parseConfig(JSON.parse(await readFile(resolve(this.folder, 'models.json'), 'utf8'))).config; }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.config = parseConfig(JSON.parse(await readFile(this.defaultConfig, 'utf8'))).config; }
    this.onStage('model-config-ready');
    // Existing official models receive the same documented limits as newly added presets.
    const updated = this.config.models.map(model => {
      const provider = this.config.providers.find(p => p.id === model.provider);
      const limits = officialModelLimits(provider, model.id);
      return limits ? {...model,contextWindow:limits.contextWindow,maxOutputTokens:limits.maxOutputTokens} : model;
    });
    if (JSON.stringify(updated) !== JSON.stringify(this.config.models)) await this.saveConfig({...this.config,models:updated});
    this.onStage('model-limits-ready');
    try {
      const encrypted = JSON.parse(await readFile(resolve(this.folder, 'keys.json'), 'utf8'));
      for (const [name, value] of Object.entries(encrypted)) this.keys[name] = await this.vault.decrypt(Buffer.from(value, 'base64'));
    } catch (error) { if (error.code !== 'ENOENT') this.keyLoadError = '本机密钥读取失败，请重新设置密钥'; }
    this.onStage('vault-ready');
    const names=this.config.providers.map(provider=>provider.apiKeyEnv).filter(name=>name&&!this.keys[name]);
    Object.assign(this.keys,await persistentKeys(names));
    return this;
  }
  save() { const snapshot = structuredClone(this.data); this.saving = this.saving.catch(() => {}).then(() => atomicJson(resolve(this.folder, 'settings.json'), snapshot)); return this.saving; }
  sessionMeta(workspace, id) { return this.data.sessionMetadata[workspace]?.[id] ?? {}; }
  async removeSession(workspace, id) {
    delete this.data.sessionMetadata[workspace]?.[id];
    if (this.data.projectSessions[workspace] === id) delete this.data.projectSessions[workspace];
    if (this.data.lastSession === resolve(workspace, '.agent/sessions', `${id}.jsonl`)) delete this.data.lastSession;
    await this.save();
  }
  async updateSession(workspace, id, patch) {
    if (typeof workspace !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) || !patch || Object.keys(patch).some(key => !['title', 'pinned', 'archived'].includes(key))) throw new Error('无效会话设置');
    if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.trim().length > 100)) throw new Error('标题需为 1–100 字');
    for (const key of ['pinned', 'archived']) if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new Error('无效会话设置');
    this.data.sessionMetadata[workspace] ??= {};
    this.data.sessionMetadata[workspace][id] = { ...this.sessionMeta(workspace, id), ...patch, ...(patch.title !== undefined ? { title: patch.title.trim() } : {}) };
    await this.save();
  }
  async setPreferences(patch) {
    if (!patch || Object.keys(patch).some(key => !['theme', 'panelWidth', 'diffStyle', 'panelVisible'].includes(key))) throw new Error('无效界面设置');
    if (patch.theme !== undefined && !['light', 'dark', 'system'].includes(patch.theme)) throw new Error('无效主题');
    if (patch.diffStyle !== undefined && !['unified', 'split'].includes(patch.diffStyle)) throw new Error('无效差异样式');
    if (patch.panelWidth !== undefined && (!Number.isFinite(patch.panelWidth) || patch.panelWidth < 300 || patch.panelWidth > 800)) throw new Error('无效面板宽度');
    if (patch.panelVisible !== undefined && typeof patch.panelVisible !== 'boolean') throw new Error('无效面板显示');
    this.data.preferences = { ...this.data.preferences, ...patch }; await this.save(); return this.data.preferences;
  }
  async saveConfig(config) {
    const parsed = parseConfig(config).config;
    const normalized = {...parsed,models:parsed.models.map(model => {
      const limits = officialModelLimits(parsed.providers.find(p => p.id === model.provider),model.id);
      return limits ? {...model,contextWindow:limits.contextWindow,maxOutputTokens:limits.maxOutputTokens} : model;
    })};
    const validated = parseConfig(normalized).config; await atomicJson(resolve(this.folder, 'models.json'), validated); this.config = validated;
  }
  keyStatus() { return Object.fromEntries(this.config.providers.map(provider => [provider.id, !provider.apiKeyEnv || !!this.keys[provider.apiKeyEnv]])); }
  workerEnvironment() {
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    for (const [name, value] of Object.entries(this.keys)) if (value) environment[name] = value;
    return environment;
  }
  async setKey(providerId, key, persist) {
    const provider = this.config.providers.find(p => p.id === providerId);
    if (!provider?.apiKeyEnv || typeof key !== 'string' || !key.trim() || key.length > 8192) throw new Error('请选择服务并输入有效密钥');
    await this.setKeyValue(provider.apiKeyEnv, key, persist);
  }
  async removeKey(providerId) {
    const provider=this.config.providers.find(p=>p.id===providerId);if(!provider?.apiKeyEnv)throw new Error('请选择使用密钥的提供方');
    let encrypted={};try{encrypted=JSON.parse(await readFile(resolve(this.folder,'keys.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    delete encrypted[provider.apiKeyEnv];await atomicJson(resolve(this.folder,'keys.json'),encrypted);
    this.keys[provider.apiKeyEnv]=await persistentKey(provider.apiKeyEnv);
  }
  async setKeyValue(apiKeyEnv, key, persist) {
    if (persist) {
      if (!await this.vault.available()) throw new Error('当前无法加密保存；取消保存选项可仅用于本次启动');
      let encrypted = {}; try { encrypted = JSON.parse(await readFile(resolve(this.folder, 'keys.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      encrypted[apiKeyEnv] = (await this.vault.encrypt(key.trim())).toString('base64');
      await atomicJson(resolve(this.folder, 'keys.json'), encrypted);
    }
    this.keys[apiKeyEnv] = key.trim();
  }
  async addPreset(input) {
    const preset = providerPresets().find(preset => preset.id === input?.presetId);
    if (!preset) throw new Error('请选择有效的提供方预设');
    if (input.modelId !== undefined && typeof input.modelId !== 'string') throw new Error('请输入有效模型名称');
    const modelId = (input.modelId ?? preset.models[0].id).trim();
    const selected = preset.models.find(model => model.id === modelId);
    if(selected&&(selected.tools===false||selected.status==='retired'))throw new Error(selected.unavailableReason||'该模型暂不支持编程对话');
    const template=presetModelProvider(preset,selected);
    const providerId = input.providerId ?? template.id;
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(providerId) || !modelId || modelId.length > 200) throw new Error('请输入有效服务标识和模型名称');
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? template.baseUrl);
    const official = providerId === template.id && baseUrl === normalizeBaseUrl(template.baseUrl);
    if (providerId === template.id && !official) throw new Error('修改官方地址时，请另设服务标识，避免覆盖现有配置');
    const provider = { ...template, id: providerId, baseUrl, apiKeyEnv: official ? template.apiKeyEnv : `LOCAL_AGENT_${providerId.toUpperCase().replace(/-/g, '_')}_KEY` };
    const existing = this.config.providers.find(item => item.id === providerId);
    if (existing && (normalizeBaseUrl(existing.baseUrl) !== baseUrl || existing.protocol !== provider.protocol)) throw new Error('此服务标识已用于其他接口，请使用不同标识');
    if (existing && !existing.apiKeyEnv) throw new Error('现有服务未配置密钥变量，请使用不同标识');
    const documented = officialModelLimits(provider, modelId);
    if (documented && ((input.contextWindow !== undefined && input.contextWindow !== documented.contextWindow) || (input.maxOutputTokens !== undefined && input.maxOutputTokens !== documented.maxOutputTokens))) throw new Error('预制模型使用官方文档限制，请重新选择模型以更新数值');
    const key = `${providerId}/${modelId}`;
    const model = { provider: providerId, id: modelId, contextWindow: documented?.contextWindow ?? input.contextWindow ?? selected?.contextWindow, maxOutputTokens: documented?.maxOutputTokens ?? input.maxOutputTokens ?? selected?.maxOutputTokens, tools: true };
    const found = this.config.models.find(item => `${item.provider}/${item.id}` === key);
    const config = { ...this.config, providers: existing ? this.config.providers : [...this.config.providers, provider], models: found ? this.config.models.map(item => item === found && documented ? {...item,contextWindow:model.contextWindow,maxOutputTokens:model.maxOutputTokens} : item) : [...this.config.models, model] };
    parseConfig(config); // Validate the complete configuration before accepting credentials.
    if (input.key !== undefined && (typeof input.key !== 'string' || input.key.length > 8192)) throw new Error('请输入有效密钥');
    const keyName = existing?.apiKeyEnv ?? provider.apiKeyEnv;
    if (input.key?.trim()) await this.setKeyValue(keyName, input.key, input.persist === true);
    else if (!this.keys[keyName]) this.keys[keyName] = await persistentKey(keyName);
    await this.saveConfig(config); this.data.selectedModel = key; await this.save(); return key;
  }
  async addModel(input) {
    if (!input || !/^[a-zA-Z0-9_-]{1,48}$/.test(input.providerId) || typeof input.modelId !== 'string' || !input.modelId.trim()) throw new Error('请输入服务标识和模型名称');
    if (!['openai-chat', 'openai-responses', 'anthropic'].includes(input.protocol)) throw new Error('请选择接口类型');
    const url = new URL(input.baseUrl); const isDeepSeek = url.hostname === 'api.deepseek.com';
    const provider = { id: input.providerId, protocol: input.protocol, baseUrl: input.baseUrl, apiKeyEnv: `LOCAL_AGENT_${input.providerId.toUpperCase().replace(/-/g, '_')}_KEY`,
      ...(input.protocol === 'openai-chat' ? { tokenLimitField: input.legacyTokens ? 'max_tokens' : 'max_completion_tokens', ...(isDeepSeek ? { thinking: 'disabled' } : {}) } : {}) };
    const existing = this.config.providers.find(p => p.id === provider.id);
    if (existing && (existing.baseUrl !== provider.baseUrl || existing.protocol !== provider.protocol)) throw new Error('此服务标识已用于其他接口，请使用不同标识');
    const key = `${provider.id}/${input.modelId.trim()}`;
    const limits = officialModelLimits(provider,input.modelId.trim());
    const config = { ...this.config, providers: existing ? this.config.providers : [...this.config.providers, provider], models: [...this.config.models,
      { provider: provider.id, id: input.modelId.trim(), contextWindow: limits?.contextWindow ?? input.contextWindow, maxOutputTokens: limits?.maxOutputTokens ?? input.maxOutputTokens, tools: true }] };
    await this.saveConfig(config); this.data.selectedModel = key; await this.save(); return key;
  }
  async updateModelLimits({key,contextWindow,maxOutputTokens}) {
    const model = this.config.models.find(m => `${m.provider}/${m.id}` === key);
    if (!model) throw new Error('找不到该模型');
    const provider = this.config.providers.find(p => p.id === model.provider);
    if (officialModelLimits(provider,model.id)) throw new Error('预制模型自动使用官方文档限制');
    await this.saveConfig({...this.config,models:this.config.models.map(m => m === model ? {...m,contextWindow,maxOutputTokens} : m)});
  }
}
