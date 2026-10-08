import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function verifyPiInput({window,actions,js,until,snapshot}) {
  const initial=await actions.state(),identity=initial.agent.sessionId;
  const input=async text=>js(`document.getElementById('prompt').focus();document.getElementById('prompt').value=${JSON.stringify(text)};document.getElementById('prompt').dispatchEvent(new InputEvent('input'));`);
  const shown=()=>js("!document.getElementById('prompt-completion').hidden");
  const press=async(key,character,modifiers=[])=>{
    window.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers});if(character)window.webContents.sendInputEvent({type:'char',keyCode:character,modifiers});window.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers});
  };
  const command=async text=>{await input(text);await js("document.getElementById('send').click()");};
  window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  try {
    await input('/');await until(shown,'slash opens native command suggestions');
    const catalogue=(await actions.state()).piCommands;assert.equal(catalogue.length,24);assert(await js(`${JSON.stringify(catalogue.map(c=>c.name))}.every(value=>Array.from(document.querySelectorAll('#prompt-options [role=option]')).some(row=>row.dataset.value===value))`),'all native built-ins complete in chat');
    assert(await js("document.activeElement.id==='prompt' && document.getElementById('prompt').getAttribute('aria-expanded')==='true' && document.getElementById(document.getElementById('prompt').getAttribute('aria-activedescendant'))?.getAttribute('aria-selected')==='true'"),'completion preserves input focus and active option');
    await snapshot('desktop-pi-input-light.png');
    await js("document.getElementById('theme-toggle').click()");await until(()=>js("document.documentElement.dataset.theme==='dark'"),'completion dark theme');await input('/');await until(shown,'dark completion');await snapshot('desktop-pi-input-dark.png');
    window.setSize(1050,700);window.webContents.setZoomFactor(1.25);await input('/');await until(shown,'zoomed completion');await snapshot('desktop-pi-input-narrow.png');
    assert(await js("const r=document.getElementById('prompt-completion').getBoundingClientRect();r.left>=0 && r.right<=innerWidth+1 && r.top>=0 && r.bottom<=innerHeight"),'completion fits narrow zoomed window');
    window.webContents.setZoomFactor(1);window.setSize(1450,930);await js("document.getElementById('theme-toggle').click()");await until(()=>js("document.documentElement.dataset.theme==='light'"),'completion theme restored');
    await input('/mod');await until(shown,'native fuzzy model suggestions');await press('Tab');await until(()=>js("document.getElementById('prompt').value==='/model '"),'native Tab completes command without sending');assert.equal((await actions.state()).agent.busy,false);
    await input('/model offline');await until(shown,'native model argument suggestions');await press('Return','\r');await until(()=>js("document.getElementById('prompt').value==='/model demo/offline'"),'Enter completes model argument');await press('Return','\r');await until(()=>js("document.getElementById('prompt').value==='' && !document.getElementById('send').disabled"),'second Enter executes builtin');assert.equal((await actions.state()).selectedModel,'demo/offline');
    await input('/session');await until(shown,'session completion');await press('Escape');await until(async()=>!(await shown()),'Escape closes completion');assert.equal(await js("document.getElementById('prompt').value"),'/session');await press('Return','\r');await until(()=>js("document.getElementById('pi-details-dialog').open && document.getElementById('pi-details-body').textContent.includes('会话 ID')"),'typed session executes host operation');await js("document.getElementById('close-pi-details').click()");
    await input('/mod');await until(shown,'suggestion before IME');await js("document.getElementById('prompt').dispatchEvent(new CompositionEvent('compositionstart'));document.getElementById('prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));");assert.equal(await shown(),false);assert.equal((await actions.state()).agent.busy,false);await js("document.getElementById('prompt').dispatchEvent(new CompositionEvent('compositionend')); ");await until(shown,'completion resumes after IME');
    await press('Return','\r',['shift']);await until(()=>js("document.getElementById('prompt').value.includes(String.fromCharCode(10)) && document.getElementById('prompt-completion').hidden"),'Shift Enter inserts newline without accepting suggestion');
    await input('/desktop-fixture sta');await until(()=>js("document.querySelector('#prompt-options [data-value=staging]')!==null"),'asynchronous extension argument completion');await press('Tab');await until(()=>js("document.getElementById('prompt').value==='/desktop-fixture staging'"),'plugin argument accepts native completion');
    await input('/skill:project-review');await until(shown,'skill completion');await input('普通任务');await until(async()=>!(await shown()),'ordinary input closes candidates');
    await command('/thinking off');await until(async()=> (await actions.state()).agent.thinkingLevel==='off','typed thinking matches model capability');
    await command('/thinking high');await until(()=>js("!document.getElementById('operation-error').hidden && document.getElementById('prompt').value==='/thinking high'"),'invalid thinking retains command and shows capability error');await input('');
    for(const name of ['scoped-models','trust','logout','share','bug','changelog']) {await command('/'+name);await until(()=>js("document.getElementById('pi-details-dialog').open"),'typed /'+name+' opens desktop flow');assert.equal((await actions.state()).agent.busy,false);if(name==='bug')assert(await js("Array.from(document.querySelectorAll('[data-report]')).every(input=>!input.checked)"),'bug report does not include transcript or use model by default');await js("document.getElementById('close-pi-details').click()");}
    assert.equal((await actions.state()).agent.sessionId,identity);assert.equal((await actions.history()).entries.filter(e=>e.data.kind==='message').length,0,'builtin chat commands never enter model transcript');
    await input('');
  } finally {await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});window.webContents.debugger.detach();}
}

