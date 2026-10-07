import type { Provider, ModelEvent, ModelRequest, Message, ToolCall, StopReason, Usage } from '../types.js';
import { HttpProvider, assistant, items, json, record, string, usage } from './http.js';

function messages(input: Message[]): { role: string; content: Record<string, unknown>[] }[] {
  const result: { role: string; content: Record<string, unknown>[] }[] = [];
  for (const message of input) {
    let role: string; const content: Record<string, unknown>[] = [];
    if (message.role === 'tool') {
      role = 'user'; content.push({ type: 'tool_result', tool_use_id: message.callId, content: message.text, is_error: message.isError });
    } else if (message.role === 'user') { role = 'user'; content.push({ type: 'text', text: message.text }); }
    else {
      role = 'assistant'; if (message.text) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls) {
        let input: unknown;
        try { input = JSON.parse(call.arguments); } catch { input = { _invalid_arguments: call.arguments }; }
        content.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
    }
    if (!content.length) continue;
    const last = result.at(-1);
    if (last?.role === role) last.content.push(...content); else result.push({ role, content });
  }
  return result;
}
export class AnthropicProvider extends HttpProvider implements Provider {
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    let text = ''; const calls = new Map<number, ToolCall>(); const streamedArgs = new Set<number>();
    let finish: StopReason | undefined; let stopped = false; let tokens: Usage = { input: 0, output: 0 };
    const payload = { model: request.model.id, system: request.system, messages: messages(request.messages),
      stream: true, max_tokens: request.model.maxOutputTokens,
      ...(request.tools.length ? { tools: request.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}) };
    for await (const event of this.request('messages', payload, request, 'anthropic')) {
      const data = json(event.data); const type = string(data.type, event.event);
      if (type === 'error') throw new Error('Provider reported a stream error');
      if (type === 'message_start') tokens = usage(record(data.message).usage, true);
      if (type === 'content_block_start') {
        const block = record(data.content_block); const index = data.index;
        if (typeof index !== 'number') throw new Error('Invalid content block index');
        if (block.type === 'tool_use') {
          calls.set(index, { id: string(block.id), name: string(block.name), arguments: JSON.stringify(block.input ?? {}) });
          yield { type: 'tool_delta', index, id: string(block.id), name: string(block.name) };
        } else if (block.type === 'text' && block.text) { text += string(block.text); yield { type: 'text_delta', text: string(block.text) }; }
      }
      if (type === 'content_block_delta') {
        const delta = record(data.delta); const index = data.index;
        if (delta.type === 'text_delta') { text += string(delta.text); yield { type: 'text_delta', text: string(delta.text) }; }
        else if (delta.type === 'input_json_delta') {
          const call = calls.get(index as number); if (!call) throw new Error('Tool arguments arrived before tool block');
          if (!streamedArgs.has(index as number)) { call.arguments = ''; streamedArgs.add(index as number); }
          call.arguments += string(delta.partial_json);
          yield { type: 'tool_delta', index: index as number, arguments: string(delta.partial_json) };
        }
      }
      if (type === 'message_delta') {
        const delta = record(data.delta); const reason = string(delta.stop_reason);
        if (reason) {
          if (!['end_turn', 'stop_sequence', 'tool_use', 'max_tokens'].includes(reason)) throw new Error(`Unsupported finish reason: ${reason}`);
          finish = reason === 'tool_use' ? 'tool_use' : reason === 'max_tokens' ? 'length' : 'stop';
        }
        if (data.usage) tokens.output = usage(data.usage, true).output;
      }
      if (type === 'message_stop') { stopped = true; break; }
    }
    if (!finish || !stopped) throw new Error('Provider stream ended before message_stop');
    yield { type: 'done', message: assistant(request, text, [...calls].sort(([a], [b]) => a - b).map(([, c]) => c), finish, tokens) };
  }
}
