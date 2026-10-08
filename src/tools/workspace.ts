import { realpath, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';

export class Workspace {
  private constructor(readonly root: string) {}
  static async open(path: string): Promise<Workspace> { return new Workspace(await realpath(path)); }
  private inside(path: string): void {
    const rel = relative(this.root, path);
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('Path escapes workspace');
    const parts = rel.split(/[\\/]/);
    if (parts.some(p => ['.git', '.agent'].includes(p.toLowerCase().replace(/[. ]+$/, '')))) throw new Error('Agent state and Git metadata are protected');
    if (process.platform === 'win32' && parts.some(p => p && (p.includes(':') || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))) {
      throw new Error('Windows device paths, alternate streams and ambiguous path names are not allowed');
    }
  }
  async path(input: string, createParent = false): Promise<string> {
    if (!input || input.includes('\0')) throw new Error('Invalid path');
    const path = resolve(this.root, input); this.inside(path);
    const rel = relative(this.root, path); let current = this.root;
    for (const part of rel.split(/[\\/]/).filter(Boolean)) {
      current = resolve(current, part);
      try { const stat = await lstat(current); if (stat.isSymbolicLink()) throw new Error('Symbolic links and junctions are not allowed by file tools'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    // Check the nearest existing ancestor against its real path as well.
    let ancestor = path;
    while (true) {
      try { this.inside(await realpath(ancestor)); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
    }
    if (createParent) { await mkdir(dirname(path), { recursive: true }); await this.path(path); }
    return path;
  }
  async write(input: string, text: string, signal: AbortSignal): Promise<void> {
    return this.writeBytes(input,Buffer.from(text,'utf8'),signal);
  }
  async writeBytes(input:string, bytes:Uint8Array, signal:AbortSignal, restoredMode?:number):Promise<void> {
    const path = await this.path(input, true); signal.throwIfAborted();
    let mode = 0o644;
    try { const stat = await lstat(path); if (!stat.isFile()) throw new Error('Target is not a regular file'); if (stat.nlink > 1) throw new Error('Hard-linked files are not writable'); mode = stat.mode & 0o777; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if(restoredMode!==undefined)mode=restoredMode&0o777;
    const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
      try { await handle.writeFile(bytes, {signal}); await handle.sync(); } finally { await handle.close(); }
      signal.throwIfAborted(); await this.path(path); await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
