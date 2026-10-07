import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import type { TestContext } from 'node:test';
import { AgentSession, type AgentOptions } from '../src/agent.js';
import { ModelRegistry } from '../src/models.js';
import { SessionStore } from '../src/session.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Workspace } from '../src/tools/workspace.js';
import { fileTools } from '../src/tools/files.js';
import type { AssistantMessage, ModelRequest, ModelEvent, Provider, Tool, ToolCall } from '../src/types.js';

export const model = { provider: 'fixture', id: 'small', contextWindow: 32_000, maxOutputTokens: 1000, tools: true };
export function answer(text = 'done', toolCalls: ToolCall[] = [], stopReason: AssistantMessage['stopReason'] = toolCalls.length ? 'tool_use' : 'stop'): AssistantMessage {
  return { role: 'assistant', text, toolCalls, stopReason, provider: model.provider, model: model.id, usage: { input: 10, output: 2 }, timestamp: Date.now() };
}
export const call = (id: string, name: string, args: unknown): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
export type Step = AssistantMessage | ((request: ModelRequest) => AssistantMessage | Promise<AssistantMessage>);
export class ScriptedProvider implements Provider {
  readonly id = 'fixture'; requests: ModelRequest[] = []; private index = 0;
  constructor(private steps: Step[]) {}
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    this.requests.push(request); request.signal.throwIfAborted();
    const step = this.steps[this.index++]; if (!step) throw new Error('Unexpected fixture model call');
    const message = typeof step === 'function' ? await step(request) : step;
    if (message.text) yield { type: 'text_delta', text: message.text };
    yield { type: 'done', message: { ...message, provider: request.model.provider, model: request.model.id } };
  }
}
export function latch<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve };
}
export function echoTool(execute: Tool['execute'] = async args => ({ text: String(args.value) })): Tool {
  return { name: 'echo', kind: 'read', description: 'Echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, execute };
}
export async function temp(t: TestContext): Promise<{ root: string; cleanup: (() => Promise<void>)[] }> {
  const parent = resolve(tmpdir()); const root = await mkdtemp(resolve(parent, 'coding-agent-test-')); const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    if (dirname(root) !== parent) throw new Error('Refusing to remove a directory outside test temp root');
    await rm(root, { recursive: true, force: true });
  }); return { root, cleanup };
}
export async function fixture(t: TestContext, steps: Step[], toolsExtra: Tool[] = [], options: Partial<AgentOptions> = {}) {
  const { root, cleanup } = await temp(t); const workspace = await Workspace.open(root);
  const store = await SessionStore.create(root); cleanup.push(() => store.close());
  const provider = new ScriptedProvider(steps); const models = new ModelRegistry().registerProvider(provider).registerModel(model)
    .registerModel({ ...model, id: 'other' });
  const tools = new ToolRegistry(); [...fileTools(workspace), ...toolsExtra].forEach(tool => tools.register(tool));
  const agent = await AgentSession.create({ store, models, tools, modelKey: 'fixture/small', ...options }); cleanup.push(() => agent.close());
  return { root, workspace, agent, store, tools, provider, models };
}
