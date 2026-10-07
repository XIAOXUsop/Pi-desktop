import { open, mkdir, readFile, unlink, truncate, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileChange, Message, Model, Usage, RunResult } from './types.js';
import { clone, record, string } from './util.js';

export type EntryData =
  | { kind: 'run_result'; runId: string; assistantEntryId: string | null; result: Omit<RunResult, 'text'> }
  | { kind: 'message'; message: Message }
  | { kind: 'model'; model: Model }
  | { kind: 'config'; system: string; tools: string[] }
  | { kind: 'file_change'; change: FileChange }
  | { kind: 'compaction'; summary: string; keepFromId: string; usage: Usage };
export interface Entry { type: 'entry'; id: string; parentId: string | null; timestamp: number; data: EntryData }
interface Header { type: 'header'; version: 1; sessionId: string; workspace: string; createdAt: number }
type Cursor = { type: 'cursor'; leafId: string | null };
type Journal = Header | Entry | Cursor;

function validateUsage(value: unknown): void {
  const usage = record(value);
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (usage[key] === undefined && key.startsWith('cache')) continue;
    if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0) throw new Error('Invalid usage');
  }
}

function validateMessage(value: unknown): asserts value is Message {
  const m = record(value);
  if (!Number.isFinite(m.timestamp) || typeof m.text !== 'string') throw new Error('Invalid message');
  if (m.role === 'user') return;
  if (m.role === 'tool' && typeof m.callId === 'string' && typeof m.name === 'string' && typeof m.isError === 'boolean') return;
  if (m.role === 'assistant' && typeof m.provider === 'string' && typeof m.model === 'string' &&
    ['stop', 'tool_use', 'length'].includes(string(m.stopReason)) && Array.isArray(m.toolCalls)) {
    validateUsage(m.usage);
    if (m.executionStatus !== undefined && !['completed', 'cancelled', 'failed', 'limit'].includes(string(m.executionStatus))) throw new Error('Invalid execution status');
    if (m.finishReason !== undefined && typeof m.finishReason !== 'string') throw new Error('Invalid finish reason');
    if (m.phase !== undefined && !['commentary','final_answer'].includes(string(m.phase))) throw new Error('Invalid assistant phase');
    if (m.reasoning !== undefined) {
      if (!Array.isArray(m.reasoning)) throw new Error('Invalid reasoning');
      for (const value of m.reasoning) {
        const part = record(value);
        if (!Number.isSafeInteger(part.index) || (part.index as number) < 0 || typeof part.text !== 'string' ||
          (part.redacted !== undefined && typeof part.redacted !== 'boolean') || (part.redacted && part.text)) throw new Error('Invalid reasoning');
      }
    }
    if (m.providerState !== undefined) {
      const state = record(m.providerState);
      if (!(state.protocol === 'openai-responses' && Array.isArray(state.output)) &&
          !(state.protocol === 'openai-chat' && typeof state.reasoningContent === 'string')) throw new Error('Invalid provider state');
    }
    for (const item of m.toolCalls) {
      const call = record(item);
      if (![call.id, call.name, call.arguments].every(v => typeof v === 'string')) throw new Error('Invalid tool call');
    }
    return;
  }
  throw new Error('Invalid message role or fields');
}
function validateData(value: unknown): asserts value is EntryData {
  const data = record(value);
  if (data.kind === 'message') { validateMessage(data.message); return; }
  if (data.kind === 'run_result') {
    const result = record(data.result);
    if (typeof data.runId !== 'string' || !(data.assistantEntryId === null || typeof data.assistantEntryId === 'string') ||
        !['completed', 'cancelled', 'failed', 'limit'].includes(string(result.status)) || !Number.isSafeInteger(result.turns) || (result.turns as number) < 0 ||
        (result.error !== undefined && typeof result.error !== 'string')) throw new Error('Invalid run result');
    return;
  }
  if (data.kind === 'config' && typeof data.system === 'string' && Array.isArray(data.tools) && data.tools.every(t => typeof t === 'string')) return;
  if (data.kind === 'file_change') {
    const change = record(data.change);
    if (typeof change.id !== 'string' || typeof change.callId !== 'string' || typeof change.path !== 'string' ||
        !['create', 'update'].includes(string(change.operation)) || !Number.isFinite(change.timestamp) ||
        typeof change.patch !== 'string' || typeof change.patchTruncated !== 'boolean' ||
        !Number.isSafeInteger(change.addedLines) || !Number.isSafeInteger(change.removedLines)) throw new Error('Invalid file change');
    for (const side of ['before', 'after']) {
      const snapshot = record(change[side]);
      if (typeof snapshot.exists !== 'boolean' || !(snapshot.hash === null || typeof snapshot.hash === 'string') ||
          !(snapshot.snapshot === null || typeof snapshot.snapshot === 'string')) throw new Error('Invalid file snapshot');
    }
    return;
  }
  if (data.kind === 'model') {
    const model = record(data.model);
    if (typeof model.provider === 'string' && typeof model.id === 'string' && typeof model.tools === 'boolean' &&
      Number.isSafeInteger(model.contextWindow) && Number.isSafeInteger(model.maxOutputTokens) &&
      (model.maxOutputTokens as number) > 0 && (model.contextWindow as number) >= (model.maxOutputTokens as number)) return;
  }
  if (data.kind === 'compaction' && typeof data.summary === 'string' && typeof data.keepFromId === 'string') {
    validateUsage(data.usage); return;
  }
  throw new Error('Invalid session entry data');
}

