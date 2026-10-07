import assert from 'node:assert/strict';
import {presetModelProvider} from './provider-presets.mjs';

export async function verifyModelCatalog({window,actions,js,until,snapshot,nativeDropdown}) {
  const first=await actions.state(),configured=new Set(first.models.map(m=>m.key));
  const expected=first.presets.reduce((count,p)=>count+p.models.filter(m=>!configured.has(presetModelProvider(p,m).id+'/'+m.id)).length,first.models.length);
  assert.equal(await js("document.getElementById('model-select').options.length"),expected,'composer contains the full provider directory plus configured models');
  assert.equal(await js("document.querySelectorAll('#model-select optgroup').length"),11,'all providers can be browsed before adding models');
  assert(await js("Array.from(document.getElementById('model-select').options).filter(o=>o.dataset.presetId==='openai').some(o=>o.dataset.modelId==='gpt-6.1-sol')"),'latest official model is in the chat dropdown');
  await js("if(document.getElementById('settings-dialog').open)document.getElementById('close-settings').click()");
  await nativeDropdown('#model-select','desktop-model-directory-dropdown.png',{choose:'catalog:'+JSON.stringify(['openai','gpt-6.1-sol'])});
  await until(()=>js("document.getElementById('settings-dialog').open && document.getElementById('preset-model').value==='gpt-6.1-sol'"),'unconfigured selection prepares the correct model');
  assert.equal((await actions.state()).selectedModel,first.selectedModel,'browsing an unconfigured model does not change the conversation');
  assert.equal((await actions.state()).models.length,first.models.length,'opening the catalogue does not register all models');
  assert(await js("document.getElementById('preset-context').value==='1050000' && document.getElementById('preset-output').value==='128000' && document.getElementById('preset-context').readOnly"),'new OpenAI capacities match official model documentation');
  await js("document.querySelector('.preset-card[data-id=zhipu]').click();document.getElementById('preset-model-search').value='glm-4.7';document.getElementById('preset-model-search').dispatchEvent(new Event('input'))");
  assert.deepEqual(await js("Array.from(document.getElementById('preset-model-options').options).filter(o=>o.value).map(o=>o.value).sort()"),['glm-4.7','glm-4.7-flash','glm-4.7-flashx']);
  await nativeDropdown('#preset-model-options','desktop-model-directory-search.png',{choose:'glm-4.7-flash',keyboard:true});
  assert(await js("document.getElementById('preset-model').value==='glm-4.7-flash' && document.getElementById('preset-output').value==='131072' && !document.getElementById('add-preset').disabled"),'native keyboard search selection retains the exact model id');
  await js("document.getElementById('preset-model-search').value='not-a-real-model';document.getElementById('preset-model-search').dispatchEvent(new Event('input'))");
  assert(await js("document.getElementById('preset-model-count').textContent.startsWith('匹配 0 / ') && Array.from(document.getElementById('preset-model-options').options).filter(o=>o.value).length===0"),'empty search does not display stale model options');
  await js("document.querySelector('.preset-card[data-id=openai]').click();document.getElementById('preset-model').value='text-embedding-3-large';document.getElementById('preset-model').dispatchEvent(new Event('input'))");
  assert(await js("document.getElementById('add-preset').disabled && Array.from(document.getElementById('preset-model-options').options).find(o=>o.value==='text-embedding-3-large').disabled"),'specialist models are listed but cannot be invoked as coding agents');
  await js("document.querySelector('.preset-card[data-id=opencode-go]').click()");
  await nativeDropdown('#preset-model-options',undefined,{choose:'minimax-m3'});
  assert(await js("document.getElementById('preset-provider-id').value==='opencode-go-messages' && document.getElementById('preset-base-url').value==='https://opencode.ai/zen/go' && document.getElementById('preset-protocol').value==='Anthropic Messages'"),'Messages model updates its service identity and endpoint');
  await js("document.getElementById('preset-key').value='offline-directory-key';document.getElementById('preset-persist').checked=false;document.getElementById('preset-form').requestSubmit()");
  await until(()=>js("document.getElementById('model-select').value==='opencode-go-messages/minimax-m3' && !document.getElementById('send').disabled"),'Messages model is registered through the actual form');
  assert.equal((await actions.state()).providers.find(p=>p.id==='opencode-go-messages').protocol,'anthropic');
  await js("document.getElementById('close-settings').click()");
  await nativeDropdown('#model-select',undefined,{choose:'catalog:'+JSON.stringify(['opencode-go','gpt-6-luna'])});
  await until(()=>js("document.getElementById('settings-dialog').open && document.getElementById('preset-model').value==='gpt-6-luna'"),'Responses model opens its own configuration');
  assert(await js("document.getElementById('preset-provider-id').value==='opencode-go-responses' && document.getElementById('preset-protocol').value==='OpenAI Responses'"),'Responses selection does not reuse the Messages protocol');
  await js("document.getElementById('preset-persist').checked=false;document.getElementById('preset-form').requestSubmit()");
  await until(()=>js("document.getElementById('model-select').value==='opencode-go-responses/gpt-6-luna' && !document.getElementById('send').disabled"),'Responses model registration completes');
  const registered=await actions.state();assert.equal(registered.providers.find(p=>p.id==='opencode-go-responses').protocol,'openai-responses');assert.equal(registered.models.length,first.models.length+2,'only the two chosen models are registered');
  await js("document.getElementById('close-settings').click();document.getElementById('model-select').options[0].dataset.stableDirectory='yes';document.getElementById('mode-select').value='plan';document.getElementById('mode-select').dispatchEvent(new Event('change'))");
  await until(()=>js("document.getElementById('mode-select').value==='plan' && !document.getElementById('send').disabled"),'mode change settles');
  assert.equal(await js("document.getElementById('model-select').options[0].dataset.stableDirectory"),'yes','state changes reuse the large catalogue DOM');
  await js("document.getElementById('mode-select').value='build';document.getElementById('mode-select').dispatchEvent(new Event('change'))");
  await until(()=>js("document.getElementById('mode-select').value==='build' && !document.getElementById('send').disabled"),'restore execution mode');
  const size=window.getSize(),theme=await js('document.documentElement.dataset.theme');
  try {
    await js("document.getElementById('model-settings').click();document.querySelector('.preset-card[data-id=opencode-go]').click();document.getElementById('preset-model-search').value='gpt';document.getElementById('preset-model-search').dispatchEvent(new Event('input'))");
    for(const value of ['light','dark']){await js(`document.documentElement.dataset.theme=${JSON.stringify(value)}`);await snapshot('desktop-model-directory-'+value+'.png');}
    window.setSize(1000,700);window.webContents.setZoomFactor(1.25);await snapshot('desktop-model-directory-narrow.png');
    assert(await js("document.documentElement.scrollWidth<=innerWidth && document.getElementById('preset-model-search').getBoundingClientRect().right<=innerWidth"),'search and model fields fit the narrow zoomed window');
    await nativeDropdown('#preset-model-options','desktop-model-directory-narrow-dropdown.png');
  } finally {window.webContents.setZoomFactor(1);window.setSize(...size);await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.getElementById('close-settings').click();document.getElementById('model-select').value=${JSON.stringify(first.selectedModel)};document.getElementById('model-select').dispatchEvent(new Event('change'))`);await until(()=>js("!document.getElementById('send').disabled"),'restore original model');}
  return ['chat dropdown lists all eleven official directories','unconfigured catalogue browsing preserves conversation and configuration','native model search and empty results preserve exact IDs','specialist models remain listed and cannot run as coding agents','native form registers Messages models with their correct endpoint','Responses registration remains separate and loads only selected models','state changes preserve the large directory DOM','model search and grouped dropdowns fit light dark narrow and zoomed layouts'];
}
