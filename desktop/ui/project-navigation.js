// Project disclosure is read-only and independent of the active conversation.
export function setupProjectNavigation({api,$,node,icon,getState,isBusy,switchView,createSessionRow}) {
  const branches=new Map(); let nextId=0,structure='',activeProject;
  const branchFor=path=>{if(!branches.has(path)) branches.set(path,{id:`project-browser-${++nextId}`,expanded:false,sessions:null,query:'',archived:false,loadedAt:0,pending:null,error:''}); return branches.get(path);};
  function remember(previous) {
    if(!previous?.project) return;
    const branch=branchFor(previous.project); branch.sessions=previous.sessions.map(session=>({...session,active:false})); branch.loadedAt=Date.now();
  }
  function renderBranch(path) {
    const state=getState(),branch=branchFor(path),active=path===state.project;
    const group=Array.from($('recent-projects').children).find(group=>group.dataset.project===path);
    if(!group) return;
    const arrow=group.querySelector('.project-disclosure'),panel=group.querySelector('.project-sessions');
    arrow.setAttribute('aria-expanded',String(branch.expanded)); arrow.setAttribute('aria-label',`${branch.expanded?'收起':'展开'} ${path.split(/[\\/]/).pop()} 的会话`); arrow.title=arrow.getAttribute('aria-label');
    panel.hidden=!branch.expanded;
    if(active) return;
    const signature=JSON.stringify([branch.sessions,branch.query,branch.archived,branch.error,!!branch.pending,isBusy()]);
    if(panel.dataset.content===signature) return;
    panel.dataset.content=signature;
    const label=node('div','sidebar-label sessions-label'),heading=node('span','','会话'); label.append(heading);
    const archive=node('button','icon-button'+(branch.archived?' active':'')); archive.append(icon('archive')); archive.setAttribute('aria-label',branch.archived?'返回当前会话':'显示归档会话'); archive.setAttribute('aria-pressed',String(branch.archived)); archive.title=archive.getAttribute('aria-label');
    archive.onclick=()=>{branch.archived=!branch.archived;renderBranch(path);}; label.append(archive);
    const search=node('label','sidebar-search'),input=node('input'); input.type='search';input.placeholder='搜索会话';input.setAttribute('aria-label',`搜索 ${path.split(/[\\/]/).pop()} 的会话`);input.value=branch.query;
    input.oninput=()=>{branch.query=input.value;renderBranch(path);const replacement=group.querySelector('.sidebar-search input');replacement.focus();replacement.setSelectionRange?.(branch.query.length,branch.query.length);}; search.append(icon('search'),input);
    const list=node('div','session-list');
    const matches=(branch.sessions||[]).filter(session=>session.archived===branch.archived && session.title.toLowerCase().includes(branch.query.trim().toLowerCase()));
    list.append(...matches.map(session=>createSessionRow({...session,active:false},path)));
    if(branch.error) {
      const error=node('div','project-browser-error'); error.setAttribute('role','status');error.append(node('p','',branch.error));
      const retry=node('button','quiet-button','重试');retry.onclick=()=>load(path);error.append(retry);list.prepend(error);
    }
    if(!matches.length && !branch.error) list.append(node('p','sidebar-empty',branch.sessions===null && branch.pending?'正在读取会话…':branch.query?'没有匹配的会话':branch.archived?'没有归档会话':'暂无会话'));
    panel.replaceChildren(label,search,list);
  }
  async function load(path) {
    const branch=branchFor(path); if(branch.pending) return branch.pending;
    branch.error='';
    const pending=api.listProjectSessions({path}).then(result=>{branch.sessions=result.sessions.map(session=>({...session,active:false}));branch.loadedAt=Date.now();},error=>{branch.error=error.message || '无法读取会话';});
    branch.pending=pending;renderBranch(path);
    try {await pending;} finally {branch.pending=null;renderBranch(path);}
  }
  function toggle(path,expanded=!branchFor(path).expanded) {
    const branch=branchFor(path);branch.expanded=expanded;renderBranch(path);
    if(expanded && path!==getState().project && (!branch.sessions || Date.now()-branch.loadedAt>5000)) void load(path);
  }
  function update() {
    const state=getState(); if(!state) return;
    const panel=$('project-sessions');
    if(activeProject!==state.project) {
      activeProject=state.project;if(activeProject) branchFor(activeProject).expanded=true;
      $('session-search').value='';
    }
    remember(state);
    const key=JSON.stringify([state.project,state.recentProjects]);
    if(structure!==key) {
      structure=key;
      const groups=state.recentProjects.map(path=>{
        const active=path===state.project,branch=branchFor(path),name=path.split(/[\\/]/).pop();
        const group=node('section','project-group'+(active?' current-project':''));group.dataset.project=path;
        const heading=node('div','project-heading-row'+(active?' selected':''));
        const project=node('button','recent-item'+(active?' selected':''));project.dataset.project=path;project.title=path;project.append(icon('folder'),node('span','project-name',name));
        project.setAttribute('aria-label',`切换项目 ${name}`);if(active) project.setAttribute('aria-current','true');
        project.onclick=()=>{if(path!==getState().project) void switchView(()=>api.openRecent({path}));};
        const arrow=node('button','project-disclosure icon-button');arrow.dataset.project=path;arrow.append(icon('chevron'));
        const child=active?panel:node('div','project-sessions project-session-browser');child.id=active?'project-sessions':branch.id;
        if(active) arrow.id='active-project-toggle';
        arrow.setAttribute('aria-controls',child.id);arrow.onclick=()=>toggle(path);
        arrow.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();toggle(path,event.key==='ArrowRight');}};
        heading.append(project,arrow);group.append(heading,child);return group;
      });
      if(!state.project){panel.hidden=true;groups.push(panel);}
      $('recent-projects').replaceChildren(...groups);
    }
    for(const path of state.recentProjects) {
      renderBranch(path);
      const branch=branchFor(path);if(path!==state.project && branch.expanded && !branch.sessions && !branch.pending && !branch.error) void load(path);
    }
    for(const button of document.querySelectorAll('.recent-item')) button.disabled=button.dataset.project!==state.project && isBusy();
  }
  async function refresh(path) {const branch=branchFor(path);branch.loadedAt=0;if(path!==getState().project && branch.expanded) await load(path);}
  return {update,remember,refresh};
}
