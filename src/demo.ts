import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AgentSession } from './agent.js';
import { ModelRegistry } from './models.js';
import { SessionStore } from './session.js';
import { ToolRegistry } from './tools/registry.js';
import { fileTools } from './tools/files.js';
import { Workspace } from './tools/workspace.js';
import type { AssistantMessage, ModelEvent, ModelRequest, Provider } from './types.js';

/** Deterministic fixture provider, explicitly not an actual LLM. */
export class DemoProvider implements Provider {
  readonly id = 'demo';
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    request.signal.throwIfAborted();
    const count = request.messages.filter(m => m.role === 'assistant').length;
    const call = count === 0 ? { id: 'demo-read', name: 'read', arguments: JSON.stringify({ path: 'hello.txt' }) } :
      count === 1 ? { id: 'demo-edit', name: 'edit', arguments: JSON.stringify({ path: 'hello.txt', oldText: 'Hello, world!', newText: 'Hello, coding agent!' }) } : undefined;
    const text = call ? '' : '演示完成：已读取并编辑 hello.txt。这里使用离线脚本模型，文件工具和会话存储均为真实执行。';
    if (text) yield { type: 'text_delta', text };
    const message: AssistantMessage = { role: 'assistant', text, toolCalls: call ? [call] : [], provider: this.id,
      model: request.model.id, stopReason: call ? 'tool_use' : 'stop', usage: { input: 0, output: 0 }, timestamp: Date.now() };
    yield { type: 'done', message };
  }
}
export async function runDemo(write: (line: string) => void): Promise<void> {
  const folder = await mkdtemp(resolve(tmpdir(), 'coding-agent-demo-'));
  await writeFile(resolve(folder, 'hello.txt'), 'Hello, world!\r\n', 'utf8');
  const workspace = await Workspace.open(folder);
  const models = new ModelRegistry().registerProvider(new DemoProvider()).registerModel({ provider: 'demo', id: 'offline', contextWindow: 32_000, maxOutputTokens: 1024, tools: true });
  const tools = new ToolRegistry(); fileTools(workspace).forEach(t => tools.register(t));
  const store = await SessionStore.create(folder);
  const agent = await AgentSession.create({ store, tools, models, modelKey: 'demo/offline' });
  agent.subscribe(event => write(JSON.stringify(event)));
  try {
    const result = await agent.run('Read hello.txt and change the greeting.');
    if (result.status !== 'completed') throw new Error(result.error);
    write(JSON.stringify({ type: 'demo_result', workspace: folder, session: store.path, file: await readFile(resolve(folder, 'hello.txt'), 'utf8') }));
  } finally { await agent.close(); }
}
