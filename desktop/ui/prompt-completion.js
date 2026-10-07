export function setupPromptCompletion({api,input,popup,list,help,getIdentity,onChange}) {
  let items=[],index=0,generation=0,timer,composing=false,dismissed,context;
  input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',list.id);input.setAttribute('aria-expanded','false');
  function close() {clearTimeout(timer);generation++;popup.hidden=true;items=[];context=undefined;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
  function snapshot() {return {text:input.value,cursor:input.selectionStart,identity:getIdentity()};}
  const same=value=>value.text===input.value && value.cursor===input.selectionStart && value.identity===getIdentity();
  function render() {
    list.replaceChildren(...items.map((item,i)=>{
      const row=document.createElement('div');row.id=`prompt-option-${i}`;row.className='prompt-option';row.setAttribute('role','option');row.setAttribute('aria-selected',String(i===index));row.dataset.value=item.value;
      const title=document.createElement('span'),description=document.createElement('small');title.textContent=(context?.prefix.startsWith('/')?'/':'')+item.label;description.textContent=item.description || '';row.append(title,description);
      row.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();index=i;void accept();};return row;
    }));
    input.setAttribute('aria-activedescendant',`prompt-option-${index}`);list.children[index]?.scrollIntoView({block:'nearest'});
  }
  async function request(force=false) {
    if(composing || input.disabled || document.activeElement!==input || input.selectionStart!==input.selectionEnd){close();return;}
    const value=snapshot();if(!force && dismissed===JSON.stringify(value))return;
    const line=value.text.slice(0,value.cursor).split('\n').at(-1);if(!line.trimStart().startsWith('/')){close();return;}
    const ticket=++generation;
    try {
      const result=await api.completePrompt({text:value.text,cursor:value.cursor});
      if(ticket!==generation || !same(value) || composing || document.activeElement!==input)return;
      if(!result?.items.length){close();return;}
      items=result.items;index=0;context={...value,prefix:result.prefix};popup.hidden=false;input.setAttribute('aria-expanded','true');help.textContent='↑ ↓ 选择 · Tab / Enter 补全 · Esc 关闭';render();
    } catch {if(ticket===generation)close();}
  }
  function update() {dismissed=undefined;close();if(!composing){timer=setTimeout(()=>void request(),70);}}
  async function accept() {
    const owner=context,item=items[index];if(!owner || !item || !same(owner)){close();return;}
    close();const ticket=generation;
    try {
      const result=await api.completePrompt({text:owner.text,cursor:owner.cursor,item});
      if(ticket!==generation || !result || !same(owner) || composing)return;
      input.value=result.text;input.setSelectionRange(result.cursor,result.cursor);onChange();input.focus();dismissed=JSON.stringify(snapshot());
    } catch {close();}
  }
  function keydown(event) {
    if(event.isComposing || composing || event.keyCode===229)return false;
    if(!popup.hidden && items.length) {
      if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();index=(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;render();return true;}
      if(event.key==='Escape'){event.preventDefault();dismissed=JSON.stringify(snapshot());close();return true;}
      if((event.key==='Tab' && !event.shiftKey) || (event.key==='Enter' && !event.shiftKey)){event.preventDefault();void accept();return true;}
    }
    if(event.key==='Tab' && !event.shiftKey && input.value.slice(0,input.selectionStart).split('\n').at(-1).trimStart().startsWith('/')){event.preventDefault();dismissed=undefined;void request(true);return true;}
    return false;
  }
  input.addEventListener('compositionstart',()=>{composing=true;close();});input.addEventListener('compositionend',()=>{composing=false;update();});
  input.addEventListener('keyup',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key))update();});
  input.addEventListener('click',()=>update());input.addEventListener('focus',()=>update());input.addEventListener('blur',close);
  document.addEventListener('pointerdown',event=>{if(!popup.contains(event.target) && event.target!==input)close();});
  return {keydown,update,close};
}
