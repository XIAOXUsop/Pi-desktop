import { lstat, realpath, readFile, readdir, open, unlink, rmdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

// Only the selected journal and its flat snapshot folder may be removed.
export async function deleteSessionFiles(workspace, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error('无效会话');
  const root = await realpath(workspace);
  async function checked(parts, directory, optional = false) {
    let target = root;
    for (let index = 0; index < parts.length; index++) {
      target = resolve(target, parts[index]);
      const rel = relative(root, target);
      if (!rel || rel === '..' || rel.startsWith('..' + sep)) throw new Error('会话路径超出项目');
      let info;
      try { info = await lstat(target); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
      const isDirectory = index < parts.length - 1 || directory;
      if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile()) || await realpath(target) !== target) throw new Error('会话路径包含链接或异常文件，无法删除');
    }
    return target;
  }
  const journal = await checked(['.agent', 'sessions', `${id}.jsonl`], false);
  const lockPath = `${journal}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('会话正在其他窗口使用，请关闭后再删除'); throw error; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    const header = JSON.parse((await readFile(journal, 'utf8')).split('\n', 1)[0]);
    if (header.type !== 'header' || header.version !== 1 || header.sessionId !== id || header.workspace !== root) throw new Error('会话不属于当前项目');
    const snapshots = await checked(['.agent', 'changes', id], true, true);
    const piState = await checked(['.agent', 'pi-state', `${id}.json`], false, true);
    const files = [];
    if (snapshots) for (const name of await readdir(snapshots)) files.push(await checked(['.agent', 'changes', id, name], false));
    for (const path of files) await unlink(path);
    if (snapshots) await rmdir(snapshots);
    if (piState) await unlink(piState);
    await unlink(journal);
  } finally { await lock.close(); await unlink(lockPath); }
}
