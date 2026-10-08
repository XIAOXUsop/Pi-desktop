export function setupRecovery({api,node,getState,guard,refresh,loadHistory,reviewChanges}) {
  const banner=node('div','recovery-card');banner.id='recovery-card';banner.hidden=true;
  const label=node('span'),resume=node('button','quiet-button','继续任务'),changes=node('button','quiet-button','查看改动'),diagnostic=node('button','quiet-button','导出诊断');
  banner.append(label,resume,changes,diagnostic);document.querySelector('.composer-wrap').prepend(banner);
  const dialog=node('dialog','reliability-dialog');dialog.setAttribute('aria-label','恢复任务');
  const heading=node('h2','', '继续上次任务'),description=node('p'),tools=node('ul'),confirmation=node('label','check-label'),checkbox=node('input');checkbox.type='checkbox';
  confirmation.append(checkbox,document.createTextNode('已核实这些工具的实际结果，未完成命令已停止'));
  const cancel=node('button','quiet-button','取消'),accept=node('button','send-button','继续任务'),footer=node('div','form-footer');footer.append(cancel,accept);dialog.append(heading,description,tools,confirmation,footer);document.body.append(dialog);
  let selected;
  const identity=()=>getState()?.project+':'+getState()?.agent?.sessionId;
  function update() {
    const state=getState(),recovery=state?.agent?.recovery;banner.hidden=!recovery;
    label.textContent='上次任务已中断';resume.disabled=!!state?.agent?.busy;changes.onclick=reviewChanges;
  }
  resume.onclick=()=>guard(async()=>{
    const owner=identity();selected=await api.getRecoveryState();if(owner!==identity()||!selected)return;
    description.textContent=selected.uncertain.length?'以下工具的结果尚未确认。请先检查文件和命令状态，继续时不会自动重放已确认的工具。':'将保留已有记录，从当前文件继续未完成的任务。';
    tools.replaceChildren(...selected.uncertain.map(tool=>node('li','',tool.name+' · 结果待确认')));
    confirmation.hidden=!selected.uncertain.length;checkbox.checked=false;accept.disabled=!!selected.uncertain.length;dialog.showModal();
  });
  checkbox.onchange=()=>{accept.disabled=selected?.uncertain.length&&!checkbox.checked;};
  cancel.onclick=()=>dialog.close();
  accept.onclick=()=>guard(async()=>{const owner=identity();await api.recoverRun({runId:selected.run.runId,confirmedUncertain:checkbox.checked||!selected.uncertain.length});dialog.close();if(owner===identity()){await refresh();await loadHistory();}});
  const report=node('dialog','reliability-dialog');report.setAttribute('aria-label','诊断预览');
  const reportHeading=node('h2','','诊断预览'),note=node('p','','默认包含版本、任务状态和用量，不包含完整聊天或文件正文。'),detailLabel=node('label','check-label'),detail=node('input');detail.type='checkbox';
  detailLabel.append(detail,document.createTextNode('包含执行进程的详细输出（请先检查内容）'));
  const content=node('pre','diagnostic-preview'),close=node('button','quiet-button','关闭'),save=node('button','send-button','保存诊断'),reportFooter=node('div','form-footer');reportFooter.append(close,save);report.append(reportHeading,note,detailLabel,content,reportFooter);document.body.append(report);
  const preview=async()=>{content.textContent=JSON.stringify(await api.exportDiagnostics({includeRuntime:detail.checked,preview:true}),null,2);};
  diagnostic.onclick=()=>guard(async()=>{detail.checked=false;await preview();report.showModal();});
  detail.onchange=()=>guard(preview);close.onclick=()=>report.close();save.onclick=()=>guard(()=>api.exportDiagnostics({includeRuntime:detail.checked,preview:false}));
  async function loadPartial() {
    const owner=identity();if(!getState()?.agent?.recovery)return;
    const recovery=await api.getRecoveryState();if(owner!==identity()||!recovery?.partial?.messages?.length)return;
    if(document.querySelector('[data-recovered-run="'+recovery.run.runId+'"]'))return;
    const section=node('details','recovered-output');section.dataset.recoveredRun=recovery.run.runId;section.append(node('summary','','上次输出未完成'));
    for(const value of recovery.partial.messages)if(value.text)section.append(node('pre','',value.text));
    document.getElementById('messages').append(section);
  }
  return {update,loadPartial,openDiagnostics:()=>diagnostic.click()};
}
