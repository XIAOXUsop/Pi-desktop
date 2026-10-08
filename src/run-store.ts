import {readdir, open, readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {StateDirectory, checkedId, UUID, durableJson, readJson} from './durable-files.js';

export type TaskStatus = 'preparing' | 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'limit' | 'interrupted';
export const terminal = new Set<TaskStatus>(['completed', 'failed', 'cancelled', 'limit', 'interrupted']);
export interface RunRecord {
  version: 1; runId: string; sessionId: string; workspace: string; status: TaskStatus;
  requestId: string; parentRunId?: string; origin: string; workerGeneration: string; lastSequence: number;
  createdAt: number; updatedAt: number; branchStart: string | null; branchEnd?: string | null;
  tools: Record<string, {name: string; status: 'prepared' | 'running' | 'finished' | 'uncertain'; entryId?: string; isError?: boolean}>;
  metrics: {requests: number; tokens: number; cost: null; usageUnconfirmed: boolean};
  [key: string]: unknown;
}
const statuses = new Set([...terminal, 'preparing', 'running', 'stopping']);
export class RunStore {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(readonly directory: StateDirectory, readonly sessionId: string) {}
  static async open(workspace: string, sessionId: string): Promise<RunStore> {
    checkedId(sessionId);
    const directory = await StateDirectory.open(workspace);
    const journal = await directory.path(['.agent', 'sessions', sessionId + '.jsonl']);
    const header = JSON.parse((await readFile(journal, 'utf8')).split('\n', 1)[0]!);
    if (header.type !== 'header' || header.version !== 1 || header.workspace !== directory.root || header.sessionId !== sessionId) throw new Error('Run session belongs to another project');
    return new RunStore(directory, sessionId);
  }
  private path(id: string, suffix = '.json', create = false) { return this.directory.path(['.agent', 'runs', this.sessionId, checkedId(id) + suffix], create); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
  async get(id: string): Promise<RunRecord> {
    const value = await readJson(await this.path(id));
    if (value.version !== 1 || value.workspace !== this.directory.root || value.sessionId !== this.sessionId ||
      value.runId !== id || !statuses.has(value.status) || !Number.isSafeInteger(value.lastSequence) ||
      !value.tools || !value.metrics || !UUID.test(value.workerGeneration)) throw new Error('Corrupt run record');
    return value;
  }
  async list(): Promise<RunRecord[]> {
    await this.queue;
    const probe = await this.directory.path(['.agent', 'runs', this.sessionId, 'index.json']);
    const names = await readdir(probe.substring(0, probe.length - 'index.json'.length)).catch(error => {if (error.code !== 'ENOENT') throw error; return [];});
    const records = [];
    for (const name of names) if (name.endsWith('.json') && UUID.test(name.slice(0, -5))) records.push(await this.get(name.slice(0, -5)));
    return records.sort((a, b) => b.createdAt - a.createdAt);
  }
  async create(data: {runId?: string; workerGeneration: string; branchStart: string | null; origin?: string; parentRunId?: string; [key: string]: unknown}): Promise<RunRecord> {
    return this.serial(async () => {
      const runId = checkedId(data.runId || randomUUID()), path = await this.path(runId, '.json', true);
      const existing = await readJson(path).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
      if (existing) throw new Error('Run already exists');
      checkedId(data.workerGeneration); if (data.parentRunId) checkedId(data.parentRunId);
      const now = Date.now();
      const record: RunRecord = {...data, version:1, runId, sessionId:this.sessionId, workspace:this.directory.root,
        requestId:typeof data.requestId === 'string' ? data.requestId : randomUUID(), origin:data.origin || 'user', status:'preparing',
        createdAt:now, updatedAt:now, lastSequence:0, tools:{}, metrics:{requests:0,tokens:0,cost:null,usageUnconfirmed:false}};
      await durableJson(path, record); return record;
    });
  }
  async update(id: string, patch: Partial<RunRecord>, kind = 'state'): Promise<RunRecord> {
    return this.serial(async () => {
      const record = await this.get(id);
      if (terminal.has(record.status)) {
        if (patch.status && patch.status !== record.status) throw new Error('Run is already terminal');
        if(Object.keys(patch).some(key=>!['recoveredBy','acknowledgedAt','rollbackOperationId','checkpoint','checkpointExpired'].includes(key))) return record;
      }
      if (patch.runId || patch.sessionId || patch.workspace || patch.version || patch.workerGeneration) throw new Error('Immutable run identity');
      if (patch.status && !statuses.has(patch.status)) throw new Error('Invalid run state');
      const next = {...record, ...patch, lastSequence:record.lastSequence + 1, updatedAt:Date.now()};
      const file = await open(await this.path(id, '.events.jsonl', true), 'a', 0o600);
      try {await file.writeFile(JSON.stringify({sequence:next.lastSequence,type:kind,status:next.status,timestamp:next.updatedAt}) + '\n');await file.sync();}
      finally {await file.close();}
      await durableJson(await this.path(id), next); return next;
    });
  }
  async partial(id: string, value: unknown): Promise<void> {
    return this.serial(async () => {const record = await this.get(id);if (!terminal.has(record.status)) await durableJson(await this.path(id, '.partial.json', true), value);});
  }
  async getPartial(id: string) {return readJson(await this.path(id, '.partial.json')).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});}
  async interrupt(generation?: string): Promise<void> {
    for (const record of await this.list()) if (!terminal.has(record.status) && (!generation || record.workerGeneration === generation)) {
      const tools = structuredClone(record.tools);
      for (const tool of Object.values(tools)) if (tool.status !== 'finished') tool.status = 'uncertain';
      await this.update(record.runId, {status:'interrupted', tools, error:{code:'worker_exit',stage:'execution'}}, 'interrupted');
    }
  }
  async reconcile(): Promise<void> {
    const journal = await this.directory.path(['.agent', 'sessions', this.sessionId + '.jsonl']);
    const results = new Map<string, any>();
    for (const line of (await readFile(journal, 'utf8')).split('\n').filter(Boolean)) {
      let entry;try {entry = JSON.parse(line);} catch {continue;}
      if (entry.data?.kind === 'run_result' && ['completed','cancelled','failed','limit'].includes(entry.data.result?.status)) results.set(entry.data.runId, entry);
    }
    for (const record of await this.list()) if (!terminal.has(record.status)) {
      const entry = results.get(record.runId);
      if (entry) await this.update(record.runId, {status:entry.data.result.status,result:entry.data.result,durableDesktopEntryId:entry.id}, 'reconciled');
    }
  }
}
