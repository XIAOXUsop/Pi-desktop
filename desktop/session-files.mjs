import { lstat, realpath, readFile, readdir, open, unlink, rmdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

// Preflight the entire selected session before deleting any data. Shared blobs
// are left for reference-aware checkpoint maintenance on the next task.
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
      if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile()||info.nlink>1) || await realpath(target) !== target) throw new Error('会话路径包含链接或异常文件，无法删除');
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
    const directories=[];
    if (snapshots) for (const name of await readdir(snapshots)) files.push(await checked(['.agent', 'changes', id, name], false));
    const runs=await checked(['.agent','runs',id],true,true);
    if(runs){for(const name of await readdir(runs)){if(!/^[a-f0-9-]{36}\.(?:json|partial\.json|events\.jsonl)$/i.test(name)&&!/^\.[a-f0-9-]{36}\.(?:json|partial\.json)\.[a-f0-9-]{36}\.tmp$/i.test(name))throw new Error('会话包含未知运行文件，无法删除');files.push(await checked(['.agent','runs',id,name],false));}directories.push(runs);}
    const checkpoints=await checked(['.agent','checkpoints',id],true,true);
    if(checkpoints){
      const {CheckpointStore}=await import('../dist/src/checkpoints.js'),{RollbackService}=await import('../dist/src/rollback.js'),store=await CheckpointStore.open(root),rollback=new RollbackService(store);
      for(const run of await readdir(checkpoints)){
        if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(run))throw new Error('会话包含未知检查点，无法删除');
        await store.load(id,run);if((await rollback.operations(id,run)).some(op=>['prepared','applying'].includes(op.state)))throw new Error('请先处理未完成的撤销，再删除会话');
        const folder=await checked(['.agent','checkpoints',id,run],true);
        for(const name of await readdir(folder)){if(name!=='manifest.json'&&!/^rollback-[a-f0-9-]{36}\.json$/i.test(name)&&!/^\.(?:manifest\.json|rollback-[a-f0-9-]{36}\.json)\.[a-f0-9-]{36}\.tmp$/i.test(name))throw new Error('会话包含未知检查点文件，无法删除');files.push(await checked(['.agent','checkpoints',id,run,name],false));}directories.push(folder);
      }directories.push(checkpoints);
    }
    for (const path of files) await unlink(path);
    for(const path of directories)await rmdir(path);
    if (snapshots) await rmdir(snapshots);
    if (piState) await unlink(piState);
    await unlink(journal);
  } finally { await lock.close(); await unlink(lockPath); }
}
