import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { AgentSession, DEFAULT_SYSTEM } from './agent.js';
import { SessionStore } from './session.js';
import { ToolRegistry } from './tools/registry.js';
import { Workspace } from './tools/workspace.js';
import { trackedFileTools } from './changes.js';
import { shellTool } from './tools/shell.js';
import { loadConfig } from './config.js';
import { runDemo } from './demo.js';
import { serveRpc } from './rpc.js';
import { ProjectResources } from './resources.js';
import { errorText } from './util.js';

const help = `Local Coding Agent Core 0.1\n\nCommands:\n  demo                                    Offline fixture model + real file tools\n  run --config models.json --workspace DIR --prompt TEXT\n  rpc --config models.json --workspace DIR\n\nOptions:\n  --model provider/model   Override configured or restored model\n  --resume FILE            Resume a saved session (workspace must match)\n  --allow-write            Enable write/edit tools\n  --allow-shell            Enable shell tool with your OS permissions\n  --max-turns N            Limit model/tool turns (default 30)\n  --help                   Show usage\n\nOutput is JSONL. API keys are read only from configured environment variables.`;

async function main(): Promise<void> {
  const args = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, workspace: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, resume: { type: 'string' },
    'allow-write': { type: 'boolean' }, 'allow-shell': { type: 'boolean' }, 'max-turns': { type: 'string' }, help: { type: 'boolean' },
  } });
  const command = args.positionals[0];
  if (args.values.help || !command) { process.stdout.write(help + '\n'); return; }
  const write = (line: string) => process.stdout.write(line + '\n');
  if (command === 'demo') { await runDemo(write); return; }
  if (!['run', 'rpc'].includes(command) || !args.values.config || !args.values.workspace) throw new Error(help);
  const { registry, config } = await loadConfig(resolve(args.values.config));
  const workspace = await Workspace.open(resolve(args.values.workspace));
  const resources = await ProjectResources.load(workspace);
  const store = args.values.resume ? await SessionStore.resume(resolve(args.values.resume)) : await SessionStore.create(workspace.root);
  let agent: AgentSession | undefined;
  const allowedTools = ['read', ...(args.values['allow-write'] ? ['write', 'edit'] : []), ...(args.values['allow-shell'] ? ['shell'] : [])];
  try {
    if (store.workspace !== workspace.root) throw new Error('Resume workspace does not match requested project');
    const tools = new ToolRegistry(); trackedFileTools(workspace, store).forEach(t => tools.register(t)); tools.register(shellTool());
    agent = await AgentSession.create({ store, models: registry, tools,
      modelKey: args.values.model ?? (args.values.resume ? undefined : config.defaultModel),
      system: DEFAULT_SYSTEM + resources.prompt(),
      activeTools: allowedTools, allowedTools,
      maxTurns: args.values['max-turns'] ? Number(args.values['max-turns']) : undefined,
    });
    const onSignal = () => { void agent!.abort(); }; process.on('SIGINT', onSignal);
    try {
      if (command === 'rpc') await serveRpc(agent, process.stdin, process.stdout);
      else {
        if (!args.values.prompt?.trim()) throw new Error('--prompt is required');
        agent.subscribe(event => write(JSON.stringify(event)));
        const result = await agent.run(args.values.prompt);
        write(JSON.stringify({ type: 'result', session: store.path, result }));
        if (result.status !== 'completed') process.exitCode = 1;
      }
    } finally { process.removeListener('SIGINT', onSignal); }
  } finally { if (agent) await agent.close(); else await store.close(); }
}
main().catch(error => { process.stderr.write(errorText(error) + '\n'); process.exitCode = 1; });
