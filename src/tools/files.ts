import { readFile, stat } from 'node:fs/promises';
import type { Tool } from '../types.js';
import { bounded } from '../util.js';
import { Workspace } from './workspace.js';

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const path = { type: 'string', minLength: 1 };
const text = { type: 'string' };
const MAX_FILE = 4 * 1024 * 1024;
async function read(workspace: Workspace, input: string): Promise<string> {
  const target = await workspace.path(input); const info = await stat(target);
  if (!info.isFile() || info.size > MAX_FILE) throw new Error('File must be a regular text file no larger than 4 MiB');
  const content = await readFile(target, 'utf8'); if (content.includes('\0')) throw new Error('Binary files are not supported'); return content;
}
export function fileTools(workspace: Workspace): Tool[] {
  return [
    {
      name: 'read', kind: 'read', description: 'Read a text file. offset is 1-based; use limit for large files.',
      parameters: object({ path, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, ['path']),
      async execute(args, context) {
        context.signal.throwIfAborted(); const content = await read(workspace, args.path as string);
        const lines = content.split('\n'); const offset = (args.offset as number | undefined) ?? 1;
        const limit = (args.limit as number | undefined) ?? 200;
        return { text: bounded(lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}: ${line}`).join('\n') + `\n[${lines.length} lines total]`, 64 * 1024) };
      },
    },
    {
      name: 'write', kind: 'write', description: 'Create or replace a UTF-8 text file within the workspace.',
      parameters: object({ path, content: { ...text, maxLength: MAX_FILE } }, ['path', 'content']),
      async execute(args, context) {
        if (Buffer.byteLength(args.content as string) > MAX_FILE) throw new Error('UTF-8 content exceeds 4 MiB');
        await workspace.write(args.path as string, args.content as string, context.signal);
        return { text: `Wrote ${args.path}`, details: { path: args.path as string } };
      },
    },
    {
      name: 'edit', kind: 'write', description: 'Replace exactly one unique text region. Read the file first. CRLF and BOM are preserved.',
      parameters: object({ path, oldText: { ...text, minLength: 1 }, newText: text }, ['path', 'oldText', 'newText']),
      async execute(args, context) {
        const original = await read(workspace, args.path as string);
        const normalize = (value: string) => value.replace(/\r\n/g, '\n');
        const lf = normalize(original); const old = normalize(args.oldText as string);
        const first = lf.indexOf(old);
        if (first < 0 || lf.indexOf(old, first + 1) >= 0) throw new Error('oldText must match exactly one region; no file was changed');
        // Match with LF-tolerant coordinates, but splice the original text. Each
        // CRLF before a normalized boundary accounts for one omitted code unit.
        const end = first + old.length; let startRaw = first, endRaw = end, omitted = 0;
        for (const match of original.matchAll(/\r\n/g)) {
          const position = match.index - omitted;
          if (position >= end) break;
          if (position < first) startRaw++;
          endRaw++; omitted++;
        }
        const endings = original.slice(startRaw,endRaw).match(/\r\n|\n/g) ?? [];
        const localEnding = endings.at(-1) ?? original.slice(endRaw).match(/\r\n|\n/)?.[0] ?? original.slice(0,startRaw).match(/\r\n|\n/g)?.at(-1) ?? '\n';
        // Reuse the matched region's newline sequence; added lines inherit the
        // closest available style. Never rewrite the untouched prefix or suffix.
        let newline = 0;
        const replacement = normalize(args.newText as string).replace(/\n/g,() => endings[newline++] ?? localEnding);
        const updated = original.slice(0,startRaw) + replacement + original.slice(endRaw);
        if (Buffer.byteLength(updated) > MAX_FILE) throw new Error('Edited file exceeds 4 MiB');
        context.signal.throwIfAborted();
        // Detect outside edits between our read and commit; this is not an OS-level file lock.
        if (await read(workspace, args.path as string) !== original) throw new Error('File changed while preparing edit; read it again');
        await workspace.write(args.path as string, updated, context.signal);
        return { text: `Edited ${args.path}`, details: { path: args.path as string, oldText: args.oldText as string, newText: args.newText as string } };
      },
    },
  ];
}
