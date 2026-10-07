import type { Provider, ModelEvent, ModelRequest, ToolCall, StopReason, Json } from '../types.js';
import { HttpProvider, assistant, items, json, record, string, usage } from './http.js';

export class OpenAIResponsesProvider extends HttpProvider implements Provider {
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const input: Record<string, unknown>[] = [];
    for (const message of request.messages) {
      if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.callId, output: message.text });
      else if (message.role === 'user') input.push({ role: 'user', content: message.text });
      else {
        if (message.providerState?.protocol === 'openai-responses' && message.provider === request.model.provider && message.model === request.model.id) {
          input.push(...message.providerState.output.map(record)); continue;
        }
        if (message.text) input.push({ role: 'assistant', content: message.text });
        for (const call of message.toolCalls) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
      }
    }
    const payload = { model: request.model.id, instructions: request.system, input, stream: true, store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: request.model.maxOutputTokens,
      ...(request.model.reasoningEffort ? { reasoning: { effort: request.model.reasoningEffort } } : {}),
      ...(request.tools.length ? { tools: request.tools.map(t => ({ type: 'function', ...t, strict: false })) } : {}) };
    let text = ''; const calls = new Map<number, ToolCall>(); let final: Record<string, unknown> | undefined;
    for await (const event of this.request('responses', payload, request)) {
      const data = json(event.data); const type = string(data.type, event.event);
      if (type === 'error' || type === 'response.failed') throw new Error('Provider reported a response error');
      if (type === 'response.output_text.delta') { text += string(data.delta); yield { type: 'text_delta', text: string(data.delta) }; }
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        const item = record(data.item); const index = data.output_index;
        if (item.type === 'function_call') {
          if (typeof index !== 'number') throw new Error('Invalid response output index');
          const previous = calls.get(index);
          calls.set(index, { id: string(item.call_id, previous?.id), name: string(item.name, previous?.name),
            arguments: string(item.arguments, previous?.arguments) });
          if (type.endsWith('.added')) yield { type: 'tool_delta', index, id: string(item.call_id), name: string(item.name) };
        }
      }
      if (type === 'response.function_call_arguments.delta') {
        const index = data.output_index; const call = calls.get(index as number);
        if (!call) throw new Error('Response arguments arrived before function call');
        call.arguments += string(data.delta); yield { type: 'tool_delta', index: index as number, arguments: string(data.delta) };
      }
      if (type === 'response.completed' || type === 'response.incomplete') { final = record(data.response); break; }
    }
    if (!final) throw new Error('Provider stream ended without a completed response');
    if (!Array.isArray(final.output)) throw new Error('Response is missing its final output snapshot');
    const output = items(final.output);
    // The final snapshot is authoritative; deltas exist only for UI responsiveness.
    const finalCalls = output.filter(item => item.type === 'function_call').map(item => ({ id: string(item.call_id), name: string(item.name), arguments: string(item.arguments) }));
    const finalText = output.filter(item => item.type === 'message').flatMap(item => items(item.content)).map(block => block.type === 'output_text' ? string(block.text) : block.type === 'refusal' ? string(block.refusal) : '').join('');
    const reason = final.status === 'incomplete' && final.incomplete_details ? string(record(final.incomplete_details).reason) : '';
    if (final.status !== 'completed' && reason !== 'max_output_tokens') throw new Error('Response did not complete successfully');
    const stopReason: StopReason = reason === 'max_output_tokens' ? 'length' : finalCalls.length ? 'tool_use' : 'stop';
    const message = assistant(request, finalText, finalCalls, stopReason, usage(final.usage));
    if (output.length) message.providerState = { protocol: 'openai-responses', output: output as Json[] };
    yield { type: 'done', message };
  }
}
