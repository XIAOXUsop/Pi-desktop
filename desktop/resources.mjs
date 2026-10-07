import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DefaultPackageManager, SettingsManager, loadSkills, ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { atomicJson } from './settings.mjs';

const types = ['extensions', 'skills', 'prompts', 'themes'];
const idFor = (type, path) => createHash('sha256').update(type + ':' + path).digest('hex').slice(0, 24);
export class ResourceManager {
  constructor(folder) { this.folder = resolve(folder, 'pi'); this.path = resolve(this.folder, 'resources.json'); }
  async load() {
    await mkdir(this.folder, { recursive: true });
    try { this.data = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.data = { sources: [], overrides: {} }; }
    return this;
  }
  manager(workspace) { return new DefaultPackageManager({ cwd: workspace || this.folder, agentDir: this.folder, settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }) }); }
  async installBundledWorkflows(root) {
    if(this.data.bundledWorkflows===1){
      const source=this.data.sources.find(s=>s.bundled);
      if(!source||source.root===root)return this;
      root=await realpath(root);const paths=await this.resolve(root);
      for(const item of paths.extensions){
        const oldId=idFor('extensions',resolve(source.root,relative(root,item.path))),newId=idFor('extensions',item.path);
        for(const overrides of Object.values(this.data.overrides))if(overrides[oldId]!==undefined&&overrides[newId]===undefined){overrides[newId]=overrides[oldId];delete overrides[oldId];}
      }
      source.root=root;await atomicJson(this.path,this.data);return this;
    }
    root=await realpath(root);let source=this.data.sources.find(s=>s.root===root && !s.project);
    if(!source){source={id:randomUUID(),source:'内置工作流',root,project:null,bundled:true};this.data.sources.push(source);}
    const paths=await this.resolve(root);this.data.overrides.global ??= {};
    for(const item of paths.extensions){const id=idFor('extensions',item.path);if(this.data.overrides.global[id]===undefined)this.data.overrides.global[id]=true;}
    this.data.bundledWorkflows=1;await atomicJson(this.path,this.data);return this;
  }
  async resolve(root, workspace) {
    if (await stat(resolve(root, 'SKILL.md')).then(s => s.isFile(), () => false)) return { extensions: [], skills: [{ path: root }], prompts: [], themes: [] };
    const result = await this.manager(workspace).resolveExtensionSources([root], { temporary: true });
    if(result.extensions.length === 1 && result.extensions[0].path === root && (await stat(root)).isDirectory()) {
      const entry = await Promise.all(['index.ts','index.js'].map(name => stat(resolve(root,name)).then(s => s.isFile(),() => false)));
      if(!entry.some(Boolean)) result.extensions = [];
    }
    return result;
  }
  async list(workspace) {
    const resources = new Map(), diagnostics = [], sources = this.data.sources.filter(s => !s.project || s.project === workspace);
    const add = (type, path, source, extras = {}) => {
      const id = idFor(type, path); const previous = resources.get(id);
      const enabled = this.data.overrides[workspace || 'global']?.[id] ?? this.data.overrides.global?.[id] ?? !!(source.discovered && type === 'skills');
      resources.set(id, { ...previous, id, type, path, name: basename(path), sourceId: source.id, source: source.source, scope: source.project ? 'project' : 'global', removable: !source.discovered, enabled, ...extras });
    };
    const scan = async source => {
      const before = resources.size;
      try {
        const paths = await this.resolve(source.root, workspace);
        for (const type of types) for (const resource of paths[type]) {
          if (type !== 'skills') add(type, resource.path, source,source.bundled?{name:basename(resource.path)==='plan.ts'?'规划 /plan':'持续目标 /goal',description:basename(resource.path)==='plan.ts'?'只读探索、澄清与计划确认。':'带验收、预算、暂停与恢复的持续任务。'}:{});
          else {
            const loaded = loadSkills({ cwd: workspace || this.folder, agentDir: this.folder, skillPaths: [resource.path], includeDefaults: false });
            diagnostics.push(...loaded.diagnostics);
            for (const skill of loaded.skills) add(type, skill.filePath, source, { name: skill.name, description: skill.description, baseDir: skill.baseDir, manualOnly: skill.disableModelInvocation });
          }
        }
      } catch (error) { diagnostics.push({ type: 'error', path: source.root, message: error.message }); }
      if(resources.size === before && ![...resources.values()].some(item => item.sourceId === source.id)) add('sources',source.root,source,{error:true,description:'来源已移动、删除或不再包含有效资源。可以移除引用后重新添加。'});
    };
    for (const source of sources) await scan(source);
    if (workspace) {
      const discovered = { id: 'project', source: '项目目录', project: workspace, discovered: true };
      // Discovery does not evaluate extension code or read another application's settings.
      const manager = this.manager(workspace); const paths = await manager.resolve(() => Promise.resolve('skip'));
      for (const resource of paths.extensions.filter(r => r.metadata.scope === 'project')) add('extensions', resource.path, discovered);
      for (const directory of ['.pi/skills', '.agents/skills', 'skills']) {
        const root = resolve(workspace, directory);
        const loaded = loadSkills({ cwd: workspace, agentDir: this.folder, skillPaths: [root], includeDefaults: false });
        diagnostics.push(...loaded.diagnostics.filter(d => !d.message.includes('does not exist')));
        for (const skill of loaded.skills) add('skills', skill.filePath, discovered, { name: skill.name, description: skill.description, baseDir: skill.baseDir, manualOnly: skill.disableModelInvocation });
      }
    }
    const items = [...resources.values()].sort((a,b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    const names = new Set();
    for (const item of items.filter(i => i.type === 'skills' && i.enabled)) {
      if (names.has(item.name)) { item.enabled = false; diagnostics.push({ type: 'error', path: item.path, message: `重复的 skill 名称：${item.name}。本项未加载，请停用重复项。` }); }
      names.add(item.name);
    }
    return { items, sources, diagnostics, runtime: 'Pi 1.0.1', supports: '工具、事件、命令、skill、选择与确认框、文本输入和持久状态；终端自定义组件不在桌面显示' };
  }
  async add({ source, scope = 'project' }, workspace) {
    if (scope !== 'global' && scope !== 'project') throw new Error('无效作用范围');
    if (scope === 'project' && !workspace) throw new Error('请先打开项目，或选择桌面通用');
    if (typeof source !== 'string' || !source.trim() || source.length > 2048 || /[\r\n\x00]/.test(source)) throw new Error('请输入有效来源');
    source = source.trim(); let root;
    if (/^(npm:|git:|https:\/\/)/.test(source)) {
      if (source.startsWith('https:') && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(source)) throw new Error('Git URL 请使用 GitHub 仓库地址，其他仓库使用 git: 来源');
      if (source.startsWith('npm:') && !/^npm:(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:@[a-zA-Z0-9.+_~-]+)?$/.test(source)) throw new Error('npm 来源格式：npm:包名@版本');
      if (source.startsWith('git:') && !/^git:(?:https:\/\/)?[a-zA-Z0-9.-]+\/[a-zA-Z0-9_./-]+(?:@[a-zA-Z0-9._/-]+)?$/.test(source)) throw new Error('Git 来源格式：git:github.com/作者/仓库@标签');
      const identity = value => value.startsWith('npm:') ? value.replace(/@[^@/]+$/,'') : value.replace(/@[^@]+$/,'').replace(/^git:/,'').replace(/^https:\/\//,'').replace(/\.git$/,'');
      if(this.data.sources.some(s => identity(s.source) === identity(source))) throw new Error('这个包已添加。更换版本请先移除旧来源，再添加新版本');
      // Each install has its own package root, so a project version cannot overwrite a global one.
      const installDir = resolve(this.folder,'downloads',randomUUID()); await mkdir(installDir,{recursive:true});
      const manager = new DefaultPackageManager({cwd:workspace || this.folder,agentDir:installDir,settingsManager:SettingsManager.inMemory({})}); const before = process.env.npm_config_ignore_scripts;
      process.env.npm_config_ignore_scripts = 'true';
      try { await manager.install(source); root = manager.getInstalledPath(source, 'user'); }
      finally { if (before === undefined) delete process.env.npm_config_ignore_scripts; else process.env.npm_config_ignore_scripts = before; }
      if (!root) throw new Error('未找到安装目录');
    } else {
      root = await realpath(resolve(workspace || this.folder, source));
      const info = await stat(root);
      if (!info.isDirectory() && !/\.(?:ts|js|mjs|cjs)$/i.test(root) && basename(root).toUpperCase() !== 'SKILL.MD') throw new Error('请选择 skill 目录、SKILL.md、扩展文件或 Pi 包目录');
      if (info.isFile() && basename(root).toUpperCase() === 'SKILL.MD') root = dirname(root);
      source = root;
    }
    const project = scope === 'project' ? workspace : null;
    if (this.data.sources.some(s => s.root === root && s.project === project)) throw new Error('这个来源已经添加');
    const paths = await this.resolve(root, workspace);
    // A bare skill directory is accepted by Pi's source resolver.
    const validSkills = loadSkills({cwd:workspace || this.folder,agentDir:this.folder,skillPaths:paths.skills.map(r => r.path),includeDefaults:false});
    if (!paths.extensions.length && !paths.prompts.length && !paths.themes.length && !validSkills.skills.length) throw new Error(validSkills.diagnostics[0]?.message || '没有发现 Pi 资源，请检查 SKILL.md 或 package.json 的 pi 字段');
    const key = project || 'global';this.data.overrides[key] ??= {};
    for(const type of types) for(const item of type === 'skills' ? validSkills.skills : paths[type]) this.data.overrides[key][idFor(type,item.filePath || item.path)] = false;
    this.data.sources.push({ id: randomUUID(), source, root, project }); await atomicJson(this.path, this.data);
    return this.list(workspace);
  }
  async create({type,name,description,body,scope = 'project'}, workspace) {
    if(!['skills','prompts'].includes(type)) throw new Error('仅支持创建技能与提示模板');
    if(!['project','global'].includes(scope) || (scope === 'project' && !workspace)) throw new Error('请选择有效的作用范围');
    if(typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error('名称请使用小写字母、数字和连字符，最多 64 字符');
    if(typeof description !== 'string' || !description.trim() || description.length > 1024 || /[\r\n\x00]/.test(description)) throw new Error('请填写一行说明，最多 1024 字');
    if(typeof body !== 'string' || !body.trim() || Buffer.byteLength(body) > 256 * 1024 || body.includes('\x00')) throw new Error('请填写正文，最多 256 KiB');
    if((await this.list(workspace)).items.some(i => i.type === type && i.name.replace(/\.md$/,'') === name)) throw new Error('已有同名资源，请使用不同名称');
    const root = resolve(this.folder,'custom',randomUUID());
    const directory = type === 'skills' ? resolve(root,'skills',name) : resolve(root,'prompts');
    await mkdir(directory,{recursive:true});
    await writeFile(resolve(directory,type === 'skills' ? 'SKILL.md' : name+'.md'),`---\n${type === 'skills' ? 'name: '+JSON.stringify(name)+'\n' : ''}description: ${JSON.stringify(description.trim())}\n---\n${body}\n`,{encoding:'utf8',flag:'wx'});
    await writeFile(resolve(root,'package.json'),JSON.stringify({name:'local-'+name,private:true,pi:{[type]:[type]}}),{flag:'wx'});
    return this.add({source:root,scope},workspace);
  }
  async toggle({ id, enabled, scope = 'project' }, workspace) {
    if (typeof enabled !== 'boolean' || !['project','global'].includes(scope)) throw new Error('无效启用设置');
    const item = (await this.list(workspace)).items.find(item => item.id === id);
    if (!item) throw new Error('资源已不存在，请刷新');
    if (scope === 'global' && item.scope === 'project') throw new Error('项目资源只能在当前项目设置');
    const key = scope === 'project' ? workspace : 'global'; if (!key) throw new Error('请先打开项目');
    this.data.overrides[key] ??= {}; this.data.overrides[key][id] = enabled; await atomicJson(this.path, this.data);
    return this.list(workspace);
  }
  async remove({ sourceId }, workspace) {
    const source = this.data.sources.find(s => s.id === sourceId && (!s.project || s.project === workspace));
    if (!source) throw new Error('项目自带资源请在源目录管理，可在这里停用');
    this.data.sources = this.data.sources.filter(s => s.id !== sourceId); await atomicJson(this.path, this.data);
    return this.list(workspace);
  }
  async preview({ id }, workspace) {
    const item = (await this.list(workspace)).items.find(i => i.id === id); if (!item) throw new Error('找不到资源');
    const info = await stat(item.path); if (!info.isFile() || info.size > 256 * 1024) throw new Error('只能预览不超过 256 KiB 的文件');
    return { ...item, text: await readFile(item.path, 'utf8') };
  }
  async runtime(workspace) {
    const list = await this.list(workspace), projectTrusted = workspace ? new ProjectTrustStore(this.folder).get(workspace)!==false : true;
    return {...Object.fromEntries(types.map(type => [type, list.items.filter(i => i.type === type && i.enabled && (projectTrusted || i.scope==='global')).map(i => i.path)])),...(!projectTrusted?{projectTrusted:false}:{})};
  }
}
