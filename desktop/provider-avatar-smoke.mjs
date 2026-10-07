import assert from 'node:assert/strict';

export async function verifyProviderAvatars({window,actions,js,until,snapshot,nativeDropdown}) {
  await js("document.getElementById('model-select').value='deepseek/deepseek-flash';document.getElementById('model-select').dispatchEvent(new Event('change'))");
  await until(()=>js("document.querySelector('#model-select selectedcontent .provider-avatar[data-provider=deepseek] svg')?.getBBox().width>0 && !document.getElementById('send').disabled"),'selected model has a loaded local brand mark');
  assert(await js("document.querySelector('#model-select selectedcontent .provider-avatar').getAttribute('aria-hidden')==='true' && document.getElementById('model-select').selectedOptions[0].textContent==='DeepSeek · deepseek-flash'"),'provider icon is decorative and does not change the option label or model key');
  await snapshot('desktop-provider-avatar-composer.png');
  await nativeDropdown('#model-select','desktop-provider-avatar-dropdown.png');
  await js("document.getElementById('model-settings').click();document.getElementById('preset-settings-tab').click()");
  await until(()=>js("document.querySelectorAll('.preset-card .provider-avatar svg').length===11 && Array.from(document.querySelectorAll('.preset-card svg')).every(svg=>svg.getBBox().width>0)"),'all eleven local provider marks load');
  await snapshot('desktop-provider-avatar-presets.png');
  const first=await actions.state();
  for(const preset of first.presets) {
    await js(`document.querySelector('.preset-card[data-id=${JSON.stringify(preset.id)}]').click()`);
    assert(await js(`document.getElementById('preset-name').textContent===${JSON.stringify(preset.name)} && document.querySelector('#preset-name .provider-avatar svg').getBBox().width>0 && document.getElementById('preset-provider-id').value===${JSON.stringify(preset.provider.id)}`),'provider header and form identity stay aligned: '+preset.id);
    assert(await js("const h=document.getElementById('preset-name');const icon=h.firstElementChild.getBoundingClientRect(),label=h.lastElementChild.getBoundingClientRect();Math.abs(label.left-icon.right-9)<1"),'provider heading keeps avatar adjacent to its name: '+preset.id);
  }
  await js("document.querySelector('.preset-card[data-id=deepseek]').click();document.getElementById('key-settings-tab').click();document.getElementById('key-provider').value='deepseek';document.getElementById('key-provider').dispatchEvent(new Event('change'))");
  assert(await js("document.querySelector('#key-provider selectedcontent .provider-avatar[data-provider=deepseek]')!==null"),'key provider selection carries its own brand avatar');
  await js("document.getElementById('close-settings').click()");
  await js("document.getElementById('model-settings').click();document.getElementById('custom-settings-tab').click();const form=document.getElementById('model-form');form.elements.providerId.value='my_local_service';form.elements.modelId.value='custom-model';form.elements.baseUrl.value='http://127.0.0.1:65531/v1';form.elements.contextWindow.value=32000;form.elements.maxOutputTokens.value=1024;form.requestSubmit()");
  await until(()=>js("document.getElementById('model-select').value==='my_local_service/custom-model' && document.querySelector('#model-select selectedcontent .provider-avatar-fallback')?.dataset.initial==='M'"),'custom provider uses a readable local initial');
  assert(await js("document.getElementById('model-select').selectedOptions[0].textContent==='my_local_service · custom-model' && document.querySelector('#model-select selectedcontent .provider-avatar').textContent===''"),'fallback initial cannot contaminate titles or selected option labels');
  await js("if(document.getElementById('settings-dialog').open)document.getElementById('close-settings').click();document.getElementById('model-select').value='deepseek/deepseek-flash';document.getElementById('model-select').dispatchEvent(new Event('change'))");
  await until(()=>js("document.getElementById('model-select').value==='deepseek/deepseek-flash' && !document.getElementById('send').disabled"),'restore selected service');
  await js("document.getElementById('model-settings').click();document.getElementById('preset-settings-tab').click()");
  await until(()=>js("document.querySelector('#model-select selectedcontent .provider-avatar[data-provider=deepseek]')!==null"),'brand changes with the selected service');
  const dimensions=window.getSize();
  try {
    for(const theme of ['light','dark']) {
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await snapshot(`desktop-provider-avatar-${theme}.png`);
      assert(await js("Array.from(document.querySelectorAll('.preset-card .provider-avatar svg')).every(svg=>svg.getBBox().width>0)"),'marks remain visible in '+theme);
    }
    window.setSize(1000,700);window.webContents.setZoomFactor(1.25);
    await snapshot('desktop-provider-avatar-narrow.png');
    assert(await js("document.documentElement.scrollWidth<=innerWidth && Array.from(document.querySelectorAll('.preset-card')).every(n=>{const r=n.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth;})"),'provider cards fit the narrow zoomed window');
    await js("document.getElementById('close-settings').click()");
    assert(await js("const select=document.getElementById('model-select');const avatar=select.querySelector('selectedcontent .provider-avatar');const r=avatar.getBoundingClientRect(),s=select.getBoundingClientRect();r.width>=21 && r.left>=s.left && r.right<s.right-12"),'selected avatar keeps its size and leaves room for model text and dropdown arrow');
  } finally {window.webContents.setZoomFactor(1);window.setSize(...dimensions);await js("document.documentElement.dataset.theme='light'");}
  return ['selected model and native dropdown use loaded local brand avatars','all eleven provider presets and headers have their own marks','key provider selection has a decorative avatar','custom provider initial does not alter model labels or values','provider icons track selected service identity','provider cards and selected avatar fit light dark narrow and zoomed layouts'];
}
