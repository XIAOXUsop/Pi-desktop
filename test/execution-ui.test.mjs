import test from 'node:test';
import assert from 'node:assert/strict';
import {finalOutputs} from '../desktop/ui/execution-ui.js';
import {assistantPresentation,nativeTextPhase,ANSWER_HEADER,PROGRESS_HEADER} from '../desktop/ui/assistant-presentation.js';

test('split presentation headers never expose protocol fragments or assume an answer early',() => {
  for(const [header,phase] of [[ANSWER_HEADER,'final_answer'],[PROGRESS_HEADER,'commentary']]) {
    for(let i=0;i<header.length;i++) assert.deepEqual(assistantPresentation(header.slice(0,i)),{phase:'pending',text:''});
    assert.deepEqual(assistantPresentation(header+'\nVisible body.'),{phase,text:'Visible body.'});
  }
});

test('unknown live text stays pending regardless of wording while explicit native phases are honored',() => {
  for(const text of ['I will inspect the file.','Let','最终答案：已完成','Read 5 files.']) assert.deepEqual(assistantPresentation(text),{phase:'pending',text});
  assert.deepEqual(assistantPresentation('typed answer','final_answer'),{phase:'final_answer',text:'typed answer'});
  assert.deepEqual(assistantPresentation('typed progress','commentary'),{phase:'commentary',text:'typed progress'});
  assert.equal(assistantPresentation('unknown','unexpected').phase,'pending');
});

test('presentation metadata does not alter JSON code indentation or literal markers in the body',() => {
  const body='  {"answer":"[[agent:progress]]"}\n';
  assert.deepEqual(assistantPresentation('\uFEFF \n'+ANSWER_HEADER+'\r\n'+body),{phase:'final_answer',text:body});
  assert.deepEqual(assistantPresentation('prefix '+ANSWER_HEADER),{phase:'pending',text:'prefix '+ANSWER_HEADER});
});

test('native phases project only validated public fields and never infer an opaque signature',() => {
  const block=phase=>({type:'text',text:'body',textSignature:JSON.stringify({v:1,id:'PRIVATE_ID',phase})});
  assert.equal(nativeTextPhase([block('commentary')]),'commentary');
  assert.equal(nativeTextPhase([block('final_answer')]),'final_answer');
  assert.equal(nativeTextPhase([block('commentary'),block('final_answer')]),undefined);
  assert.equal(nativeTextPhase([{type:'text',textSignature:'OPAQUE_SIGNATURE'},{type:'text',textSignature:{phase:'final_answer'}}]),undefined);
});

const entry = (id,message) => ({id,data:{kind:'message',message}});
const user = id => entry(id,{role:'user',text:'task'});
const assistant = (id,stop='stop',calls=[]) => entry(id,{role:'assistant',text:id,stopReason:stop,executionStatus:'completed',toolCalls:calls});
const marker = (id,assistantEntryId,status='completed') => ({id,data:{kind:'run_result',assistantEntryId,result:{status,turns:1}}});

test('legacy multi-step tasks expose only their final answer and fold tool commentary',() => {
  const history=[user('u1'),assistant('p1','tool_use',[{id:'t1'}]),entry('t1',{role:'tool'}),assistant('p2','tool_use',[{id:'t2'}]),entry('t2',{role:'tool'}),assistant('answer'),user('u2'),assistant('p3','tool_use',[{id:'t3'}]),entry('t3',{role:'tool'}),assistant('last')];
  assert.deepEqual([...finalOutputs(history)],[['answer','completed'],['last','completed']]);
});
test('old length message overrides the incorrectly saved completed status',() => {
  assert.deepEqual([...finalOutputs([user('u'),assistant('Let','length')])],[['Let','limit']]);
});
test('run marker keeps recovered attempts inside the process and selects one real output',() => {
  const history=[user('u'),assistant('partial','length'),assistant('retried'),marker('r','retried')];
  assert.deepEqual([...finalOutputs(history)],[['retried','completed']]);
});
test('tool-only interruption and commands without a model output invent no final answer',() => {
  assert.equal(finalOutputs([user('u'),assistant('p','tool_use',[{id:'t'}]),marker('r','p','failed')]).size,0);
  assert.equal(finalOutputs([user('u'),marker('r',null)]).size,0);
});
test('partial failure and cancellation are retained with their terminal status',() => {
  assert.deepEqual([...finalOutputs([user('u'),assistant('partial'),marker('r','partial','cancelled')])],[['partial','cancelled']]);
  assert.deepEqual([...finalOutputs([user('u'),assistant('partial'),marker('r','partial','failed')])],[['partial','failed']]);
});

test('explicit commentary remains folded after terminal markers and old history still selects its answer',() => {
  const progress=assistant('p');progress.data.message.phase='commentary';
  assert.equal(finalOutputs([user('u'),progress,marker('r','p')]).size,0);
  assert.deepEqual([...finalOutputs([user('u'),progress,assistant('answer'),marker('r','answer')])],[['answer','completed']]);
});
