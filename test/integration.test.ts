import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRpc } from '../src/rpc.js';
import { loadConfig } from '../src/config.js';
import { fixture, answer, call, latch, temp } from './helpers.js';

test('RPC streams correlated results, supports queues and refuses permission escalation', { timeout: 10000 }, async t => {
  const started = latch(); const release = latch();
  const f = await fixture(t, [async () => { started.resolve(); await release.promise; return answer('first'); }, answer('follow-up')], [], { activeTools: ['read'], allowedTools: ['read'] });
  const input = new PassThrough(); const records: any[] = []; const ended = latch(); let buffer = '';
  const output = new Writable({ write(chunk, _, next) {
    buffer += chunk.toString(); let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const item = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); records.push(item);
      if (item.type === 'run_result') ended.resolve();
    }
    next();
  } });
  const pending = serveRpc(f.agent, input, output);
  const send = (id: number, method: string, params = {}) => input.write(JSON.stringify({ id, method, params }) + '\n');
  send(1, 'initialize'); send(2, 'set_tools', { names: ['write'] }); send(3, 'run', { prompt: 'first task' });
  await started.promise; send(4, 'follow_up', { prompt: 'next task' }); send(5, 'run', { prompt: 'concurrent' });
  // Wait for command responses so follow-up is definitely queued before releasing the model.
  const commandHandled = latch(); const originalWrite = output._write.bind(output);
  output._write = (chunk, encoding, next) => { originalWrite(chunk, encoding, next); if (records.some(item => item.id === 5 && item.type === 'response')) commandHandled.resolve(); };
  send(6, 'state'); await commandHandled.promise; release.resolve(); await ended.promise;
  send(7, 'history'); input.end(); await pending;
  assert.equal(records.find(item => item.id === 1).result.protocolVersion, 1);
  assert.match(records.find(item => item.id === 2).error.message, /launch permissions/);
  assert.match(records.find(item => item.id === 5).error.message, /busy/);
  assert.equal(records.find(item => item.type === 'run_result').id, 3); assert.equal(records.find(item => item.type === 'run_result').result.text, 'follow-up');
  assert.ok(records.find(item => item.id === 7).result.entries.length > 0); assert.equal(buffer, '');
});

test('RPC EOF cancels an active model request and releases its session', async t => {
  const started = latch(); const f = await fixture(t, [async request => {
    started.resolve(); await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true })); request.signal.throwIfAborted(); return answer();
  }]);
  const input = new PassThrough(); let outputText = ''; const output = new Writable({ write(chunk, _, next) { outputText += chunk.toString(); next(); } });
  const pending = serveRpc(f.agent, input, output); input.write(JSON.stringify({ id: 'request', method: 'run', params: { prompt: 'wait' } }) + '\n');
  await started.promise; input.end(); await pending; assert.match(outputText, /cancelled/);
});

test('config uses environment-key references, validates protocols and rejects embedded secrets', async t => {
  const { root } = await temp(t); const path = resolve(root, 'config.json');
  const config = { defaultModel: 'local/model', providers: [{ id: 'local', protocol: 'openai-chat', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'AGENT_TEST_KEY', tokenLimitField: 'max_tokens', streamUsage: false }],
    models: [{ provider: 'local', id: 'model', contextWindow: 8000, maxOutputTokens: 1000, tools: true }] };
  await writeFile(path, JSON.stringify(config)); const loaded = await loadConfig(path); assert.equal(loaded.registry.list().length, 1);
  await writeFile(path, JSON.stringify({ ...config, providers: [{ ...config.providers[0], apiKey: 'secret' }] })); await assert.rejects(loadConfig(path), /Invalid config/);
  await writeFile(path, JSON.stringify({ ...config, providers: [{ ...config.providers[0], protocol: 'anthropic' }] })); await assert.rejects(loadConfig(path), /compatibility/);
});

test('ready-to-use DeepSeek config loads without credentials and preserves its compatibility settings', async () => {
  const path = fileURLToPath(new URL('../../configs/deepseek.json', import.meta.url)); const { config, registry } = await loadConfig(path);
  assert.equal(config.defaultModel, 'deepseek/deepseek-flash'); assert.equal(config.providers[0]?.thinking, 'disabled');
  assert.equal(config.providers[0]?.apiKeyEnv, 'DEEPSEEK_API_KEY'); assert.equal(config.providers[0]?.tokenLimitField, 'max_tokens');
  assert.equal(registry.list().length, 2);
});

