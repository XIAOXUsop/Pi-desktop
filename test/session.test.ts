import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SessionStore } from '../src/session.js';
import { compactContext, estimateTokens, assertToolPairs } from '../src/context.js';
import { temp, answer, model, ScriptedProvider, call, fixture } from './helpers.js';

test('session branches preserve both histories and selected leaf across restart', async t => {
  const { root, cleanup } = await temp(t); const store = await SessionStore.create(root); cleanup.push(() => store.close());
  const a = await store.append({ kind: 'message', message: { role: 'user', text: 'root', timestamp: 1 } });
  const b = await store.append({ kind: 'message', message: answer('original') });
  await store.select(a.id); const c = await store.append({ kind: 'message', message: answer('alternative') });
  assert.equal(c.parentId, a.id); assert.equal(store.all().length, 3); assert.deepEqual(store.messages().map(m => m.text), ['root', 'alternative']);
  await store.select(b.id); await store.close(); const restored = await SessionStore.resume(store.path); cleanup.push(() => restored.close());
  assert.equal(restored.leaf, b.id); assert.deepEqual(restored.messages().map(m => m.text), ['root', 'original']);
  assert.deepEqual(restored.usage(), { input: 20, output: 4, cacheRead: 0, cacheWrite: 0 });
});
test('session writer lock rejects simultaneous workers and is released on close', async t => {
  const { root, cleanup } = await temp(t); const store = await SessionStore.create(root); cleanup.push(() => store.close());
  await assert.rejects(SessionStore.resume(store.path), /already open/); await store.close();
  const restored = await SessionStore.resume(store.path); cleanup.push(() => restored.close());
  await store.close(); await assert.rejects(SessionStore.resume(store.path), /already open/);
});
test('session recovers only an incomplete final JSON record', async t => {
  const { root, cleanup } = await temp(t); const store = await SessionStore.create(root); cleanup.push(() => store.close());
  await store.append({ kind: 'message', message: answer('safe') }); await store.close();
  const original = await readFile(store.path); await appendFile(store.path, '{"type":"entry","bad":');
  const restored = await SessionStore.resume(store.path); cleanup.push(() => restored.close());
  assert.equal(restored.messages()[0]?.text, 'safe'); assert.deepEqual(await readFile(store.path), original); await restored.close();
  await appendFile(store.path, 'broken complete line\n'); await assert.rejects(SessionStore.resume(store.path));
});
test('valid final record without newline is repaired before the next append', async t => {
  const { root, cleanup } = await temp(t); const store = await SessionStore.create(root); cleanup.push(() => store.close());
  await store.append({ kind: 'message', message: answer('first') }); await store.close();
  await writeFile(store.path, (await readFile(store.path, 'utf8')).trimEnd());
  const restored = await SessionStore.resume(store.path); cleanup.push(() => restored.close());
  await restored.append({ kind: 'message', message: answer('second') }); await restored.close();
  const again = await SessionStore.resume(store.path); cleanup.push(() => again.close()); assert.equal(again.messages().length, 2);
});
test('parallel appends reserve correct ancestry; closed writes do not mutate state', async t => {
  const { root, cleanup } = await temp(t); const store = await SessionStore.create(root); cleanup.push(() => store.close());
  const entries = await Promise.all(['a', 'b', 'c'].map(text => store.append({ kind: 'message', message: answer(text) })));
  assert.equal(entries[1]?.parentId, entries[0]?.id); assert.equal(entries[2]?.parentId, entries[1]?.id);
  const leaf = store.leaf; await store.close(); await assert.rejects(store.append({ kind: 'message', message: answer('bad') }), /closed/);
  await assert.rejects(store.select(null), /closed/); assert.equal(store.leaf, leaf); assert.equal(store.all().length, 3);
});
test('negative usage and compaction boundaries outside current branch are rejected', async t => {
  const { root, cleanup } = await temp(t); const store = await SessionStore.create(root); cleanup.push(() => store.close());
  await assert.rejects(store.append({ kind: 'message', message: { ...answer(), usage: { input: -1, output: 0 } } }), /usage/);
  await assert.rejects(store.append({ kind: 'compaction', summary: 'bad', keepFromId: 'unknown', usage: { input: 0, output: 0 } }), /boundary/);
  assert.equal(store.all().length, 0);
});
test('compaction retains complete tool pairs, raw transcript and usage', async t => {
  const { root, cleanup } = await temp(t); const store = await SessionStore.create(root); cleanup.push(() => store.close());
  for (let i = 0; i < 5; i++) {
    await store.append({ kind: 'message', message: { role: 'user', text: `goal ${i} ` + 'x'.repeat(1800), timestamp: i } });
    await store.append({ kind: 'message', message: answer('inspection', [call(`c${i}`, 'read', { path: 'file' })]) });
    await store.append({ kind: 'message', message: { role: 'tool', callId: `c${i}`, name: 'read', text: 'y'.repeat(1200), isError: false, timestamp: i } });
    await store.append({ kind: 'message', message: answer('result') });
  }
  const rawCount = store.all().length; const before = estimateTokens('system', store.messages());
  const provider = new ScriptedProvider([answer('Preserve goals and inspect file.')]);
  const result = await compactContext(store, provider, model, 'system', [], new AbortController().signal, Math.floor(before * .6));
  assert.ok(result && result.after < result.before); assert.equal(store.all().length, rawCount + 1); assertToolPairs(store.messages());
  assert.match(store.messages()[0]!.text, /Earlier conversation summary/); assert.equal(store.usage().input, 110);
  const compacted = store.messages(); await store.close(); const restored = await SessionStore.resume(store.path); cleanup.push(() => restored.close());
  assert.deepEqual(restored.messages(), compacted);
});
test('failed compaction does not alter journal or discard the active message', async t => {
  const { root, cleanup } = await temp(t); const store = await SessionStore.create(root); cleanup.push(() => store.close());
  for (let i = 0; i < 4; i++) await store.append({ kind: 'message', message: { role: 'user', text: 'x'.repeat(3000), timestamp: i } });
  const before = store.all().length; const provider = new ScriptedProvider([answer('', [], 'length')]);
  await assert.rejects(compactContext(store, provider, model, '', [], new AbortController().signal, 2800), /successfully/); assert.equal(store.all().length, before);
  await assert.rejects(compactContext(store, provider, { ...model, contextWindow: 1000 }, '', [], new AbortController().signal, 500), /cannot be compacted|too large/);
  assert.equal(store.all().length, before);
});
test('agent branching restores prior model and keeps old answers reviewable', async t => {
  const f = await fixture(t, [answer('old'), answer('new')]); await f.agent.run('root'); const leaf = f.store.leaf;
  await f.agent.setModel('fixture/other'); await f.agent.run('next');
  await f.agent.branch(leaf); assert.equal(f.agent.state.model.id, 'small'); assert.equal(f.store.messages().at(-1)?.text, 'old');
  assert.equal(f.store.all().filter(e => e.data.kind === 'message' && e.data.message.text === 'new').length, 1);
});
