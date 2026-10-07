import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgentSession } from '../src/agent.js';
import { assertToolPairs } from '../src/context.js';
import { SessionStore } from '../src/session.js';
import { answer, call, fixture, echoTool, latch } from './helpers.js';
import type { AgentEvent, ModelEvent, ModelRequest, Provider } from '../src/types.js';

test('a documented output ceiling equal to context is clamped to the current request room', async t => {
  const f=await fixture(t,[request => {assert(request.model.maxOutputTokens > 1000);assert(request.model.maxOutputTokens < 32000);return answer('full answer');}]);
  f.models.registerModel({provider:'fixture',id:'full-window',contextWindow:32000,maxOutputTokens:32000,tools:true});
  await f.agent.setModel('fixture/full-window');assert.equal((await f.agent.run('complete this task')).status,'completed');
  assert.equal(f.models.getModel('fixture/full-window').maxOutputTokens,32000);
});

test('real read/edit cycle preserves CRLF and emits ordered desktop events', async t => {
  const f = await fixture(t, [answer('', [call('r', 'read', { path: '你好.txt' })]), request => {
    assert.match(request.messages.at(-1)!.text, /Hello, world/);
    return answer('', [call('e', 'edit', { path: '你好.txt', oldText: 'world', newText: 'agent' })]);
  }, answer('verified')]);
  await writeFile(resolve(f.root, '你好.txt'), '\uFEFFHello, world!\r\n');
  const events: AgentEvent[] = []; f.agent.subscribe(e => events.push(e));
  f.agent.subscribe(() => { throw new Error('Broken UI listener'); });
  assert.deepEqual(await f.agent.run('edit greeting'), { status: 'completed', turns: 3, text: 'verified' });
  assert.equal(await readFile(resolve(f.root, '你好.txt'), 'utf8'), '\uFEFFHello, agent!\r\n');
  assertToolPairs(f.store.messages()); assert.equal(events.at(-1)?.type, 'run_end');
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1));
});

test('CLI agent path preserves mixed endings and sends UTF-8-safe bounded read results to the model',async t=>{
  const prefix='x'.repeat(64*1024-Buffer.byteLength('\n[output truncated]')-4);
  const original=prefix+'你'.repeat(20)+'\r\nalpha\r\nbeta\ngamma\r\ndelta';
  const f=await fixture(t,[answer('',[call('read','read',{path:'mixed.txt'})]),request=>{
    assert.equal(request.messages.at(-1)!.text,'1: '+prefix+'\n[output truncated]');
    return answer('',[call('edit','edit',{path:'mixed.txt',oldText:'beta',newText:'BETA'})]);
  },answer('verified')]);
  await writeFile(resolve(f.root,'mixed.txt'),original);
  assert.equal((await f.agent.run('edit mixed file')).status,'completed');
  assert.deepEqual(await readFile(resolve(f.root,'mixed.txt')),Buffer.from(original.replace('beta','BETA')));
  assertToolPairs(f.store.messages());
});

test('malformed args and inactive tools return errors without executing', async t => {
  let executions = 0;
  const f = await fixture(t, [answer('', [
    { id: 'bad', name: 'echo', arguments: '{"value":' },
    call('wrongtype', 'echo', { value: 1 }), call('off', 'write', { path: 'no.txt', content: 'x' }),
  ]), request => { assert.equal(request.messages.filter(m => m.role === 'tool' && m.isError).length, 3); return answer(); }],
  [echoTool(async () => { executions++; return { text: 'unexpected' }; })], { activeTools: ['echo'] });
  assert.equal((await f.agent.run('test')).status, 'completed'); assert.equal(executions, 0);
  await assert.rejects(readFile(resolve(f.root, 'no.txt')), { code: 'ENOENT' }); assertToolPairs(f.store.messages());
});

test('extension blocks side effects and successful after hook changes tool output', async t => {
  let executions = 0;
  const f = await fixture(t, [answer('', [call('blocked', 'echo', { value: 'deny' }), call('ok', 'echo', { value: 'allow' })]), request => {
    const results = request.messages.filter(m => m.role === 'tool');
    assert.equal(results[0]?.isError, true); assert.equal(results[1]?.text, 'decorated'); return answer();
  }], [echoTool(async () => { executions++; return { text: 'raw' }; })], { extensions: [{ name: 'policy',
    beforeTool: async args => args.value === 'deny' ? { block: 'test policy' } : undefined,
    afterTool: async () => ({ text: 'decorated' }),
  }] });
  await f.agent.run('test'); assert.equal(executions, 1);
});

test('truncated final message cannot execute complete-looking calls', async t => {
  let executions = 0;
  const f = await fixture(t, [answer('', [call('partial', 'echo', { value: 'x' })], 'length')],
    [echoTool(async () => { executions++; return { text: 'x' }; })]);
  assert.equal((await f.agent.run('test')).status, 'limit'); assert.equal(executions, 0); assertToolPairs(f.store.messages());
});

test('stream ending before final message never executes or journals partial calls', async t => {
  let executions = 0;
  const f = await fixture(t, [], [echoTool(async () => { executions++; return { text: 'x' }; })]);
  const broken: Provider = { id: 'broken', async *stream(_: ModelRequest): AsyncGenerator<ModelEvent> {
    yield { type: 'tool_delta', index: 0, id: 'x', name: 'echo', arguments: '{"value":"x"}' }; throw new Error('Connection lost');
  } };
  f.models.registerProvider(broken).registerModel({ provider: 'broken', id: 'x', contextWindow: 32_000, maxOutputTokens: 1000, tools: true });
  await f.agent.setModel('broken/x'); assert.equal((await f.agent.run('test')).status, 'failed');
  assert.equal(executions, 0); assert.equal(f.store.messages().filter(m => m.role === 'assistant').length, 0);
});