/** Append-only session journal. The single-writer lock prevents two workers sharing a transcript. */
export class SessionStore {
  private entries = new Map<string, Entry>();
  private leafId: string | null = null;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;
  private lockOwned = false;
  private constructor(readonly path: string, readonly header: Header) {}
  get id(): string { return this.header.sessionId; }
  get workspace(): string { return this.header.workspace; }
  get leaf(): string | null { return this.leafId; }
  static async create(workspace: string, path?: string): Promise<SessionStore> {
    const canonical = await realpath(workspace); const sessionId = randomUUID();
    const target = resolve(path ?? resolve(canonical, '.agent/sessions', `${sessionId}.jsonl`));
    await mkdir(dirname(target), { recursive: true });
    const header: Header = { type: 'header', version: 1, sessionId, workspace: canonical, createdAt: Date.now() };
    const store = new SessionStore(target, header); await store.lock();
    try { const handle = await open(target, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(header) + '\n'); await handle.sync(); } finally { await handle.close(); } }
    catch (error) { await store.close(); throw error; }
    return store;
  }
  static async resume(path: string): Promise<SessionStore> {
    const target = resolve(path);
    // Lock before reading or repairing a torn final line.
    const store = new SessionStore(target, {} as Header); await store.lock();
    try {
      const raw = await readFile(target); let validLength = raw.length;
      let lines = raw.toString('utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      else {
        const last = lines.at(-1)!;
        try { JSON.parse(last); } catch {
          const end = raw.lastIndexOf(10); if (end < 0) throw new Error('Truncated session header');
          validLength = end + 1; lines.pop();
        }
      }
      const header = record(JSON.parse(lines.shift() ?? '{}'));
      if (header.type !== 'header' || header.version !== 1 || typeof header.sessionId !== 'string' || typeof header.workspace !== 'string') throw new Error('Unsupported session header');
      Object.assign(store.header, header);
      if (await realpath(store.workspace) !== store.workspace) throw new Error('Session workspace has changed');
      for (const line of lines) {
        const raw = record(JSON.parse(line));
        if (raw.type === 'cursor') {
          if (raw.leafId !== null && (typeof raw.leafId !== 'string' || !store.entries.has(raw.leafId))) throw new Error('Invalid session cursor');
          store.leafId = raw.leafId as string | null;
        } else if (raw.type === 'entry') {
          if (typeof raw.id !== 'string' || !raw.id || store.entries.has(raw.id) || !Number.isFinite(raw.timestamp)) throw new Error('Invalid session entry');
          if (raw.parentId !== null && (typeof raw.parentId !== 'string' || !store.entries.has(raw.parentId))) throw new Error('Missing entry parent');
          validateData(raw.data);
          const entry = raw as unknown as Entry;
          if (entry.data.kind === 'compaction') {
            const boundary = entry.data.keepFromId;
            if (!store.ancestors(entry.parentId).some(e => e.id === boundary)) throw new Error('Invalid compaction boundary');
          }
          store.entries.set(entry.id, entry); store.leafId = entry.id;
        } else throw new Error('Invalid journal record');
      }
      if (validLength < raw.length) await truncate(target, validLength);
      else if (raw.length && raw.at(-1) !== 10) await store.writeRaw('\n');
      return store;
    } catch (error) { await store.close(); throw error; }
  }
  private async lock(): Promise<void> {
    const target = `${this.path}.lock`;
    try {
      const handle = await open(target, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); } finally { await handle.close(); }
      this.lockOwned = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = record(JSON.parse(await readFile(target, 'utf8')));
      if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) throw new Error('Invalid session lock; inspect it before recovery');
      try { process.kill(owner.pid as number, 0); } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(target); return this.lock(); }
      }
      throw new Error('Session is already open in another worker');
    }
  }
  private writeRaw(text: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Session is closed'));
    const next = this.writing.then(async () => {
      const handle = await open(this.path, 'a', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    });
    this.writing = next; return next;
  }
  private write(value: Journal): Promise<void> { return this.writeRaw(JSON.stringify(value) + '\n'); }
  async append(data: EntryData): Promise<Entry> {
    if (this.closed) throw new Error('Session is closed');
    // All state changes must reserve their position synchronously before awaiting I/O.
    validateData(data);
    if (data.kind === 'compaction' && !this.branch().some(e => e.id === data.keepFromId)) throw new Error('Compaction boundary is not on active branch');
    const entry: Entry = { type: 'entry', id: randomUUID(), parentId: this.leafId, timestamp: Date.now(), data: clone(data) };
    this.entries.set(entry.id, entry); this.leafId = entry.id;
    try { await this.write(entry); } catch (error) { this.closed = true; throw error; }
    return clone(entry);
  }
  async select(leafId: string | null): Promise<void> {
    if (this.closed) throw new Error('Session is closed');
    if (leafId !== null && !this.entries.has(leafId)) throw new Error('Unknown branch node');
    this.leafId = leafId;
    try { await this.write({ type: 'cursor', leafId }); } catch (error) { this.closed = true; throw error; }
  }
  private ancestors(leaf: string | null): Entry[] {
    const list: Entry[] = [];
    while (leaf !== null) { const e = this.entries.get(leaf); if (!e) throw new Error('Broken session tree'); list.push(e); leaf = e.parentId; }
    return list.reverse();
  }
  branch(leafId: string | null = this.leafId): Entry[] { return this.ancestors(leafId).map(clone); }
  all(): Entry[] { return [...this.entries.values()].map(clone); }
  context(): { entryId: string; message: Message }[] {
    const branch = this.branch(); let lastCompact = -1;
    for (let i = 0; i < branch.length; i++) if (branch[i]?.data.kind === 'compaction') lastCompact = i;
    if (lastCompact < 0) return branch.flatMap(e => e.data.kind === 'message' ? [{ entryId: e.id, message: e.data.message }] : []);
    const compact = branch[lastCompact]!.data as Extract<EntryData, { kind: 'compaction' }>;
    const start = branch.findIndex(e => e.id === compact.keepFromId);
    const summary: Message = { role: 'user', text: `[Earlier conversation summary]\n${compact.summary}`, timestamp: branch[lastCompact]!.timestamp };
    return [{ entryId: branch[lastCompact]!.id, message: summary }, ...branch.slice(start).flatMap(e => e.data.kind === 'message' ? [{ entryId: e.id, message: e.data.message }] : [])];
  }
  messages(): Message[] { return this.context().map(item => item.message); }
  last<K extends EntryData['kind']>(kind: K): Extract<EntryData, { kind: K }> | undefined {
    const data = this.branch().reverse().find(e => e.data.kind === kind)?.data;
    return data as Extract<EntryData, { kind: K }> | undefined;
  }
  usage(): Usage {
    const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const entry of this.entries.values()) {
      const data = entry.data; const u = data.kind === 'compaction' ? data.usage : data.kind === 'message' && data.message.role === 'assistant' ? data.message.usage : undefined;
      if (u) { total.input += u.input; total.output += u.output; total.cacheRead! += u.cacheRead ?? 0; total.cacheWrite! += u.cacheWrite ?? 0; }
    }
    return total;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.writing.catch(() => {});
    if (this.lockOwned) {
      this.lockOwned = false;
      await unlink(`${this.path}.lock`).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
