import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, link, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Workspace } from '../src/tools/workspace.js';
import { fileTools } from '../src/tools/files.js';
import { shellTool } from '../src/tools/shell.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ProjectResources } from '../src/resources.js';
import {record} from '../src/util.js';
import { temp, latch } from './helpers.js';
import type { ToolContext } from '../src/types.js';

const context = (workspace: string, signal = new AbortController().signal): ToolContext => ({ workspace, signal, callId: 'test', update() {} });

test('edits preserve mixed line endings byte for byte outside the changed region',async t=>{
  const {root}=await temp(t),workspace=await Workspace.open(root),edit=fileTools(workspace).find(tool=>tool.name==='edit')!;
  const cases=[
    {original:'alpha\r\nbeta\ngamma\r\ndelta',old:'beta',replacement:'BETA',expected:'alpha\r\nBETA\ngamma\r\ndelta'},
    {original:'alpha\r\nbeta\ngamma\r\ndelta',old:'beta\ngamma',replacement:'BETA\nGAMMA',expected:'alpha\r\nBETA\nGAMMA\r\ndelta'},
    {original:'alpha\r\nbeta\ngamma\r\ndelta',old:'alpha\nbeta\ngamma',replacement:'ALPHA\nBETA\nGAMMA',expected:'ALPHA\r\nBETA\nGAMMA\r\ndelta'},
    {original:'\uFEFF🙂\r\n甲\nbeta\r\n尾',old:'甲\nbeta',replacement:'乙\nBETA',expected:'\uFEFF🙂\r\n乙\nBETA\r\n尾'},
    {original:'alpha\r\nbeta\ngamma\r\ndelta',old:'beta',replacement:'beta\nadded',expected:'alpha\r\nbeta\nadded\ngamma\r\ndelta'},
    {original:'alpha\r\nbeta\ngamma\r\ndelta',old:'beta\ngamma',replacement:'joined',expected:'alpha\r\njoined\r\ndelta'},
    {original:'alpha\r\nbeta\r\n',old:'alpha\nbeta\n',replacement:'ALPHA\nBETA\n',expected:'ALPHA\r\nBETA\r\n'},
    {original:'alpha\nbeta\n',old:'alpha\r\nbeta\r\n',replacement:'ALPHA\r\nBETA\r\n',expected:'ALPHA\nBETA\n'},
  ];
  for(const [index,item]of cases.entries()) {
    const path=`mixed-${index}.txt`;await writeFile(resolve(root,path),item.original);
    await edit.execute({path,oldText:item.old,newText:item.replacement},context(root));
    assert.deepEqual(await readFile(resolve(root,path)),Buffer.from(item.expected),`case ${index}`);
  }
  const ambiguous='alpha\r\nbeta alpha\nbeta';await writeFile(resolve(root,'ambiguous.txt'),ambiguous);
  await assert.rejects(edit.execute({path:'ambiguous.txt',oldText:'alpha\nbeta',newText:'x'},context(root)),/exactly one/);
  assert.equal(await readFile(resolve(root,'ambiguous.txt'),'utf8'),ambiguous);
});