function frames(protocol: string, step: number): string {
  const tool = step === 0 ? call('read1', 'read', { path: 'hello.txt' }) : step === 1 ? call('edit1', 'edit', { path: 'hello.txt', oldText: 'world', newText: 'agent' }) : undefined;
  const text = tool ? '' : step === 2 ? '模型任务完成' : '会话续接完成';
  const data: unknown[] = [];
  if (protocol === 'openai-chat') {
    data.push({ choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: tool.id, function: { name: tool.name, arguments: tool.arguments } }] } : { content: text }, finish_reason: tool ? 'tool_calls' : 'stop' }] });
    data.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }, '[DONE]');
  } else if (protocol === 'openai-responses') {
    data.push({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 2 }, output: tool ?
      [{ type: 'function_call', id: 'fc_' + tool.id, call_id: tool.id, name: tool.name, arguments: tool.arguments }] :
      [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } });
  } else {
    data.push({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } });
    data.push({ type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: tool.id, name: tool.name, input: JSON.parse(tool.arguments) } : { type: 'text', text } });
    data.push({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' });
  }
  return data.map(value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n').join('');
}
async function cli(args: string[]): Promise<{ code: number | null; records: any[]; stderr: string }> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => stdout += chunk.toString()); child.stderr.on('data', chunk => stderr += chunk.toString());
  const [code] = await once(child, 'close'); return { code, records: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), stderr };
}
for (const protocol of ['openai-chat', 'openai-responses', 'anthropic']) {
  test(`${protocol}: CLI + real local HTTP + file editing + resumed history`, { timeout: 15000 }, async t => {
    const { root } = await temp(t); let step = 0; const bodies: any[] = []; const endpoints: string[] = [];
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk.toString(); bodies.push(JSON.parse(body)); endpoints.push(req.url!);
      if (protocol === 'openai-chat') {
        assert.deepEqual(bodies.at(-1).thinking, { type: 'enabled' });
        for (const message of bodies.at(-1).messages.filter((m: any) => m.role === 'assistant')) assert.equal(message.reasoning_content, 'fixture-reasoning');
      }
      const reasoning = protocol === 'openai-chat' ? 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'fixture-reasoning' }, finish_reason: null }] }) + '\n\n' : '';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); const data = Buffer.from(reasoning + frames(protocol, step++));
      for (let i = 0; i < data.length; i += 7) res.write(data.subarray(i, i + 7)); res.end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const configPath = resolve(root, 'models.json'); await writeFile(configPath, JSON.stringify({ defaultModel: 'test/model',
      providers: [{ id: 'test', protocol, baseUrl: `http://127.0.0.1:${address.port}/v1`, ...(protocol === 'openai-chat' ? { thinking: 'enabled', tokenLimitField: 'max_tokens' } : {}) }], models: [{ provider: 'test', id: 'model', contextWindow: 32000, maxOutputTokens: 1000, tools: true }] }));
    await writeFile(resolve(root, 'hello.txt'), 'Hello, world!\r\n');
    const args = ['run', '--config', configPath, '--workspace', root, '--allow-write'];
    const first = await cli([...args, '--prompt', 'Read then edit greeting']); assert.equal(first.code, 0, first.stderr);
    assert.equal(first.records.at(-1).result.turns, 3); assert.equal(await readFile(resolve(root, 'hello.txt'), 'utf8'), 'Hello, agent!\r\n');
    const journal = first.records.at(-1).session; const next = await cli([...args, '--resume', journal, '--prompt', 'Continue']);
    assert.equal(next.code, 0, next.stderr); assert.equal(next.records.at(-1).result.text, '会话续接完成');
    assert.ok(JSON.stringify(bodies[3]).includes('edit1')); assert.ok(JSON.stringify(bodies[3]).includes('Continue'));
    assert.equal(endpoints[0], protocol === 'openai-chat' ? '/v1/chat/completions' : protocol === 'openai-responses' ? '/v1/responses' : '/v1/messages');
  });
}
