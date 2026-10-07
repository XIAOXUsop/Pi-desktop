// Desktop actions for Pi commands. Built-ins use host APIs; resources prepare an editable prompt.
export function setupPiCommands({api,$,node,getState,isBusy,guard,switchView,refresh,toast,preparePrompt,setDraft,setCompacting,openPalette,openRename,openSettings,parsedUser}) {
  let generation=0, compacting=false;
  const details=$('pi-details-dialog');
  $('close-pi-details').onclick=()=>details.close();
  details.addEventListener('close',()=>generation++);
  function showDetails(title,note) {
    const ticket=++generation; $('pi-details-heading').textContent=title;$('pi-details-note').textContent=note;
    $('pi-details-body').replaceChildren();$('pi-details-error').hidden=true;details.showModal();$('close-pi-details').focus();return ticket;
  }
  async function detailRequest(title,note,request,render) {
    const owner=getState().agent?.sessionId,ticket=showDetails(title,note);
    $('pi-details-body').textContent='正在读取…';
    try {const result=await request();if(generation!==ticket || !details.open || owner!==getState().agent?.sessionId)return;$('pi-details-body').replaceChildren();render(result);}
    catch(error) {if(generation!==ticket || !details.open)return;$('pi-details-body').replaceChildren();$('pi-details-error').textContent=error.message;$('pi-details-error').hidden=false;}
  }
  const format=value=>Number(value || 0).toLocaleString('zh-CN');
  function sessionInfo() {return detailRequest('会话信息','当前 Pi 会话的消息统计与上下文使用情况。',()=>api.sessionInfo(),info=>{
    const usage=info.contextUsage, list=node('dl','pi-stats');
    const rows=[['模型',info.model],['会话 ID',info.sessionId],['会话文件',info.sessionFile],['消息',`${info.userMessages} 条任务 · ${info.assistantMessages} 条模型消息`],['工具调用',format(info.toolCalls)],['累计输入 / 输出',`${format(info.tokens.input)} / ${format(info.tokens.output)} token`],['当前上下文',usage?.tokens==null ? '待下一次请求更新' : `${format(usage.tokens)} / ${format(usage.contextWindow)} token`],['可用工具',info.tools.join('、') || '无']];
    for(const [label,value] of rows)list.append(node('dt','',label),node('dd','',value));$('pi-details-body').append(list);
  });}
  function historyTree() {return detailRequest('会话历史','选择一个节点，从该位置继续。项目文件保持当前状态。',()=>api.history(),history=>{
    const available=new Set(history.branchableEntryIds),active=new Set(history.activeEntryIds);
    const entries=history.entries.filter(e=>available.has(e.id) && e.data.kind==='message' && ['user','assistant'].includes(e.data.message.role));
    if(!entries.length){$('pi-details-body').append(node('p','panel-empty','当前会话还没有可选的历史节点。'));return;}
    for(const entry of entries) {
      const message=entry.data.message,button=node('button','pi-history-row');button.type='button';button.dataset.entryId=entry.id;
      const title=message.role==='user' ? parsedUser(message.text).text : message.text;
      button.append(node('span','',title.trim().slice(0,160) || '工具调用'),node('small','',`${message.role==='user' ? '你的任务' : '模型消息'} · ${active.has(entry.id) ? '当前分支' : '其他分支'}${history.leaf===entry.id ? ' · 当前位置' : ''}`));
      button.disabled=isBusy();button.onclick=()=>{details.close();void switchView(()=>api.branch({entryId:entry.id}));};$('pi-details-body').append(button);
    }
  });}
  function hotkeys() {
    showDetails('快捷键','这些是桌面客户端实际支持的快捷键。');const list=node('dl','pi-stats');
    for(const [key,action] of [['Ctrl K','命令面板'],['Ctrl O','打开项目'],['Ctrl N','新建会话'],['Ctrl P','添加项目文件'],['Ctrl B','展开 / 收起侧栏'],['Ctrl L','聚焦任务输入框'],['Ctrl .','停止当前任务'],['Enter / Shift Enter','发送 / 换行'],['↑ ↓ / Enter / Esc','命令面板选择 / 执行 / 关闭']])list.append(node('dt','',key),node('dd','',action));
    $('pi-details-body').append(list);
  }
  function openCompact(instructions='') {$('pi-compact-instructions').value=instructions;$('pi-compact-error').hidden=true;$('pi-compact-dialog').showModal();$('pi-compact-instructions').focus();}
  $('close-pi-compact').onclick=()=>{if(!compacting)$('pi-compact-dialog').close();};
  $('pi-compact-dialog').addEventListener('cancel',event=>{if(compacting)event.preventDefault();});
  $('cancel-pi-compact').onclick=()=>compacting ? guard(()=>api.abort()) : $('pi-compact-dialog').close();
  $('pi-compact-form').onsubmit=async event=>{
    event.preventDefault();if(compacting || isBusy())return;compacting=true;setCompacting(true);$('pi-compact-error').hidden=true;
    $('confirm-pi-compact').disabled=true;$('close-pi-compact').disabled=true;$('pi-compact-instructions').disabled=true;$('cancel-pi-compact').textContent='停止压缩';$('pi-compact-form').setAttribute('aria-busy','true');
    try {const next=await api.compactSession({instructions:$('pi-compact-instructions').value});await refresh();$('pi-compact-dialog').close();toast(`上下文已压缩：${format(next.result.tokensBefore)} → 约 ${format(next.result.tokensAfter)} token`);}
    catch(error) {$('pi-compact-error').textContent=/cancelled/i.test(error.message) ? '已停止压缩，原有会话保留。' : error.message;$('pi-compact-error').hidden=false;}
    finally {compacting=false;setCompacting(false);$('confirm-pi-compact').disabled=false;$('close-pi-compact').disabled=false;$('pi-compact-instructions').disabled=false;$('cancel-pi-compact').textContent='取消';$('pi-compact-form').setAttribute('aria-busy','false');await guard(refresh);}
  };
  async function host(kind,input={}) {const result=await api.piAction({kind,...input});if(result.state)await refresh();return result;}
  async function transfer(kind,input={}) {
    let result;const changed=await switchView(async()=>{result=await api.piAction({kind,...input});return result.state || await api.state();});
    if(!changed)throw new Error('会话操作未完成');if(result?.editorText)setDraft(result.editorText);return result;
  }
  function choices(title,note,values,select) {
    showDetails(title,note);
    for(const value of values) {const button=node('button','pi-history-row');button.type='button';button.append(node('span','',value.label),node('small','',value.description || ''));button.disabled=isBusy();button.onclick=()=>void guard(async()=>{details.close();await select(value.value);});$('pi-details-body').append(button);}
  }
  function thinking() {const s=getState();choices('思考强度',`当前：${s.agent?.thinkingLevel || 'off'}。仅显示当前模型支持的强度。`,(s.agent?.thinkingLevels || ['off']).map(value=>({value,label:value})),value=>host('thinking',{level:value}));}
  function fork() {return detailRequest('从历史任务创建新会话','保留所选任务之前的历史，把这条任务放入新会话草稿。项目文件保持当前状态。',()=>api.history(),history=>{
    const available=new Set(history.branchableEntryIds),entries=history.entries.filter(e=>available.has(e.id) && e.data.kind==='message' && e.data.message.role==='user');
    if(!entries.length){$('pi-details-body').append(node('p','panel-empty','当前没有可以分叉的任务。'));return;}
    for(const entry of entries){const button=node('button','pi-history-row',parsedUser(entry.data.message.text).text.slice(0,160));button.dataset.forkId=entry.id;button.onclick=()=>{details.close();void guard(()=>transfer('fork',{entryId:entry.id}));};$('pi-details-body').append(button);}
  });}
  function scopedModels() {
    const s=getState();showDetails('模型切换范围','勾选需要参与 /model 补全的模型。全部不勾选时使用所有已配置模型。');
    const form=node('form','pi-command-form');for(const model of s.models){const label=node('label','check-label'),check=node('input');check.type='checkbox';check.name='model';check.value=model.key;check.checked=(s.scopedModels || []).includes(model.key);label.append(check,document.createTextNode(model.key));form.append(label);}
    const save=node('button','send-button','保存范围');save.type='submit';form.append(save);form.onsubmit=event=>{event.preventDefault();save.disabled=true;void guard(async()=>{await host('scoped-models',{keys:Array.from(form.querySelectorAll('input:checked')).map(input=>input.value)});details.close();toast('模型范围已保存');}).finally(()=>save.disabled=false);};$('pi-details-body').append(form);
  }
  function logout() {choices('移除提供方认证','只移除客户端保存的密钥。用户和系统环境变量仍保留。',getState().providers.map(p=>({value:p.id,label:p.name || p.id,description:getState().keyStatus[p.id]?'已配置认证':'未配置认证'})),async providerId=>{const result=await host('logout',{providerId});toast(result.environmentRetained?'保存的认证已移除；环境变量密钥仍可用。':'保存的认证已移除。');});}
  function trust() {return detailRequest('项目资源信任','设置保存在客户端独立的 Pi 信任文件中。不信任时，本项目目录内的扩展与技能不会加载。',()=>api.piAction({kind:'trust-info'}),info=>{
    $('pi-details-body').append(node('p','',info.path),node('p','resource-note','当前：'+(info.decision===true?'信任':info.decision===false?'不信任':'按已启用资源加载')));
    for(const [decision,label] of [[true,'信任此项目'],[false,'不信任此项目'],[null,'恢复资源启用设置']]) {const button=node('button','quiet-button',label);button.onclick=()=>{details.close();void guard(()=>host('trust',{decision}));};$('pi-details-body').append(button);}
  });}
  function delivery(kind,hint='') {
    showDetails(kind==='share'?'分享会话':'Pi 问题报告',kind==='share'?'将当前分支上传为 GitHub Secret Gist。需要已安装并登录 GitHub CLI；获得链接的人可以查看。会话可能包含文件内容和命令输出。':'问题报告交给 Pi 开发者。默认只包含已脱敏的配置与诊断，不含对话正文。');
    const form=node('form','pi-command-form'),error=node('p','inline-error');error.hidden=true;error.setAttribute('role','alert');form.append(error);
    let text,includeSession,includeSummary;
    if(kind==='bug') {
      text=node('textarea');text.rows=3;text.value=hint;text.placeholder='描述遇到的问题';text.setAttribute('aria-label','问题说明');form.append(text);
      for(const [key,label] of [['session','附上当前分支完整对话'],['summary','调用当前模型撰写摘要（会消耗模型额度）']]) {const row=node('label','check-label'),check=node('input');check.type='checkbox';check.dataset.report=key;row.append(check,document.createTextNode(label));form.append(row);if(key==='session')includeSession=check;else includeSummary=check;}
    }
    const finish=node('p','resource-note');finish.setAttribute('role','status');form.append(finish);
    for(const [delivery,label] of kind==='share'?[['upload','上传至 GitHub Secret Gist']]:[['zip','保存为 ZIP'],['upload','上传至 Pi 开发者']]) {
      const button=node('button',delivery==='upload'?'send-button':'quiet-button',label);button.type='button';button.dataset.delivery=delivery;button.onclick=async()=>{
        for(const control of form.querySelectorAll('button,input,textarea'))control.disabled=true;error.hidden=true;finish.textContent='正在处理…';
        try {const result=await api.piAction({kind,delivery,hint:text?.value || '',includeSession:!!includeSession?.checked,includeSummary:!!includeSummary?.checked});finish.textContent=result.cancelled?'已取消保存':result.url?'分享链接：'+result.url:result.path?'已保存：'+result.path:'已上传，报告 ID：'+result.id;}
        catch(failure){error.textContent=failure.message;error.hidden=false;finish.textContent='';}
        finally {for(const control of form.querySelectorAll('button,input,textarea'))control.disabled=false;}
      };form.append(button);
    }
    $('pi-details-body').append(form);
  }
  function isBuiltin(text) {const name=text.trim().split(/\s/,1)[0];return (getState().piCommands || []).some(c=>c.command===name);}
  async function execute(text) {
    const match=/^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());if(!match || !isBuiltin(text))return false;
    const [,name,raw='']=match,args=raw.trim(),s=getState();
    if(isBusy() && !['session','hotkeys','changelog'].includes(name))throw new Error('请先停止当前任务，再执行此指令');
    if(args && !['model','thinking','export','import','bug','name','login','compact'].includes(name))throw new Error('/'+name+' 不接受参数');
    switch(name) {
      case 'new': if(!await switchView(()=>api.newSession()))throw new Error('新建会话未完成');break;
      case 'resume':openPalette('会话 ·');break;
      case 'name': if(!s.agent)throw new Error('请先开始会话');if(args){if(!await switchView(()=>api.updateSession({id:s.agent.sessionId,patch:{title:args}}),{history:false}))throw new Error('重命名未完成');}else toast('当前会话：'+(s.sessions.find(v=>v.active)?.title || '新会话'));break;
      case 'model':if(args && s.models.some(m=>m.key===args)){if(!await switchView(()=>api.setModel({key:args})))throw new Error('模型切换未完成');}else openPalette('模型 ·'+(args?' '+args:''));break;
      case 'thinking':if(args)await host('thinking',{level:args.toLowerCase()});else thinking();break;
      case 'settings':openSettings('preset');break;
      case 'login':openSettings('key');if(args){if(!s.providers.some(p=>p.id===args))throw new Error('请选择已配置的提供方');$('key-provider').value=args;$('key-provider').dispatchEvent(new Event('change'));}break;
      case 'logout':logout();break;
      case 'scoped-models':scopedModels();break;
      case 'session':await sessionInfo();break;
      case 'tree':await historyTree();break;
      case 'fork':await fork();break;
      case 'clone':await transfer('clone');toast('已复制为新会话');break;
      case 'import':await transfer('import',{path:args.replace(/^"(.*)"$/s,'$1')});break;
      case 'compact':if(!s.agent)throw new Error('请先开始会话');openCompact(args);$('pi-compact-form').requestSubmit();break;
      case 'copy':{const info=await api.sessionInfo();if(!info.lastAssistantText.trim())throw new Error('当前没有可复制的回答');await api.copyText({text:info.lastAssistantText});toast('回答已复制');break;}
      case 'export':{const result=await api.exportSession({path:args.replace(/^"(.*)"$/s,'$1')});if(!result.cancelled)toast('会话已导出：'+result.path);break;}
      case 'reload':if(!await switchView(async()=>{await api.reloadResources();return api.state();}))throw new Error('重新加载未完成');toast('Pi 资源已重新加载');break;
      case 'trust':await trust();break;
      case 'share':if(!s.agent)throw new Error('请先开始会话');delivery('share');break;
      case 'bug':if(!s.agent)throw new Error('请先开始会话');delivery('bug',args);break;
      case 'changelog':await detailRequest('Pi 更新记录','当前安装版本附带的官方更新记录。',()=>api.piAction({kind:'changelog'}),value=>$('pi-details-body').append(node('pre','resource-preview',value.text)));break;
      case 'hotkeys':hotkeys();break;
      case 'quit':await api.piAction({kind:'quit'});break;
      default:throw new Error('此 Pi 指令尚未接入');
    }
    return true;
  }
  function options() {
    const state=getState(),busy=isBusy(),hasSession=!!state.agent;
    const hasCommand=name=>state.agent?.commands.some(command=>command.command===name && command.source==='extension');
    const goal=state.agent?.extensionUI?.cards.find(card=>card.id==='goal'),plan=state.agent?.extensionUI?.cards.find(card=>card.id==='plan');
    const workflowAction=prompt=>guard(async()=>{await api.extensionCommand({prompt});await refresh();});
    return [
      ...(hasCommand('/plan')?[{title:'查看计划',alias:'/plan status',description:'查看当前分支保存的计划',action:()=>workflowAction('/plan status')},{title:'执行已准备的计划',alias:'/plan execute',description:'确认后按当前权限执行',action:()=>workflowAction('/plan execute'),disabled:busy || plan?.status!=='ready'}]:[]),
      ...(hasCommand('/goal')?[{title:'查看持续目标',alias:'/goal status',description:'目标、预算与验收状态',action:()=>workflowAction('/goal status')},{title:'暂停持续目标',alias:'/goal pause',description:'暂停后续推进，当前一轮可以继续',action:()=>workflowAction('/goal pause'),disabled:!['active','checking'].includes(goal?.status)},{title:'恢复持续目标',alias:'/goal resume',description:'保留已用预算并继续',action:()=>workflowAction('/goal resume'),disabled:busy || !['paused','blocked'].includes(goal?.status)},{title:'清除持续目标',alias:'/goal clear',description:'清除当前目标，不撤销文件修改',action:()=>workflowAction('/goal clear'),disabled:!goal || goal.status==='idle'}]:[]),
      {title:'恢复会话',alias:'/resume',description:'选择当前项目中已保存的会话',action:()=>openPalette('会话 ·'),disabled:!state.project || busy},
      {title:'重命名当前会话',alias:'/name',description:'修改左侧列表中的会话名称',action:()=>openRename(state.sessions.find(s=>s.active)),disabled:!hasSession || busy},
      {title:'选择模型',alias:'/model',description:'选择已经配置的模型',action:()=>openPalette('模型 ·'),disabled:busy},
      {title:'配置模型密钥',alias:'/login',description:'打开桌面密钥管理',action:()=>openSettings('key')},
      {title:'查看会话信息',alias:'/session',description:'消息数量、上下文与 token 统计',action:sessionInfo,disabled:!hasSession},
      {title:'浏览会话历史',alias:'/tree',description:'查看历史节点，选择位置继续',action:historyTree,disabled:!hasSession || busy},
      {title:'压缩上下文',alias:'/compact',description:'用当前模型生成摘要，保留原始历史',action:openCompact,disabled:!hasSession || busy},
      {title:'复制最近一条回答',alias:'/copy',description:'复制当前分支最后一条模型消息',action:()=>guard(async()=>{const info=await api.sessionInfo();if(!info.lastAssistantText.trim())throw new Error('当前会话还没有可复制的回答');await api.copyText({text:info.lastAssistantText});toast('回答已复制');}),disabled:!hasSession || busy},
      {title:'导出当前会话',alias:'/export',description:'将当前分支保存为 HTML 网页',action:()=>guard(async()=>{const result=await api.exportSession();if(!result.cancelled)toast('会话已导出：'+result.path);}),disabled:!hasSession || busy},
      {title:'重新加载 Pi 资源',alias:'/reload',description:'重新加载已启用的插件、技能、模板和项目指令',action:()=>switchView(async()=>{await api.reloadResources();const next=await api.state();toast('Pi 资源已重新加载');return next;}),disabled:busy},
      {title:'查看快捷键',alias:'/hotkeys',description:'桌面客户端的键盘操作',action:hotkeys},
      ...(state.piCommands || []).filter(c=>!['new','settings','resume','name','model','login','session','tree','compact','copy','export','reload','hotkeys'].includes(c.name)).map(c=>({title:c.description,alias:c.command,description:c.argumentHint || 'Pi 内置指令',action:()=>guard(()=>execute(c.command)),disabled:busy && !['changelog','hotkeys'].includes(c.name) || (!hasSession && ['thinking','fork','clone','share','bug'].includes(c.name)) || (!state.project && ['import','trust'].includes(c.name))})),
      ...(state.agent?.commands || []).map(item=>({title:`${{extension:'插件命令',skill:'技能',prompt:'提示模板'}[item.source]} · ${item.command}`,alias:item.command,description:item.description+' · 填入输入框后发送',action:()=>preparePrompt(item.command),disabled:busy})),
    ];
  }
  return {options,isBuiltin,execute};
}
