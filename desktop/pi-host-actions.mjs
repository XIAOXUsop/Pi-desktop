import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ProjectTrustStore} from '@earendil-works/pi-coding-agent';
import {completePiPrompt} from './pi-completion.mjs';
import {piModule} from './pi-native.mjs';
import {parsePiImport} from './session-transfer.mjs';
const exec=promisify(execFile);

export function piHostActions({settings,resources,worker,current,window,dialog,app,state,exclusive,openProject,reloadWorker}) {
  const requireSession=()=>{if(!worker() || !current()?.sessionId)throw new Error('请先选择或新建会话');return worker();};
  return {
    async completePrompt(input) {
      const client=worker(),project=current()?.workspace;
      const result=client && current()?.sessionId ? await client.request('complete',input) : await completePiPrompt(input,{workspace:project,models:[...settings.config.models.map(m=>({...m,key:`${m.provider}/${m.id}`})),{key:'demo/offline',id:'offline',provider:'demo'}],providers:settings.config.providers,scopedModels:settings.data.scopedModels || []});
      return client!==worker() || project!==current()?.workspace ? null : result;
    },
    async piAction(input={}) {
      const {kind}=input;
      if(kind==='changelog')return {text:await readFile(new URL('../CHANGELOG.md',import.meta.resolve('@earendil-works/pi-coding-agent')),'utf8')};
      if(kind==='trust-info') {if(!current())throw new Error('请先打开项目');return {path:current().workspace,decision:new ProjectTrustStore(resources.folder).get(current().workspace)};}
      if(kind==='quit') {app.quit();return {accepted:true};}
      if(kind==='bug' || kind==='share') return exclusive(async()=>{
        const client=requireSession();
        if(kind==='share') {
          if(input.delivery!=='upload')return {info:await client.request('session_info')};
          const folder=resolve(settings.folder,'pi/exports');await mkdir(folder,{recursive:true});const temp=await mkdtemp(resolve(folder,'share-'));
          const file=resolve(temp,'session.html');await client.request('export_html',{path:file},150000);
          try {
            const result=await exec('gh',['gist','create',file,'--desc','Pi session'],{windowsHide:true,timeout:120000,maxBuffer:16384});
            const url=result.stdout.trim();if(!/^https:\/\/gist\.github\.com\/[\w/-]+$/.test(url))throw new Error('分享服务未返回有效地址');return {url};
          } catch {throw new Error('分享失败。请安装 GitHub CLI 并登录后重试；本地导出仍保留。');}
        }
        if(!['zip','upload'].includes(input.delivery))throw new Error('请选择问题报告的保存或上传方式');
        let destination;
        if(input.delivery==='zip') {const choice=await dialog.showSaveDialog(window(),{title:'保存 Pi 问题报告',defaultPath:'pi-bug-report.zip',filters:[{name:'问题报告',extensions:['zip']}]});if(choice.canceled)return {cancelled:true};destination=choice.filePath;}
        const bundle=await client.request('bug_bundle',{hint:typeof input.hint==='string'?input.hint.slice(0,8192):'',includeSession:input.includeSession===true,includeSummary:input.includeSummary===true},600000);
        if(destination) {const {writeBugReportArchive}=await piModule('core/bug-report.js');await writeBugReportArchive(bundle,destination);return {path:destination};}
        const {uploadBugReport}=await piModule('core/bug-report-upload.js');return uploadBugReport(bundle,{signal:AbortSignal.timeout(120000)});
      });
      return exclusive(async()=>{
        if(kind==='thinking') {const level=await requireSession().request('thinking',{level:input.level});settings.data.thinkingLevel=level;await settings.save();return {state:await state(),level};}
        if(kind==='scoped-models') {
          const keys=[...settings.config.models.map(m=>`${m.provider}/${m.id}`),'demo/offline'];
          if(!Array.isArray(input.keys) || input.keys.some(k=>!keys.includes(k)))throw new Error('请选择已配置的模型');
          settings.data.scopedModels=[...new Set(input.keys)];await settings.save();await reloadWorker();return {state:await state()};
        }
        if(kind==='trust') {if(!current() || ![true,false,null].includes(input.decision))throw new Error('无效项目信任设置');new ProjectTrustStore(resources.folder).set(current().workspace,input.decision);await reloadWorker();return {state:await state()};}
        if(kind==='logout') {await settings.removeKey(input.providerId);await reloadWorker();return {state:await state(),environmentRetained:!!settings.keys[settings.config.providers.find(p=>p.id===input.providerId)?.apiKeyEnv]};}
        if(kind==='clone' || kind==='fork' || kind==='import') {
          if(!current())throw new Error('请先打开项目');
          if(kind!=='import')requireSession();
          let jsonl;
          if(kind==='import') {
            let path=input.path;
            if(!path) {const selected=await dialog.showOpenDialog(window(),{title:'导入官方 Pi 会话',properties:['openFile'],filters:[{name:'Pi 会话',extensions:['jsonl']}]});if(selected.canceled)return {cancelled:true};path=selected.filePaths[0];}
            // An explicit command path is chosen by the user; it is data only.
            const {stat}=await import('node:fs/promises');path=resolve(current().workspace,path);if((await stat(path)).size>64*1024*1024)throw new Error('导入会话最多 64 MiB');jsonl=await readFile(path,'utf8');parsePiImport(jsonl,current().workspace);
          }
          if(!current().sessionId)await openProject(current().workspace,undefined,{createNew:true});
          const copied=await requireSession().request('copy_session',{mode:kind,entryId:input.entryId,...(jsonl!==undefined?{jsonl}:{})},150000);
          const next=await openProject(current().workspace,copied.path);return {state:next,editorText:copied.editorText};
        }
        throw new Error('未知 Pi 桌面操作');
      });
    },
    async exportSession({path}={}) {return exclusive(async()=>{
      const client=requireSession(),selected=await dialog.showSaveDialog(window(),{title:'导出会话',defaultPath:path ? resolve(current().workspace,path) : resolve(current().workspace,`session-${current().sessionId}.html`),filters:[{name:'会话网页',extensions:['html']},{name:'Pi 会话',extensions:['jsonl']}]});
      if(selected.canceled || !selected.filePath)return {cancelled:true};
      const method=extname(selected.filePath).toLowerCase()==='.jsonl'?'export_jsonl':'export_html';return {path:await client.request(method,{path:selected.filePath},150000)};
    });},
  };
}
