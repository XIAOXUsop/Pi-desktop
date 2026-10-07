import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { AgentSession } from './agent.js';
import { errorText, record, string } from './util.js';

/** Version 1 JSONL protocol for a future desktop worker. No HTTP listener or public port. */
export async function serveRpc(agent: AgentSession, input: Readable, output: Writable): Promise<void> {
  const write = (value: unknown) => output.write(JSON.stringify(value) + '\n');
  const unsubscribe = agent.subscribe(event => write({ type: 'event', event }));
  const lines = createInterface({ input, crlfDelay: Infinity });
  const runPromises = new Set<Promise<unknown>>();
  try {
    for await (const line of lines) {
      let id: unknown = null;
      try {
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('RPC message exceeds 1 MiB');
        const command = record(JSON.parse(line));
        if (typeof command.id !== 'string' && typeof command.id !== 'number') throw new Error('RPC id must be a string or number');
        id = command.id; const method = string(command.method); const params = command.params ? record(command.params) : {};
        let result: unknown;
        switch (method) {
          case 'initialize': result = { protocolVersion: 1, capabilities: ['run', 'steer', 'follow_up', 'abort', 'set_model', 'set_tools', 'branch', 'history', 'state', 'clear_queues', 'changes'] }; break;
          case 'run': {
            if (agent.busy) throw new Error('Agent is busy; use steer or follow_up');
            const prompt = string(params.prompt); if (!prompt.trim()) throw new Error('Prompt must not be empty');
            const pending = agent.run(prompt).then(result => write({ type: 'run_result', id, result }));
            runPromises.add(pending); void pending.finally(() => runPromises.delete(pending));
            result = { accepted: true }; break;
          }
          case 'steer': agent.steer(string(params.prompt)); result = { queued: true }; break;
          case 'follow_up': agent.followUp(string(params.prompt)); result = { queued: true }; break;
          case 'abort': await agent.abort(); result = { stopped: true }; break;
          case 'set_model': await agent.setModel(string(params.key)); result = agent.state; break;
          case 'set_tools': {
            if (!Array.isArray(params.names) || !params.names.every(n => typeof n === 'string')) throw new Error('names must be a string array');
            await agent.setTools(params.names); result = agent.state; break;
          }
          case 'branch': {
            if (params.entryId !== null && typeof params.entryId !== 'string') throw new Error('entryId must be a string or null');
            await agent.branch(params.entryId); result = agent.state; break;
          }
          case 'history': result = { entries: agent.store.all(), leaf: agent.store.leaf }; break;
          case 'changes': result = { changes: agent.store.branch().flatMap(entry => entry.data.kind === 'file_change' ? [entry.data.change] : []) }; break;
          case 'state': result = agent.state; break;
          case 'clear_queues': agent.clearQueues(); result = agent.state; break;
          default: throw new Error(`Unknown RPC method: ${method}`);
        }
        write({ type: 'response', id, result });
      } catch (error) { write({ type: 'response', id, error: { message: errorText(error) } }); }
    }
  } finally {
    lines.close(); await agent.abort(); await Promise.allSettled(runPromises); unsubscribe(); await agent.close();
  }
}
