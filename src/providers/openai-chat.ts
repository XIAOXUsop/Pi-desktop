import type { Provider, ModelEvent, ModelRequest, ToolCall, StopReason, Usage } from '../types.js';
import { HttpProvider, assistant, chatMessages, items, json, record, string, usage, type HttpProviderOptions } from './http.js';

export interface OpenAIChatOptions extends HttpProviderOptions {
  tokenLimitField?: 'max_completion_tokens' | 'max_tokens'; streamUsage?: boolean;
  thinking?: 'enabled' | 'disabled';
}

/** OpenAI Chat Completions and compatible APIs (DeepSeek, local model servers, etc.). */
export class OpenAIChatProvider extends HttpProvider implements Provider {
  constructor(private chatOptions: OpenAIChatOptions) { super(chatOptions); }
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    let text = ''; let reasoningContent: string | undefined; const calls = new Map<number, ToolCall>(); let finish: StopReason | undefined;
    let tokens: Usage = { input: 0, output: 0 };
    const payload = {
      model: request.model.id, messages: [{ role: 'system', content: request.system }, ...chatMessages(request.messages, request.model)],
      stream: true, ...(this.chatOptions.streamUsage !== false ? { stream_options: { include_usage: true } } : {}),
      [this.chatOptions.tokenLimitField ?? 'max_completion_tokens']: request.model.maxOutputTokens,
      ...(request.model.reasoningEffort ? { reasoning_effort: request.model.reasoningEffort } : {}),
      ...(this.chatOptions.thinking ? { thinking: { type: this.chatOptions.thinking } } : {}),
      ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function', function: tool })) } : {}),
    };
    for await (const event of this.request('chat/completions', payload, request)) {
      if (event.data === '[DONE]') break;
      const data = json(event.data); if (data.error) throw new Error('Provider reported a stream error');
      if (data.usage) tokens = usage(data.usage);
      for (const choice of items(data.choices)) {
        if (choice.index !== undefined && choice.index !== 0) continue;
        const delta = choice.delta ? record(choice.delta) : {};
        if (typeof delta.reasoning_content === 'string') reasoningContent = (reasoningContent ?? '') + delta.reasoning_content;
        if (typeof delta.content === 'string') { text += delta.content; yield { type: 'text_delta', text: delta.content }; }
        for (const fragment of items(delta.tool_calls)) {
          if (typeof fragment.index !== 'number' || !Number.isSafeInteger(fragment.index) || fragment.index < 0) throw new Error('Invalid tool index');
          const index = fragment.index; const fn = fragment.function ? record(fragment.function) : {};
          const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
          call.id = string(fragment.id, call.id); call.name += string(fn.name); call.arguments += string(fn.arguments);
          calls.set(index, call);
          yield { type: 'tool_delta', index, id: call.id, name: string(fn.name), arguments: string(fn.arguments) };
        }
        if (choice.finish_reason != null) {
          const reason = string(choice.finish_reason);
          if (!['stop', 'tool_calls', 'length'].includes(reason)) throw new Error(`Unsupported finish reason: ${reason}`);
          finish = reason === 'tool_calls' ? 'tool_use' : reason as StopReason;
        }
      }
    }
    if (!finish) throw new Error('Provider stream ended without a finish reason');
    const message = assistant(request, text, [...calls].sort(([a], [b]) => a - b).map(([, c]) => c), finish, tokens);
    if (reasoningContent !== undefined) message.providerState = { protocol: 'openai-chat', reasoningContent };
    yield { type: 'done', message };
  }
}