test('read truncation at 64 KiB keeps Unicode valid including the numbered line prefix',async t=>{
  const {root}=await temp(t),workspace=await Workspace.open(root),read=fileTools(workspace).find(tool=>tool.name==='read')!;
  const marker='\n[output truncated]',prefix='x'.repeat(64*1024-Buffer.byteLength(marker)-4);
  await writeFile(resolve(root,'large.txt'),prefix+'你'.repeat(20));
  const result=await read.execute({path:'large.txt'},context(root));
  assert.equal(result.text,'1: '+prefix+marker);assert(!result.text.includes('\uFFFD'));assert(Buffer.byteLength(result.text)<=64*1024);
});
test('file paths reject traversal, Git/session metadata and directory junctions', async t => {
  const { root } = await temp(t); const workspace = await Workspace.open(root);
  for (const path of ['../escape', '.git/config', '.agent/sessions/x', 'sub/../.GIT/config']) await assert.rejects(workspace.path(path), /escapes|protected/);
  if (process.platform === 'win32') for (const path of ['file:stream', 'NUL.txt', '.git./config', '.git /config', 'file.']) await assert.rejects(workspace.path(path), /protected|not allowed/);
  await mkdir(resolve(root, 'actual')); await symlink(resolve(root, 'actual'), resolve(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.path('junction/file'), /links|junctions/);
});
test('atomic writes create parents and refuse hard-linked destinations', async t => {
  const { root } = await temp(t); const workspace = await Workspace.open(root);
  await workspace.write('nested/file.txt', 'first', new AbortController().signal); await workspace.write('nested/file.txt', 'second', new AbortController().signal);
  assert.equal(await readFile(resolve(root, 'nested/file.txt'), 'utf8'), 'second'); assert.deepEqual(await readdir(resolve(root, 'nested')), ['file.txt']);
  await link(resolve(root, 'nested/file.txt'), resolve(root, 'alias.txt'));
  await assert.rejects(workspace.write('alias.txt', 'bad', new AbortController().signal), /Hard-linked/); assert.equal(await readFile(resolve(root, 'alias.txt'), 'utf8'), 'second');
});
test('ambiguous edits, binary reads and oversized UTF-8 writes fail without replacing files', async t => {
  const { root } = await temp(t); const workspace = await Workspace.open(root); const tools = fileTools(workspace); const edit = tools.find(tool => tool.name === 'edit')!;
  await writeFile(resolve(root, 'file.txt'), 'same same');
  await assert.rejects(edit.execute({ path: 'file.txt', oldText: 'same', newText: 'x' }, context(root)), /exactly one/);
  await assert.rejects(edit.execute({ path: 'file.txt', oldText: 'absent', newText: 'x' }, context(root)), /exactly one/);
  assert.equal(await readFile(resolve(root, 'file.txt'), 'utf8'), 'same same');
  await writeFile(resolve(root, 'binary'), Buffer.from([1, 0, 2])); await assert.rejects(tools[0]!.execute({ path: 'binary' }, context(root)), /Binary/);
  await assert.rejects(tools[1]!.execute({ path: 'big', content: '你'.repeat(1500000) }, context(root)), /4 MiB/);
});
test('tool schemas reject unknown properties and never coerce arguments', () => {
  const registry = new ToolRegistry().register(shellTool());
  assert.throws(() => registry.validate('shell', '{"command":"echo ok","timeoutMs":"12"}'), /Invalid/);
  assert.throws(() => registry.validate('shell', '{"command":"echo ok","unexpected":true}'), /Invalid/);
  assert.throws(() => registry.validate('shell', '[]'), /Invalid/); assert.throws(() => registry.register(shellTool()), /duplicate/);
});
test('AGENTS and skill catalogs load from workspace; full bodies are read on demand', async t => {
  const { root } = await temp(t); const workspace = await Workspace.open(root);
  await writeFile(resolve(root, 'AGENTS.md'), 'Run project checks.'); await mkdir(resolve(root, '.agents/skills/check'), { recursive: true });
  await writeFile(resolve(root, '.agents/skills/check/SKILL.md'), '---\nname: project-check\ndescription: "Validate the project"\n---\nSECRET_FULL_BODY');
  const resources = await ProjectResources.load(workspace);
  assert.match(resources.prompt(), /Run project checks/); assert.match(resources.prompt(), /Validate the project/); assert.doesNotMatch(resources.prompt(), /SECRET_FULL_BODY/);
  assert.equal(resources.list()[0]?.name, 'project-check'); assert.match(await resources.readSkill('project-check'), /SECRET_FULL_BODY/);
});
test('shell returns exit errors and bounds large streamed output', { timeout: 10000 }, async t => {
  const { root } = await temp(t); const tool = shellTool();
  const bad = await tool.execute({ command: 'exit 7' }, context(root)); assert.equal(bad.isError, true); assert.match(bad.text, /exit=7/);
  const command = process.platform === 'win32' ? "[Console]::Write(('x' * 80000))" : "head -c 80000 /dev/zero | tr '\\0' x";
  const result = await tool.execute({ command }, context(root)); assert.equal(result.isError, false); assert.match(result.text, /truncated/); assert.ok(Buffer.byteLength(result.text) < 66 * 1024);
});

test('shell UTF-8 output cap drops an incomplete character instead of streaming U+FFFD', {timeout:10000},async t=>{
  const {root}=await temp(t),prefix='x'.repeat(64*1024-1);
  const code='process.stdout.write(Buffer.concat([Buffer.alloc(65535,120),Buffer.from([228,189,160]),Buffer.alloc(100,120)]));';
  const quote=(value:string)=>process.platform==='win32'?"'"+value.replace(/'/g,"''")+"'":"'"+value.replace(/'/g,"'\\''")+"'";
  const command=(process.platform==='win32'?'[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & ':'')+quote(process.execPath)+' -e '+quote(code);
  const ctx=context(root);let streamed='';ctx.update=piece=>{streamed+=piece;};
  const result=await shellTool().execute({command},ctx);
  const details=record(result.details);assert.equal(result.isError,false);assert.equal(details.outputTruncated,true);
  assert.equal(streamed,prefix);assert(!result.text.includes('\uFFFD'));assert(result.text.startsWith(prefix+'\n[exit=0, finished]'));
  assert.equal(details.outputBytes,Buffer.byteLength(prefix));
});
test('shell timeout terminates a long-running process', { timeout: 10000 }, async t => {
  const { root } = await temp(t); const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10';
  const start = Date.now(); const result = await shellTool().execute({ command, timeoutMs: 200 }, context(root));
  assert.equal(result.isError, true); assert.match(result.text, /timeout/); assert.ok(Date.now() - start < 7000);
});
test('shell cancellation kills the running process and settles its result', { timeout: 10000 }, async t => {
  const { root } = await temp(t); const controller = new AbortController(); const started = latch<number>();
  const command = process.platform === 'win32' ? 'Write-Output $PID; Start-Sleep -Seconds 10' : 'echo $$; sleep 10';
  const ctx = context(root, controller.signal); ctx.update = text => { const pid = Number(text.trim()); if (pid > 0) started.resolve(pid); };
  const pending = shellTool().execute({ command, timeoutMs: 8000 }, ctx); const pid = await started.promise;
  controller.abort(new Error('cancelled')); await assert.rejects(pending, /cancelled/); assert.throws(() => process.kill(pid, 0));
});
