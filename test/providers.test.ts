import test from 'node:test';
import assert from 'node:assert/strict';
import { readSse } from '../src/providers/sse.js';
import { OpenAIChatProvider } from '../src/providers/openai-chat.js';
import { OpenAIResponsesProvider } from '../src/providers/openai-responses.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import type { ModelRequest, Provider, ModelEvent, AssistantMessage } from '../src/types.js';
import { model, answer, call } from './helpers.js';

export function sse(...data: unknown[]): string { return data.map(v => `data: ${typeof v === 'string' ? v : JSON.stringify(v)}\r\n\r\n`).join(''); }
function bytes(source: string, close = true) {
  const input = new TextEncoder().encode(source);
  return new ReadableStream<Uint8Array>({ start(controller) { for (const value of input) controller.enqueue(new Uint8Array([value])); if (close) controller.close(); } });
}
const request = (): ModelRequest => ({ model, system: 'test', messages: [
  { role: 'user', text: '你好', timestamp: 1 }, answer('', [call('previous', 'read', { path: '你好.txt' })]),
  { role: 'tool', callId: 'previous', name: 'read', text: 'result', isError: true, timestamp: 2 },
], tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], signal: new AbortController().signal });
async function collect(provider: Provider, req = request()): Promise<{ final: AssistantMessage; events: ModelEvent[] }> {
  const events: ModelEvent[] = []; for await (const event of provider.stream(req)) events.push(event);
  const done = events.at(-1); assert.equal(done?.type, 'done'); if (done?.type !== 'done') throw new Error('missing done');
  return { final: done.message, events };
}
function http(source: string, close = true) {
  let body: Record<string, any> = {}; let init: RequestInit | undefined; let url = '';
  const fetch: typeof globalThis.fetch = async (input, options) => {
    url = String(input); init = options; body = JSON.parse(String(options?.body));
    return new Response(bytes(source, close), { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, get body() { return body; }, get init() { return init; }, get url() { return url; } };
}

test('SSE decodes split UTF-8, CRLF, comments and multiline data', async () => {
  const output = []; for await (const event of readSse(bytes(': ping\r\nevent: custom\r\ndata: 你\r\ndata: 好\r\n\r\ndata: last'), new AbortController().signal)) output.push(event);
  assert.deepEqual(output, [{ event: 'custom', data: '你\n好' }, { event: 'message', data: 'last' }]);
});
test('SSE cancellation releases a stalled reader', async () => {
  let cancelled = false; const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = (async () => { for await (const _ of readSse(stream, controller.signal)) {} })();
  controller.abort(new Error('cancel')); await assert.rejects(pending, /cancel/); assert.equal(cancelled, true);
});
test('SSE rejects oversized events', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(4 * 1024 * 1024 + 1)}\n\n`)); c.close(); } });
  await assert.rejects(async () => { for await (const _ of readSse(stream, new AbortController().signal)) {} }, /exceeds/);
});

test('Chat adapter joins tool fragments, serializes paired history and records usage', async () => {
  const stub = http(sse(
    { choices: [{ index: 0, delta: { content: '你好', tool_calls: [{ index: 0, id: 'read1', function: { name: 'read', arguments: '{"path":' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"你好.txt"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 17, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 3 } } }, '[DONE]'));
  const provider = new OpenAIChatProvider({ id: 'fixture', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: () => 'fake', fetch: stub.fetch });
  const { final } = await collect(provider);
  assert.equal(final.text, '你好'); assert.deepEqual(final.toolCalls, [call('read1', 'read', { path: '你好.txt' })]);
  assert.equal(final.usage.input, 17); assert.equal(final.usage.cacheRead, 3); assert.equal(final.stopReason, 'tool_use');
  assert.equal(stub.body.messages.at(-1).tool_call_id, 'previous'); assert.equal(stub.body.messages[2].tool_calls[0].id, 'previous');
  assert.equal((stub.init?.headers as Record<string, string>).Authorization, 'Bearer fake'); assert.equal(stub.init?.redirect, 'error');
  assert.equal(stub.url, 'http://127.0.0.1:1234/v1/chat/completions');
});
test('Chat compatibility settings select legacy token field and omit stream usage', async () => {
  const stub = http(sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'));
  await collect(new OpenAIChatProvider({ id: 'fixture', baseUrl: 'https://example.com/v1', fetch: stub.fetch, tokenLimitField: 'max_tokens', streamUsage: false }));
  assert.equal(stub.body.max_tokens, 1000); assert.equal(stub.body.max_completion_tokens, undefined); assert.equal(stub.body.stream_options, undefined);
});
test('DeepSeek thinking control preserves reasoning through tool turns without leaking across models', async () => {
  const stub = http(sse(
    { choices: [{ index: 0, delta: { reasoning_content: 'fixture-' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'state' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'deepseek-read', function: { name: 'read', arguments: '{"path":"file"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 12 } }, '[DONE]'));
  const provider = new OpenAIChatProvider({ id: 'fixture', baseUrl: 'https://api.deepseek.com', fetch: stub.fetch, tokenLimitField: 'max_tokens', thinking: 'enabled' });
  const { final } = await collect(provider); assert.deepEqual(final.providerState, { protocol: 'openai-chat', reasoningContent: 'fixture-state' });
  assert.equal(final.usage.cacheRead, 8); assert.deepEqual(stub.body.thinking, { type: 'enabled' });
  const req = request(); req.messages = [final, { role: 'tool', callId: 'deepseek-read', name: 'read', text: 'ok', isError: false, timestamp: 2 }];
  await collect(provider, req); assert.equal(stub.body.messages[1].reasoning_content, 'fixture-state');
  req.model = { ...model, id: 'different' }; await collect(provider, req); assert.equal(stub.body.messages[1].reasoning_content, undefined);
  req.model = { ...model, provider: 'different' }; await collect(provider, req); assert.equal(stub.body.messages[1].reasoning_content, undefined);
  const disabled = new OpenAIChatProvider({ id: 'fixture', baseUrl: 'https://api.deepseek.com', fetch: stub.fetch, thinking: 'disabled' });
  await collect(disabled); assert.deepEqual(stub.body.thinking, { type: 'disabled' });
});
test('Chat rejects interrupted streams and duplicate call IDs', async () => {
  const source = sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'read', arguments: '{' } }] } }] });
  await assert.rejects(collect(new OpenAIChatProvider({ id: 'fixture', baseUrl: 'https://example.com', fetch: http(source).fetch })), /finish reason/);
  const duplicate = sse({ choices: [{ delta: { tool_calls: [0, 1].map(index => ({ index, id: 'same', function: { name: 'read', arguments: '{}' } })) }, finish_reason: 'tool_calls' }] });
  await assert.rejects(collect(new OpenAIChatProvider({ id: 'fixture', baseUrl: 'https://example.com', fetch: http(duplicate).fetch })), /duplicate/);
});

test('Responses adapter uses authoritative snapshot and preserves reasoning on continuation', { timeout: 5000 }, async () => {
  const output = [{ type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'opaque-fixture' }, { type: 'function_call', call_id: 'new', name: 'read', arguments: '{"path":"file"}', id: 'fc', status: 'completed' }];
  const stub = http(sse(
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'new', name: 'read', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' },
    { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 7 } } } },
  ), false);
  const provider = new OpenAIResponsesProvider({ id: 'fixture', baseUrl: 'https://example.com/v1', fetch: stub.fetch });
  const { final } = await collect(provider); assert.equal(final.stopReason, 'tool_use'); assert.deepEqual(final.toolCalls, [call('new', 'read', { path: 'file' })]);
  assert.equal(final.usage.cacheRead, 7); assert.equal(stub.body.store, false); assert.deepEqual(stub.body.include, ['reasoning.encrypted_content']);
  const req = request(); req.messages = [final, { role: 'tool', callId: 'new', name: 'read', text: 'ok', isError: false, timestamp: 1 }];
  await collect(provider, req); assert.deepEqual(stub.body.input.slice(0, 2), output); assert.equal(stub.body.input[2].type, 'function_call_output');
  req.model = { ...model, id: 'different' }; await collect(provider, req); assert.equal(stub.body.input.some((item: any) => item.type === 'reasoning'), false);
});
test('Responses maps output token limit and rejects response failure', async () => {
  const limited = http(sse({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } }));
  assert.equal((await collect(new OpenAIResponsesProvider({ id: 'fixture', baseUrl: 'https://example.com', fetch: limited.fetch }))).final.stopReason, 'length');
  await assert.rejects(collect(new OpenAIResponsesProvider({ id: 'fixture', baseUrl: 'https://example.com', fetch: http(sse({ type: 'response.failed' })).fetch })), /response error/);
  const discarded = http(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'discarded', name: 'read', arguments: '{"path":"file"}' } }, { type: 'response.completed', response: { status: 'completed', output: [] } }));
  assert.deepEqual((await collect(new OpenAIResponsesProvider({ id: 'fixture', baseUrl: 'https://example.com', fetch: discarded.fetch }))).final.toolCalls, []);
});

test('Anthropic handles input JSON deltas, tool errors, cache usage and terminal event', { timeout: 5000 }, async () => {
  const stub = http(sse(
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"file"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } }, { type: 'message_stop' },
  ), false);
  const { final } = await collect(new AnthropicProvider({ id: 'fixture', baseUrl: 'https://example.com/v1', apiKey: () => 'fake', fetch: stub.fetch }));
  assert.deepEqual(final.toolCalls, [call('a', 'read', { path: 'file' })]); assert.equal(final.text, '你好');
  assert.deepEqual(final.usage, { input: 10, output: 6, cacheRead: 3, cacheWrite: 4 });
  assert.equal(stub.body.messages.at(-1).content[0].is_error, true); assert.deepEqual(stub.body.messages[1].content[0].input, { path: '你好.txt' });
  assert.equal((stub.init?.headers as Record<string, string>)['x-api-key'], 'fake');
});
test('Anthropic requires both stop reason and message_stop', async () => {
  await assert.rejects(collect(new AnthropicProvider({ id: 'fixture', baseUrl: 'https://example.com', fetch: http(sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })).fetch })), /message_stop/);
});
test('provider URL policy rejects remote plaintext and credentials; HTTP errors redact body', async () => {
  for (const baseUrl of ['http://remote.example/v1', 'https://user:password@example.com', 'https://example.com?key=x']) assert.throws(() => new OpenAIChatProvider({ id: 'fixture', baseUrl }));
  const provider = new OpenAIChatProvider({ id: 'fixture', baseUrl: 'https://example.com', fetch: async () => new Response('SECRET provider body', { status: 401 }) });
  await assert.rejects(collect(provider), error => error instanceof Error && error.message === 'Provider fixture returned HTTP 401');
});
