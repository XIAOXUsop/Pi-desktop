import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { structuredPatch, formatPatch } from 'diff';
import type { FileChange, FileSnapshot, Tool, ToolResult } from './types.js';
import { Workspace } from './tools/workspace.js';
import { SessionStore } from './session.js';
import { fileTools } from './tools/files.js';
import { bounded, errorText } from './util.js';

const MAX_FILE = 4 * 1024 * 1024;
interface Capture { text: string; hash: string | null; exists: boolean; bytes:Buffer; previewable:boolean }
/** Captures agent file-tool changes, independently of model output. Shell changes are not tracked here. */
export class ChangeTracker {
  constructor(private workspace: Workspace, private store: SessionStore,private maxBackupBytes=16*1024*1024) {}
  private async capture(path: string): Promise<Capture> {
    const target = await this.workspace.path(path);
    try {
      const info = await stat(target); if (!info.isFile() || info.size > this.maxBackupBytes) throw new Error('Change backup exceeds the configured file limit');
      const content = await readFile(target);let previewable=content.length<=MAX_FILE&&!content.includes(0);
      if(previewable)try{new TextDecoder('utf-8',{fatal:true}).decode(content);}catch{previewable=false;}
      return { exists: true, text:previewable?content.toString('utf8'):'',bytes:content,previewable,hash: createHash('sha256').update(content).digest('hex') };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, text: '', hash: null,bytes:Buffer.alloc(0),previewable:true }; throw error; }
  }
  private async snapshot(id: string, side: string, capture: Capture): Promise<FileSnapshot> {
    if (!capture.exists) return { exists: false, hash: null, snapshot: null };
    const folder = resolve(this.workspace.root, '.agent/changes', this.store.id); await mkdir(folder, { recursive: true });
    const target = resolve(folder, `${id}-${side}.txt`); await writeFile(target, capture.bytes, { flag: 'wx', mode: 0o600 });
    return { exists: true, hash: capture.hash, snapshot: relative(this.workspace.root, target).split(sep).join('/') };
  }
  wrap(tool: Tool): Tool {
    if (!['write', 'edit'].includes(tool.name)) return tool;
    return { ...tool, execute: async (args, context): Promise<ToolResult> => {
      const path = args.path as string; const id = randomUUID(); const before = await this.capture(path);
      const beforeSnapshot = await this.snapshot(id, 'before', before);
      let result: ToolResult;
      try { result = await tool.execute(args, context); }
      catch (error) { result = { text: errorText(error), isError: true }; }
      const after = await this.capture(path);
      if (before.hash === after.hash && before.exists === after.exists) return result;
      const afterSnapshot = await this.snapshot(id, 'after', after);
      const rel = relative(this.workspace.root, await this.workspace.path(path)).split(sep).join('/');
      const diff = before.previewable&&after.previewable?structuredPatch(before.exists ? rel : '/dev/null', rel, before.text, after.text, '', '', { context: 3, timeout: 1000 }):null;
      const fullPatch = diff ? formatPatch(diff) : '[Text preview unavailable; original byte snapshots retained]';
      const patch = bounded(fullPatch, 64 * 1024);
      const change: FileChange = { id, callId: context.callId, path: rel, operation: before.exists ? 'update' : 'create', timestamp: Date.now(),
        before: beforeSnapshot, after: afterSnapshot, patch, patchTruncated: patch !== fullPatch || !diff,
        addedLines: diff?.hunks.flatMap(h => h.lines).filter(line => line.startsWith('+')).length ?? 0,
        removedLines: diff?.hunks.flatMap(h => h.lines).filter(line => line.startsWith('-')).length ?? 0 };
      return { ...result, change, details: { path: rel, changeId: id } };
    } };
  }
}
export function trackedFileTools(workspace: Workspace, store: SessionStore, options?:{maxBackupBytes?:number}): Tool[] {
  const tracker = new ChangeTracker(workspace, store,options?.maxBackupBytes); return fileTools(workspace).map(tool => tracker.wrap(tool));
}
