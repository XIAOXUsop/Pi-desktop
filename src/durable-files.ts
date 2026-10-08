import {mkdir, lstat, realpath, open, rename, unlink, readFile} from 'node:fs/promises';
import {resolve, relative, isAbsolute, dirname, basename, sep} from 'node:path';
import {randomUUID} from 'node:crypto';

export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function checkedId(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid state identity');
  return value;
}
export class StateDirectory {
  private constructor(readonly root: string) {}
  static async open(root: string) { return new StateDirectory(await realpath(root)); }
  async path(parts: string[], create = false): Promise<string> {
    if (parts.some(p => !p || p === '.' || p === '..' || /[\\/:\0]/.test(p))) throw new Error('Invalid state path');
    let current = this.root;
    for (let index = 0; index < parts.length; index++) {
      current = resolve(current, parts[index]!);
      const rel = relative(this.root, current);
      if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('State path escapes project');
      let info = await lstat(current).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
      if (!info && create && index < parts.length - 1) {
        await mkdir(current).catch(error => {if (error.code !== 'EEXIST') throw error;});
        info = await lstat(current);
      }
      if (info && (info.isSymbolicLink() || await realpath(current) !== current ||
        (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink > 1))) throw new Error('Unsafe state path');
    }
    return current;
  }
}
export async function durableBytes(path: string, value: Uint8Array | string): Promise<void> {
  const temp = resolve(dirname(path), '.' + basename(path) + '.' + randomUUID() + '.tmp');
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    const info = await lstat(path).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)) throw new Error('Unsafe destination');
    await rename(temp, path);
  } finally { await unlink(temp).catch(error => {if (error.code !== 'ENOENT') throw error;}); }
}
export async function durableJson(path: string, value: unknown): Promise<void> {
  await durableBytes(path, JSON.stringify(value) + '\n');
}
export async function readJson(path: string, maxBytes = 8 * 1024 * 1024): Promise<any> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > maxBytes) throw new Error('Invalid state file');
  return JSON.parse(await readFile(path, 'utf8'));
}