test('tools execute sequentially and steering enters before the next tool boundary', async t => {
  const order: string[] = [];
  const f = await fixture(t, [answer('', [call('one', 'echo', { value: 'one' }), call('two', 'echo', { value: 'two' })]), request => {
    assert.equal(request.messages.at(-1)?.text, 'change direction'); assertToolPairs(request.messages); return answer('steered');
  }], [echoTool(async args => { order.push(String(args.value)); return { text: 'ok' }; })]);
  f.agent.subscribe(e => { if (e.type === 'tool_end' && e.call.id === 'one') f.agent.steer('change direction'); });
  assert.equal((await f.agent.run('test')).text, 'steered'); assert.deepEqual(order, ['one']);
  assert.match(f.store.messages().find(m => m.role === 'tool' && m.callId === 'two')!.text, /redirected/);
});

test('follow-up waits until current task returns a natural final answer', async t => {
  const started = latch(); const release = latch();
  const f = await fixture(t, [async () => { started.resolve(); await release.promise; return answer('first final'); }, request => {
    assert.equal(request.messages.at(-1)?.text, 'next task'); assert.equal(request.messages.at(-2)?.text, 'first final'); return answer('second final');
  }]);
  const pending = f.agent.run('first'); await started.promise; f.agent.followUp('next task'); release.resolve();
  assert.deepEqual(await pending, { status: 'completed', turns: 2, text: 'second final' });
});

test('cancellation during tool execution records all pending results without repeating effects', async t => {
  const started = latch(); let count = 0;
  const f = await fixture(t, [answer('', [call('one', 'echo', { value: 'one' }), call('two', 'echo', { value: 'two' })])],
    [echoTool(async (_, context) => { count++; started.resolve(); await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true })); context.signal.throwIfAborted(); return { text: 'x' }; })]);
  const pending = f.agent.run('test'); await started.promise; await f.agent.abort();
  assert.equal((await pending).status, 'cancelled'); assert.equal(count, 1); assertToolPairs(f.store.messages());
  assert.equal(f.store.messages().filter(m => m.role === 'tool' && m.isError).length, 2);
});

test('running and configuration mutations are exclusive, models switch between runs', async t => {
  const f = await fixture(t, [answer('a'), request => { assert.equal(request.model.id, 'other'); return answer('b'); }]);
  const switching = f.agent.setModel('fixture/other');
  await assert.rejects(f.agent.run('race'), /busy/); await assert.rejects(f.agent.setTools(['read']), /busy/); await switching;
  await f.agent.setModel('fixture/small'); const run = f.agent.run('first');
  await assert.rejects(f.agent.run('second'), /busy/); await assert.rejects(f.agent.setModel('fixture/other'), /busy/); await run;
  await f.agent.setModel('fixture/other'); await f.agent.run('second');
  assert.deepEqual(f.store.messages().filter(m => m.role === 'assistant').map(m => m.model), ['small', 'other']);
});

test('launch permission ceiling cannot be expanded via model tools or set_tools', async t => {
  const f = await fixture(t, [answer('', [call('w', 'write', { path: 'no.txt', content: 'x' })]), answer()], [], { activeTools: ['read'], allowedTools: ['read'] });
  await assert.rejects(f.agent.setTools(['read', 'write']), /launch permissions/);
  await f.agent.run('test'); await assert.rejects(readFile(resolve(f.root, 'no.txt')), { code: 'ENOENT' });
});

test('duplicate historical call IDs fail before any new side effects', async t => {
  let count = 0;
  const f = await fixture(t, [answer('', [call('same', 'echo', { value: 'one' })]), answer('', [call('same', 'echo', { value: 'two' })])],
    [echoTool(async () => { count++; return { text: 'ok' }; })]);
  assert.equal((await f.agent.run('test')).status, 'failed'); assert.equal(count, 1); assertToolPairs(f.store.messages());
});

test('tool failures can be corrected on the next turn', async t => {
  const f = await fixture(t, [answer('', [call('bad', 'read', { path: 'missing' })]), request => {
    assert.equal(request.messages.at(-1)?.role, 'tool'); return answer('', [call('good', 'write', { path: 'created.txt', content: 'ok' })]);
  }, answer('fixed')]);
  assert.equal((await f.agent.run('fix')).status, 'completed'); assert.equal(await readFile(resolve(f.root, 'created.txt'), 'utf8'), 'ok');
});

test('resuming unresolved calls appends an unknown-outcome error and never executes them', async t => {
  let count = 0; const f = await fixture(t, [answer()], [echoTool(async () => { count++; return { text: 'x' }; })]);
  await f.store.append({ kind: 'message', message: answer('', [call('crash', 'echo', { value: 'x' })]) });
  await f.agent.close(); const store = await SessionStore.resume(f.store.path);
  const agent = await AgentSession.create({ store, models: f.models, tools: f.tools }); t.after(() => agent.close());
  assert.equal(count, 0); assert.match(store.messages().at(-1)!.text, /unknown/); assertToolPairs(store.messages());
  assert.equal((await agent.run('inspect')).status, 'completed'); assert.equal(count, 0); await agent.close();
});

test('model turn cap stops an endless tool loop', async t => {
  const f = await fixture(t, [answer('', [call('1', 'echo', { value: 'x' })]), answer('', [call('2', 'echo', { value: 'x' })])], [echoTool()], { maxTurns: 2 });
  assert.equal((await f.agent.run('test')).status, 'limit'); assertToolPairs(f.store.messages());
});
