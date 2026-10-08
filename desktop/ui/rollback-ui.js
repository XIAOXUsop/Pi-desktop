export function setupRollback({api,node,getState,guard,refresh,loadHistory}) {
  const toolbar=node('div','rollback-toolbar');toolbar.id='rollback-toolbar';
  const select=node('select');select.id='checkpoint-select';select.setAttribute('aria-label','任务检查点');
  const preview=node('button','quiet-button','撤销文件修改'),pin=node('button','quiet-button','保留'),settings=node('button','quiet-button','保存设置'),undo=node('button','quiet-button','撤回撤销'),pending=node('div','rollback-toolbar'),coverage=node('small');
  preview.id='rollback-preview';undo.id='rollback-inverse';toolbar.append(select,preview,undo,pin,settings,coverage,pending);document.getElementById('changes-panel').prepend(toolbar);
  let rows=[],request=0,owner='',plan,runId,inverse=false;
  const identity=()=>getState()?.project+':'+getState()?.agent?.sessionId;
  const chosen=()=>rows.find(row=>row.runId===select.value);
  function update(){const row=chosen(),busy=!!getState()?.agent?.busy;preview.disabled=busy||!row||row.expired||rows[0]?.runId!==row.runId;pin.disabled=busy||!row||row.expired;pin.textContent=row?.pinned?'取消保留':'保留';settings.disabled=busy;
    coverage.textContent=row?.expired?'检查点已过期':row?.coverage==='partial'?'部分文件可恢复':row?.coverage==='scoped'?'已保存文件范围':'暂无检查点';
    const ops=row?.operations||[],last=ops.filter(op=>op.state==='committed'&&!op.reversedBy).sort((a,b)=>b.createdAt-a.createdAt)[0];undo.hidden=!last;undo.disabled=preview.disabled;undo.dataset.operation=last?.operationId||'';
    pending.replaceChildren();for(const op of ops.filter(op=>['prepared','applying'].includes(op.state))){pending.append(node('small','','有未完成的撤销'));for(const [mode,label]of [['complete','继续撤销'],['restore','恢复撤销前内容']]){const button=node('button','quiet-button',label);button.disabled=busy;button.onclick=()=>guard(async()=>{await api.resumeRollback({runId:row.runId,operationId:op.operationId,mode});await reload();await refresh();await loadHistory();});pending.append(button);}}
  }
  async function reload(){const sequence=++request,key=identity();rows=await api.listCheckpoints();if(sequence!==request||key!==identity())return;const previous=select.value;const button=node('button');button.type='button';button.append(node('selectedcontent'));select.replaceChildren(button,...rows.map(row=>{const option=node('option','',new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(row.createdAt)+' · '+row.files+' 个文件');option.value=row.runId;return option;}));if(rows.some(row=>row.runId===previous))select.value=previous;update();}
  select.onchange=update;
  pin.onclick=()=>guard(async()=>{await api.pinCheckpoint({runId:chosen().runId,pinned:!chosen().pinned});await reload();});
  const dialog=node('dialog','reliability-dialog');dialog.id='rollback-dialog';dialog.setAttribute('aria-label','撤销文件预览');
  const heading=node('h2'),note=node('p'),list=node('div'),omissions=node('details'),cancel=node('button','quiet-button','取消'),confirm=node('button','send-button','确认撤销'),footer=node('div','form-footer');footer.append(cancel,confirm);dialog.append(heading,note,list,omissions,footer);document.body.append(dialog);
  function show(value){plan=value;list.replaceChildren();heading.textContent=inverse?'撤回上次撤销':'撤销文件修改';note.textContent=inverse?'恢复到上次撤销前的内容。文件若已再次修改，将停止恢复。':'按保存的原始内容恢复文件。命令或插件产生的改动需手动选择。';
    for(const row of value.rows){const label=node('label','rollback-file'),box=node('input');box.type='checkbox';box.checked=row.selected;box.disabled=!!row.conflict||inverse;box.dataset.path=row.path;label.append(box,node('span','',row.path+(row.source==='observed'?' · 命令/插件观察到的改动':'')+(row.conflict?' · '+row.conflict:'')));list.append(label);}
    omissions.replaceChildren(node('summary','', '未保存的内容 · '+(value.omissions?.length||0)),...((value.omissions||[]).map(o=>node('p','',o.path+' · '+o.reason))));omissions.hidden=!value.omissions?.length;confirm.textContent=inverse?'确认恢复':'确认撤销';confirm.disabled=!value.rows.some(r=>r.selected);for(const box of list.querySelectorAll('input'))box.onchange=()=>{confirm.disabled=!list.querySelector('input:checked');};dialog.showModal();
  }
  preview.onclick=()=>guard(async()=>{owner=identity();runId=chosen().runId;inverse=false;const value=await api.previewRollback({runId});if(owner===identity())show(value);});
  undo.onclick=()=>guard(async()=>{owner=identity();runId=chosen().runId;inverse=true;const value=await api.inverseRollback({runId,operationId:undo.dataset.operation});if(owner===identity())show(value);});
  cancel.onclick=()=>dialog.close();confirm.onclick=()=>guard(async()=>{if(owner!==identity())throw new Error('会话已切换，请重新预览');confirm.disabled=true;try{if(!inverse)plan=await api.previewRollback({runId,files:[...list.querySelectorAll('input:checked')].map(box=>box.dataset.path)});await api.applyRollback({runId,planId:plan.planId});dialog.close();await reload();await refresh();await loadHistory();}finally{confirm.disabled=false;}});
  const options=node('dialog','reliability-dialog');options.setAttribute('aria-label','检查点保存设置');options.append(node('h2','','检查点保存设置'),node('p','','默认排除密钥、依赖和构建产物。到达容量或保留数量后，清理未保留的旧检查点；正在运行的任务和未完成撤销会保留。'));
  const inputs={};for(const [key,label,unit]of [['maxFileBytes','单个文件（MiB）',1048576],['maxRunBytes','单次任务（MiB）',1048576],['maxStorageBytes','总容量（MiB）',1048576],['keepTasks','保留任务数量',1]]){const row=node('label','rollback-file'),input=node('input');input.type='number';input.min='1';input.step='1';inputs[key]={input,unit};row.append(node('span','',label),input);options.append(row);}
  const close=node('button','quiet-button','取消'),save=node('button','send-button','保存'),optionFooter=node('div','form-footer');optionFooter.append(close,save);options.append(optionFooter);document.body.append(options);close.onclick=()=>options.close();
  settings.onclick=()=>{const values={maxFileBytes:16777216,maxRunBytes:134217728,maxStorageBytes:536870912,keepTasks:20,...getState()?.checkpointLimits};for(const[key,{input,unit}]of Object.entries(inputs))input.value=values[key]/unit;options.showModal();};
  save.onclick=()=>guard(async()=>{await api.setCheckpointLimits(Object.fromEntries(Object.entries(inputs).map(([key,{input,unit}])=>[key,Number(input.value)*unit])));options.close();await refresh();await reload();});
  let listedOwner=identity();
  return {reload,update,changed(){if(listedOwner!==identity()){listedOwner=identity();request++;rows=[];select.replaceChildren();if(dialog.open)dialog.close();}update();if(owner&&owner!==identity()&&dialog.open)dialog.close();}};
}
