export function setupResources({api,$,node,state,guard,switchView,toast,isBusy}) {
  let data = {items:[],diagnostics:[]}, selected, removing, mutation = false, previewed;
  let category = 'extensions'; const choices = {}, searches = {};
  let mode = 'installed', marketItems = [], marketSelected, marketTicket = 0, marketLoaded = false;
  const modes = ['installed','market','custom'];
  function selectMode(next) {
    if(mutation) return;
    mode = next;
    for(const name of modes) { const tab = $(`resource-mode-${name}`);tab.setAttribute('aria-selected',String(name === mode));tab.tabIndex = name === mode ? 0 : -1;$(`resource-${name}`).hidden = name !== mode; }
    if(mode === 'market' && !marketLoaded) void searchMarket();
  }
  async function searchMarket() {
    const ticket = ++marketTicket;marketSelected = undefined;marketItems = [];renderMarket();
    $('resource-market-status').textContent = '正在搜索社区包…';
    $('resources-error').hidden = true;
    await guard(async () => {try {const result = await api.searchResourceMarket({query:$('resource-market-query').value});if(ticket !== marketTicket) return;marketLoaded = true;marketItems = result.items;$('resource-market-status').textContent = marketItems.length ? `显示 ${marketItems.length} 个结果 · 来源 npm` : '没有找到匹配的 Pi 包，可修改搜索或在自定义页添加来源。';renderMarket();}
    catch(error) {if(ticket !== marketTicket) return;$('resource-market-status').textContent = '读取失败，修改搜索后可重试。';throw error;}});
  }
  function renderMarket() {
    $('resource-market-list').replaceChildren(...marketItems.map(item => {
      const button = node('button','market-row resource-row'+(marketSelected?.name === item.name ? ' selected' : ''));
      button.append(node('strong','',item.name),node('span','',`${item.version} · ${item.publisher || '社区作者'}`),node('span','',item.description || '暂无说明'));
      button.onclick = () => {const ticket = ++marketTicket;marketSelected = item;renderMarket();$('resource-market-detail').replaceChildren(node('p','panel-empty','正在读取包信息…'));void guard(async () => {try {const detail = await api.resourceMarketDetail({name:item.name,version:item.version});if(ticket !== marketTicket) return;renderMarketDetail(detail);} catch(error) {if(ticket === marketTicket) $('resource-market-detail').replaceChildren(node('p','panel-empty','读取失败，请重新选择此包。'));throw error;}});};
      button.disabled = mutation;return button;
    }));
    if(!marketSelected) $('resource-market-detail').replaceChildren(node('p','panel-empty','选择包，查看版本和来源。'));
  }
  function renderMarketDetail(item) {
    const container = $('resource-market-detail');container.replaceChildren(node('h3','',item.name),node('p','resource-description',item.description || '暂无说明'));
    const meta = node('dl','resource-meta');
    for(const [label,value] of [['版本',item.version],['来源',item.source],['类型',item.types.length ? item.types.map(t => labels[t]).join('、') : '未声明，安装后识别'],['许可',item.license || '未声明']]) meta.append(node('dt','',label),node('dd','',value));container.append(meta);
    if(item.peers.length) container.append(node('p','resource-note','兼容依赖：'+item.peers.join('；')));
    container.append(node('p','resource-note','社区包未经本客户端兼容验证。安装会下载包及依赖，关闭安装脚本；资源默认停用。启用扩展后会运行本机代码，部分终端界面功能暂不支持。'));
    const actions = node('div','resource-detail-actions');
    const info = node('button','quiet-button','说明与源码 ↗');info.onclick = () => guard(() => api.openLink({url:item.registryUrl}));actions.append(info);
    const install = node('button','send-button','安装此版本');install.disabled = isBusy() || mutation;install.onclick = () => change(() => api.addResource({source:item.source,scope:scope()}),'正在安装选定版本…');actions.append(install);container.append(actions);
  }
  const labels = {extensions:'扩展',skills:'技能',prompts:'提示模板',themes:'终端主题',sources:'来源'};
  const notes = {extensions:'添加工具、斜杠命令和事件处理。',skills:'为特定任务提供操作方法与参考资料。',prompts:'保存可重复使用的提示模板。',themes:'Pi 终端的配色主题，不改变桌面的明暗外观。',sources:'无法读取的资源来源，可查看路径并移除失效引用。'};
  function selectCategory(type) {
    if(mutation || !Object.hasOwn(labels,type)) return;
    searches[category] = $('resource-search').value; choices[category] = selected;
    category = type; selected = choices[type]; removing = undefined;
    $('resource-search').value = searches[type] || ''; render();
  }
  const status = item => item.error ? '来源不可用' : !item.enabled ? '已停用' : item.loadState === 'error' ? '加载失败' : item.loadState === 'pending' ? '已启用 · 打开项目后加载' : '已启用';
  const scope = () => $('resource-scope').value;
  async function refresh() { data = await api.listResources(); render(); }
  function progress(text = '') { $('resource-progress').textContent = text; document.querySelector('.resource-layout').setAttribute('aria-busy', String(Boolean(text))); }
  async function open() {
    $('resources-error').hidden = true; $('resource-scope').value = state()?.project ? 'project' : 'global';
    $('resources-dialog').showModal(); selectMode('installed'); $('resource-search').focus(); progress('正在读取资源…');
    try { await guard(refresh); } finally { if(!mutation) progress(); }
  }
  function render() {
    $('resources-runtime').textContent = `${data.runtime} · 工具、命令、事件与 skill`;
    if(category === 'sources' && !data.items.some(i => i.type === 'sources')) {category = 'extensions';selected = choices[category];$('resource-search').value = searches[category] || '';}
    for(const type of Object.keys(labels)) {const tab = $(`resource-tab-${type}`), count = data.items.filter(i => i.type === type).length;tab.querySelector('.resource-count').textContent = count;tab.hidden = type === 'sources' && !count;tab.setAttribute('aria-selected',String(type === category));tab.tabIndex = type === category ? 0 : -1;}
    $('resource-panel').setAttribute('aria-labelledby',`resource-tab-${category}`);
    $('resource-category-note').textContent = notes[category];$('resource-add-heading').textContent = `添加${labels[category]}`;$('resource-add').hidden = false;
    $('resource-add-shortcut').textContent = `添加${labels[category]}…`;$('resource-add-shortcut').hidden = category === 'sources';
    $('choose-extension').hidden = category !== 'extensions';$('choose-skill').textContent = category === 'skills' ? '选择 skill / 包目录' : '选择 Pi 包目录';
    $('resource-search').placeholder = `搜索${labels[category]}名称或来源`;$('resource-search').setAttribute('aria-label',`搜索${labels[category]}`);
    const query = $('resource-search').value.trim().toLowerCase();searches[category] = $('resource-search').value;
    const items = data.items.filter(i => i.type === category && `${i.name} ${i.description || ''} ${i.source}`.toLowerCase().includes(query));
    const focused = document.activeElement.closest('.resource-row')?.dataset.id;
    if(!items.some(i => i.id === selected)) { selected = items[0]?.id; removing = undefined; }
    choices[category] = selected;
    $('resource-list').replaceChildren(...items.map(item => {
      const button = node('button','resource-row'+(item.id === selected ? ' selected' : '')); button.dataset.id = item.id;
      button.append(node('strong','',item.name),node('span','',`${labels[item.type]} · ${status(item)}`));
      button.title = item.path; button.setAttribute('aria-pressed',String(item.id === selected));
      button.onclick = () => {selected = item.id; removing = undefined; render(); $('resource-list').querySelector(`[data-id="${item.id}"]`)?.focus({preventScroll:true});}; return button;
    }));
    if(!items.length) $('resource-list').append(node('p','panel-empty',query ? `没有匹配的${labels[category]}` : `尚无${labels[category]}。可前往市场寻找，或在自定义页添加。`));
    $('resource-diagnostics').replaceChildren(...data.diagnostics.map(d => node('p','',`${d.message}${d.path ? ' · '+d.path : ''}`)));
    $('resource-diagnostics').hidden = !data.diagnostics.length;
    renderDetail();
    if(focused) $('resource-list').querySelector(`[data-id="${focused}"]`)?.focus({preventScroll:true});
  }
  function renderDetail() {
    const container = $('resource-detail'); container.replaceChildren(); const item = data.items.find(i => i.id === selected);
    if(!item) {container.append(node('p','panel-empty','选择资源，查看说明与启用状态。')); return;}
    container.append(node('h3','',item.name),node('p','resource-description',item.description || labels[item.type]));
    const meta = node('dl','resource-meta');
    for (const [name,value] of [['来源',item.source],['范围',item.scope === 'project' ? '当前项目' : '桌面通用'],['路径',item.path],['状态',status(item)]]) meta.append(node('dt','',name),node('dd','',value));
    container.append(meta);
    if(item.type === 'extensions') container.append(node('p','resource-note','扩展可执行本机代码。桌面支持工具、事件、斜杠命令和文字通知；交互选择框及自定义终端组件暂不支持。加载错误显示在窗口底部。'));
    if(item.type === 'themes') container.append(node('p','resource-note','这是 Pi 终端主题。可以加载供扩展读取，不会改变桌面的明暗主题。'));
    if(item.type === 'skills' && item.manualOnly) container.append(node('p','resource-note','此 skill 仅支持手动调用，不向模型自动展示。'));
    const actions = node('div','resource-detail-actions');
    const toggle = node('button','quiet-button',item.enabled ? '停用' : '启用'); toggle.onclick = () => change(() => api.toggleResource({id:item.id,enabled:!item.enabled,scope:item.scope === 'project' ? 'project' : scope()})); if(!item.error) actions.append(toggle);
    if(item.type === 'skills' && item.enabled) { const use = node('button','quiet-button','用于下一条任务'); use.onclick = () => {$('prompt').value = `/skill:${item.name} ${$('prompt').value}`; $('prompt').dispatchEvent(new Event('input')); $('resources-dialog').close(); $('prompt').focus();}; use.disabled = !state()?.project; actions.append(use); }
    const preview = node('button','quiet-button','查看源文件'); preview.onclick = () => guard(async () => {
      preview.disabled = true; preview.textContent = '正在读取…';
      try {
      const result = await api.previewResource({id:item.id}); if(selected !== item.id) return;
      previewed = {id:item.id,text:result.text}; container.querySelector('.resource-preview')?.remove(); const pre = node('pre','resource-preview',result.text); pre.tabIndex = 0; pre.setAttribute('aria-label','资源源文件'); container.append(pre);
      } finally { preview.textContent = '查看源文件'; preview.disabled = isBusy() || mutation; }
    }); if(!item.error) actions.append(preview);
    if(['skills','prompts'].includes(item.type)) {
      const copy = node('button','quiet-button','定制副本');copy.onclick = () => guard(async () => {
        const source = await api.previewResource({id:item.id});if(selected !== item.id || mutation) return;
        $('resource-create-type').value = item.type;$('resource-create-name').value = item.name.replace(/\.md$/,'').slice(0,57).replace(/-$/,'')+'-custom';
        $('resource-create-description').value = (item.description || '自定义提示模板').replace(/\s+/g,' ').slice(0,1024);
        $('resource-create-body').value = source.text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'');
        selectMode('custom');$('resource-create-name').focus();
      });actions.append(copy);
    }
    if(item.removable) { const remove = node('button','quiet-button danger-text','移除来源'); remove.onclick = () => {removing = item.sourceId; renderDetail(); container.querySelector('.resource-remove button')?.focus();}; actions.append(remove); }
    container.append(actions);
    if(previewed?.id === item.id) { const pre = node('pre','resource-preview',previewed.text); pre.tabIndex = 0; pre.setAttribute('aria-label','资源源文件'); container.append(pre); }
    if(removing === item.sourceId) {
      const confirmation = node('div','resource-remove'); confirmation.append(node('p','',`移除“${item.source}”及其所有资源的引用？源文件和下载缓存会保留。`));
      const cancel = node('button','quiet-button','取消'); cancel.onclick = () => {removing = undefined;renderDetail(); container.querySelector('.danger-text')?.focus();};
      const confirm = node('button','danger-button','确认移除'); confirm.onclick = () => change(() => api.removeResource({sourceId:item.sourceId})); confirmation.append(cancel,confirm); container.append(confirmation);
    }
    for(const button of container.querySelectorAll('button')) if(isBusy() || mutation) button.disabled = true;
  }
  async function change(operation, message = '正在重新加载资源…') {
    if(mutation) return; mutation = true; ++marketTicket;
    const previousIds = new Set(data.items.map(i => i.id));
    progress(message);
    const origin = document.activeElement;
    for(const field of document.querySelectorAll('#resource-form input,#resource-create-form input,#resource-create-form textarea,#resource-create-form select,#resource-market-query,#resource-scope')) field.disabled = true;
    for(const button of document.querySelectorAll('#resources-dialog button:not(#close-resources)')) button.disabled = true;
    try {
      let updated; const ok = await switchView(async () => {updated = await operation(); return api.state();});
      if(ok) {data = updated; const added = data.items.filter(i => !previousIds.has(i.id));if(added.length) {searches[category] = $('resource-search').value;choices[category] = selected;const item = added.find(i => i.type === category) || added[0];category = item.type;selected = item.id;$('resource-search').value = '';mode = 'installed';}
        removing = undefined; previewed = undefined; $('resource-add').open = false; render(); toast('已重新加载资源');}
    } finally {
      mutation = false; for(const button of document.querySelectorAll('#resources-dialog button')) button.disabled = false;
      for(const field of document.querySelectorAll('#resource-form input,#resource-create-form input,#resource-create-form textarea,#resource-create-form select,#resource-market-query,#resource-scope')) field.disabled = false;
      selectMode(mode);renderMarket();
      progress();
      renderDetail();
      if(isBusy()) for(const button of document.querySelectorAll('#resource-form button,#resource-create-form button,#reload-resources')) button.disabled = true;
      if(mode === 'installed' && $('resources-dialog').open && $('resources-error').hidden && (!origin.isConnected || origin.closest('#resource-form,#resource-detail,#resource-create-form,#resource-market-detail'))) $('resource-search').focus({preventScroll:true});
    }
  }
  $('resources-button').onclick = open; $('close-resources').onclick = () => $('resources-dialog').close();
  for(const name of modes) {const tab = $(`resource-mode-${name}`);tab.onclick = () => selectMode(name);tab.onkeydown = event => {
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || mutation) return;event.preventDefault();const index = modes.indexOf(name);const next = modes[event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3];selectMode(next);$(`resource-mode-${next}`).focus();
  };}
  $('resource-add-shortcut').onclick = () => {selectMode('custom');$('resource-add').open = true;$('resource-source').focus();};
  $('resource-market-form').onsubmit = event => {event.preventDefault();if(!mutation) void searchMarket();};
  $('resource-create-form').onsubmit = event => {event.preventDefault();void change(async () => {const result = await api.createResource({type:$('resource-create-type').value,name:$('resource-create-name').value,description:$('resource-create-description').value,body:$('resource-create-body').value,scope:scope()});$('resource-create-form').reset();return result;},'正在保存自定义资源…');};
  $('resource-search').oninput = render;
  for(const type of Object.keys(labels)) {const tab = $(`resource-tab-${type}`);tab.onclick = () => selectCategory(type);tab.onkeydown = event => {
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || mutation) return;event.preventDefault();const visible = Object.keys(labels).filter(t => !$(`resource-tab-${t}`).hidden), index = visible.indexOf(type);
    const next = visible[event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length];selectCategory(next);$(`resource-tab-${next}`).focus();
  };}
  $('resource-gallery').onclick = () => guard(() => api.openLink({url:'https://pi.dev/packages'}));
  $('reload-resources').onclick = () => change(() => api.reloadResources());
  $('choose-skill').onclick = () => change(() => api.chooseResource({kind:'directory',scope:scope()}));
  $('choose-extension').onclick = () => change(() => api.chooseResource({kind:'extension',scope:scope()}));
  $('resource-form').onsubmit = event => {event.preventDefault(); void change(async () => {const result = await api.addResource({source:$('resource-source').value,scope:scope()}); $('resource-source').value = ''; return result;}, '正在添加资源，包下载可能需要一些时间…');};
  return {open,refresh};
}