export async function verifyPiExpandedActions({actions,js,until,project}) {
  const {dialog}=await import('electron'),initial=await actions.state(),sessionId=initial.agent.sessionId,workspace=initial.project;
  const input=async text=>js(`document.getElementById('prompt').value=${JSON.stringify(text)};document.getElementById('prompt').dispatchEvent(new InputEvent('input'));document.getElementById('send').click();`);
  const oldSave=dialog.showSaveDialog,oldOpen=dialog.showOpenDialog;
  try {
    await input('/name 聊天指令验收');await until(async()=> (await actions.state()).sessions.find(s=>s.active)?.title==='聊天指令验收','typed name takes direct arguments');await until(()=>js("!document.getElementById('send').disabled"),'typed name UI idle');await input('/name '+initial.sessions.find(s=>s.active).title);await until(()=>js("!document.getElementById('send').disabled"),'name restored');
    await input('/clone');await until(async()=> (await actions.state()).agent.sessionId!==sessionId,'typed clone creates independent session');await until(()=>js("!document.getElementById('send').disabled"),'cloned UI ready');

    // Resume by the exact project/id, then let the renderer synchronize through /reload.
    await actions.resume({id:sessionId,path:workspace});await input('/reload');await until(async()=> (await actions.state()).agent.sessionId===sessionId,'original retained after clone');await until(()=>js("!document.getElementById('send').disabled"),'original UI ready');
    const jsonl=resolve(project,'.agent/verification/pi-native-session.jsonl');dialog.showSaveDialog=async()=>({canceled:false,filePath:jsonl});await input('/export session.jsonl');await until(()=>js("document.getElementById('toast').textContent.includes('会话已导出：') && !document.getElementById('send').disabled"),'chat JSONL export');assert.equal(JSON.parse((await readFile(jsonl,'utf8')).split('\n')[0]).type,'session');
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[jsonl]});await input('/import');await until(async()=> (await actions.state()).agent.sessionId!==sessionId,'native JSONL import selects new session');await until(()=>js("!document.getElementById('send').disabled"),'import UI ready');
    await actions.resume({id:sessionId,path:workspace});await input('/reload');await until(()=>js("!document.getElementById('send').disabled"),'resume original after import');
    const zip=resolve(project,'.agent/verification/pi-bug-report.zip');dialog.showSaveDialog=async()=>({canceled:false,filePath:zip});await input('/bug 离线桌面验收');await until(()=>js("document.getElementById('pi-details-dialog').open"),'bug report options');await js("document.querySelector('[data-delivery=zip]').click()");await until(()=>js("document.querySelector('#pi-details-body [role=status]')?.textContent.startsWith('已保存：')"),'native bug ZIP');assert.equal((await readFile(zip)).subarray(0,2).toString(),'PK');await js("document.getElementById('close-pi-details').click()");
  } finally {dialog.showSaveDialog=oldSave;dialog.showOpenDialog=oldOpen;}
}
