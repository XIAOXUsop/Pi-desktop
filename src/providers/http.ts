import type { Model, ModelRequest, Message, AssistantMessage, ToolCall, StopReason, Usage } from '../types.js';
import { record, string, number } from '../util.js';
import { readSse, type SseEvent } from './sse.js';

export interface HttpProviderOptions {
  id: string; baseUrl: string; apiKey?: () => string | undefined;
  headers?: Record<string, string>; timeoutMs?: number; fetch?: typeof globalThis.fetch;
}
export abstract class HttpProvider {
  readonly id: string;
  constructor(protected options: HttpProviderOptions) {
    this.id = options.id;
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Provider URL must not contain credentials, query or fragment');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('Use HTTPS, or HTTP for a localhost model service');
    }
  }
  protected async *request(path: string, payload: Record<string, unknown>, request: ModelRequest,
    auth: 'bearer' | 'anthropic' = 'bearer'): AsyncGenerator<SseEvent> {
    const key = this.options.apiKey?.();
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...this.options.headers };
    if (auth === 'anthropic') {
      headers['anthropic-version'] ??= '2023-06-01'; if (key) headers['x-api-key'] = key;
    } else if (key) headers.Authorization = `Bearer ${key}`;
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const url = base.endsWith(path) ? base : `${base}/${path}`;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(this.options.timeoutMs ?? 120_000)]);
    const response = await (this.options.fetch ?? globalThis.fetch)(url, {
      method: 'POST', headers, body: JSON.stringify(payload), signal, redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      // Deliberately do not expose provider bodies, URLs, prompts or authentication in errors.
      throw new Error(`Provider ${this.id} returned HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('Provider returned an empty response');
    yield* readSse(response.body, signal);
  }
}
export function json(data: string): Record<string, unknown> {
  try { return record(JSON.parse(data)); } catch { throw new Error('Provider returned malformed JSON'); }
}
export function assistant(request: ModelRequest, text: string, calls: ToolCall[], stopReason: StopReason, usage: Usage): AssistantMessage {
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call.id || !call.name || ids.has(call.id)) throw new Error('Provider returned invalid or duplicate tool calls');
    ids.add(call.id);
  }
  return { role: 'assistant', text, toolCalls: calls, provider: request.model.provider, model: request.model.id,
    stopReason, usage, timestamp: Date.now() };
}
export function chatMessages(messages: Message[], model?: Model): Record<string, unknown>[] {
  return messages.map(message => {
    if (message.role === 'user') return { role: 'user', content: message.text };
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.callId, content: message.text };
    return { role: 'assistant', content: message.text || null,
      ...(message.providerState?.protocol === 'openai-chat' && model?.provider === message.provider && model.id === message.model ?
        { reasoning_content: message.providerState.reasoningContent } : {}),
      ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function',
        function: { name: call.name, arguments: call.arguments } })) } : {}) };
  });
}
export function usage(raw: unknown, anthropic = false): Usage {
  const u = raw && typeof raw === 'object' ? record(raw) : {};
  return { input: number(u.input_tokens ?? u.prompt_tokens), output: number(u.output_tokens ?? u.completion_tokens),
    cacheRead: number(anthropic ? u.cache_read_input_tokens : u.input_tokens_details ? record(u.input_tokens_details).cached_tokens :
      u.prompt_tokens_details ? record(u.prompt_tokens_details).cached_tokens : u.prompt_cache_hit_tokens),
    cacheWrite: number(u.cache_creation_input_tokens) };
}
export function items(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
export { record, string, number };
