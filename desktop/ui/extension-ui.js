import {renderMarkdown} from './markdown.js';

export function setupExtensionUI({api,node,guard,refresh,getState,isBusy,onMode,setDraft}) {
  const root=node('section','workflow-cards');root.id='workflow-cards';root.setAttribute('aria-label','计划与目标');root.hidden=true;
  document.querySelector('.composer-wrap').prepend(root);
  const statusRoot=node('div','extension-statuses');statusRoot.id='extension-statuses';root.after(statusRoot);
  const dialog=node('dialog','extension-dialog');dialog.id='extension-dialog';dialog.setAttribute('aria-labelledby','extension-dialog-heading');document.body.append(dialog);
  let ui={},identity,activeDialog,responding=false;const expanded=new Set();
  async function sendResponse(response) {if(responding || !activeDialog)return;responding=true;try {await guard(()=>api.extensionResponse({id:activeDialog.id,...response}));}finally{responding=false;}}
  dialog.addEventListener('cancel',event=>{event.preventDefault();void sendResponse({cancelled:true});});
  function renderDialog() {
    const request=ui.dialogs?.[0];
    if(!request){activeDialog=undefined;if(dialog.open)dialog.close();return;}
    if(activeDialog?.id===request.id)return;
    activeDialog=request;dialog.replaceChildren();
    const heading=node('h2','',request.title);heading.id='extension-dialog-heading';dialog.append(heading);
    const form=node('form','extension-dialog-form');let input;
    if(request.message)form.append(node('p','',request.message));
    if(request.method==='select') {
      const choices=node('div','extension-choices');
      for(const option of request.options){const button=node('button','quiet-button',option);button.type='button';button.onclick=()=>sendResponse({value:option});choices.append(button);}form.append(choices);
    } else if(['input','editor'].includes(request.method)) {
      input=node(request.method==='editor'?'textarea':'input','extension-input');input.setAttribute('aria-label',request.title);input.placeholder=request.placeholder || '';input.value=request.prefill || '';if(request.method==='editor')input.rows=8;form.append(input);
    }
    const footer=node('div','form-footer');const cancel=node('button','quiet-button','取消');cancel.type='button';cancel.onclick=()=>sendResponse({cancelled:true});footer.append(cancel);
    if(request.method!=='select'){const submit=node('button','send-button',request.method==='confirm'?'确认':'提交');submit.type='submit';footer.append(submit);}
    form.append(footer);form.onsubmit=event=>{event.preventDefault();void sendResponse(request.method==='confirm'?{confirmed:true}:{value:input.value});};dialog.append(form);
    if(!dialog.open)dialog.showModal();(input || cancel).focus();
  }
  function render() {
    const cards=(ui.cards || []).filter(card=>card.status!=='idle');root.hidden=!cards.length;
    root.replaceChildren(...cards.map(card=>{
      const item=node('article','workflow-card');item.dataset.workflow=card.id;
      const heading=node('div','workflow-heading');heading.append(node('strong','',card.title),node('span','workflow-state',card.statusText));item.append(heading);
      if(card.usage)item.append(node('p','workflow-budget',`${card.usage.rounds}/${card.usage.maxTurns} 轮 · ${card.usage.tokens.toLocaleString()}/${card.usage.budget.toLocaleString()} token · 验收 ${card.usage.evaluationTokens.toLocaleString()}`));
      const details=node('details','workflow-details');details.open=expanded.has(card.id);details.append(node('summary','',card.id==='plan'?'查看计划与验收条件':'查看目标'));
      details.ontoggle=()=>{details.open?expanded.add(card.id):expanded.delete(card.id);};
      if(card.id==='plan') {
        const body=node('div','workflow-body markdown');renderMarkdown(body,card.body || '正在探索项目…',text=>guard(()=>api.copyText({text})),url=>guard(()=>api.openLink({url})));details.append(body);
        if(card.steps?.length){details.append(node('strong','','实施步骤'));const list=node('ol','');for(const step of card.steps)list.append(node('li','',step));details.append(list);}
        if(card.acceptance?.length){details.append(node('strong','','验收条件'));const list=node('ul','');for(const condition of card.acceptance)list.append(node('li','',condition));details.append(list);}
      } else details.append(node('p','workflow-body',card.body));
      item.append(details);
      if(card.reason)item.append(node('p','workflow-reason',card.reason));
      const actions=node('div','workflow-actions');for(const action of card.actions || []) {
        const button=node('button','quiet-button',action.label);button.type='button';
        button.disabled=!!action.disabled || (isBusy() && !['/goal pause','/goal clear'].includes(action.command));
        button.onclick=()=>guard(async()=>{await api.extensionCommand({prompt:action.command});await refresh();});actions.append(button);
      }item.append(actions);return item;
    }));
    const lines=[...Object.entries(ui.statuses || {}).filter(([key])=>!key.startsWith('local-')).map(([,value])=>value),...Object.entries(ui.widgets || {}).filter(([key])=>!key.startsWith('local-')).flatMap(([,value])=>value.lines || [])];
    statusRoot.hidden=!lines.length;statusRoot.replaceChildren(...lines.map(line=>node('p','',line)));
    renderDialog();
  }
  return {
    update(next=getState()?.agent?.extensionUI,sessionId=getState()?.agent?.sessionId) {if(identity!==sessionId){identity=sessionId;expanded.clear();activeDialog=undefined;if(dialog.open)dialog.close();}ui=next || {};render();},
    event(event) {
      if(event.type==='extension_state'){ui=event.extensionUI;const mode=ui.cards?.find(c=>c.id==='plan')?.mode;if(mode)onMode(mode);render();return true;}
      if(event.type==='extension_ui_request'){ui={...ui,dialogs:[...(ui.dialogs || []).filter(d=>d.id!==event.request.id),event.request]};renderDialog();return true;}
      if(event.type==='extension_ui_closed'){ui={...ui,dialogs:(ui.dialogs || []).filter(d=>d.id!==event.id)};renderDialog();return true;}
      if(event.type==='extension_editor_text'){setDraft(event.text);return true;}return false;
    },
  };
}
