import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgentSession } from '../src/agent.js';
import { ModelRegistry } from '../src/models.js';
import { SessionStore } from '../src/session.js';
import { trackedFileTools } from '../src/changes.js';
import { Workspace } from '../src/tools/workspace.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { estimateTokens } from '../src/context.js';
import { temp, answer, call, model, ScriptedProvider, type Step } from './helpers.js';
import type { Extension, AgentEvent } from '../src/types.js';

async function fixture(t: Parameters<typeof temp>[0], steps: Step[], extensions: Extension[] = []) {
  const { root, cleanup } = await temp(t); const workspace = await Workspace.open(root); const store = await SessionStore.create(root);
  const tools = new ToolRegistry(); trackedFileTools(workspace, store).forEach(tool => tools.register(tool));
  const models = new ModelRegistry().registerProvider(new ScriptedProvider(steps)).registerModel(model);
  const agent = await AgentSession.create({ store, tools, models, modelKey: 'fixture/small', extensions }); cleanup.push(() => agent.close());
  return { root, store, agent };
}
test('file changes include unified diff, immutable snapshots and a persisted UI event', async t => {
  const f = await fixture(t, [answer('', [call('edit', 'edit', { path: 'file.txt', oldText: 'old', newText: 'new' })]), answer()]);
  await writeFile(resolve(f.root, 'file.txt'), 'old\r\n'); const events: AgentEvent[] = []; f.agent.subscribe(e => events.push(e));
  assert.equal((await f.agent.run('edit')).status, 'completed');
  const changeEvent = events.find(e => e.type === 'file_change'); assert.ok(changeEvent?.type === 'file_change');
  const change = changeEvent.change; assert.equal(change.path, 'file.txt'); assert.equal(change.operation, 'update');
  assert.match(change.patch, /-old/); assert.match(change.patch, /\+new/); assert.equal(change.addedLines, 1); assert.equal(change.removedLines, 1);
  assert.equal(await readFile(resolve(f.root, change.before.snapshot!), 'utf8'), 'old\r\n'); assert.equal(await readFile(resolve(f.root, change.after.snapshot!), 'utf8'), 'new\r\n');
  assert.notEqual(change.before.hash, change.after.hash); await f.agent.close();
  const store = await SessionStore.resume(f.store.path); assert.deepEqual(store.last('file_change')?.change, change); await store.close();
});
test('new file snapshots distinguish creation from replacement', async t => {
  const f = await fixture(t, [answer('', [call('write', 'write', { path: '新文件.txt', content: 'hello\n' })]), answer()]);
  await f.agent.run('create'); const change = f.store.last('file_change')!.change;
  assert.equal(change.operation, 'create'); assert.equal(change.before.exists, false); assert.equal(change.before.snapshot, null); assert.equal(change.addedLines, 1);
  assert.match(change.patch, /\/dev\/null/); assert.equal(await readFile(resolve(f.root, change.after.snapshot!), 'utf8'), 'hello\n');
});
test('failed or identical edits do not invent a file change', async t => {
  const f = await fixture(t, [answer('', [call('bad', 'edit', { path: 'file', oldText: 'missing', newText: 'new' }), call('same', 'write', { path: 'file', content: 'same' })]), answer()]);
  await writeFile(resolve(f.root, 'file'), 'same'); await f.agent.run('test'); assert.equal(f.store.all().filter(e => e.data.kind === 'file_change').length, 0);
  assert.equal(await readFile(resolve(f.root, 'file'), 'utf8'), 'same');
});
test('after hook failure cannot hide an already committed file change', async t => {
  const f = await fixture(t, [answer('', [call('write', 'write', { path: 'file', content: 'new' })]), answer()], [{ name: 'broken', afterTool: async () => { throw new Error('Hook failed'); } }]);
  await f.agent.run('test'); assert.equal(f.store.last('file_change')?.change.path, 'file');
  assert.equal(f.store.messages().find(m => m.role === 'tool')?.isError, true); assert.equal(await readFile(resolve(f.root, 'file'), 'utf8'), 'new');
});
test('branch change list follows selected history while old snapshots remain', async t => {
  const f = await fixture(t, [answer('', [call('first', 'write', { path: 'file', content: 'one' })]), answer(), answer('', [call('second', 'write', { path: 'file', content: 'two' })]), answer()]);
  await f.agent.run('one'); const leaf = f.store.leaf; await f.agent.run('two'); assert.equal(f.store.all().filter(e => e.data.kind === 'file_change').length, 2);
  await f.agent.branch(leaf); assert.equal(f.store.branch().filter(e => e.data.kind === 'file_change').length, 1);
  assert.equal(await readFile(resolve(f.root, 'file'), 'utf8'), 'two');
});
test('desktop tool details do not inflate model token budget', () => {
  const message = { role: 'tool' as const, name: 'shell', callId: 'call', text: 'ok', timestamp: 1, isError: false };
  assert.equal(estimateTokens('', [message]), estimateTokens('', [{ ...message, details: { output: 'x'.repeat(5000) } }]));
});
