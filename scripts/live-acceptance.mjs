import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { AgentSession, DEFAULT_SYSTEM, loadConfig, SessionStore, ToolRegistry, Workspace, fileTools, shellTool, assertToolPairs } from '../dist/src/index.js';

const exec = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runs = resolve(project, '.agent/acceptance'); await mkdir(runs, { recursive: true });
const root = await mkdtemp(resolve(runs, 'coding-'));
await mkdir(resolve(root, 'src')); await mkdir(resolve(root, 'test'));
const tests = `import test from 'node:test';
import assert from 'node:assert/strict';
import { subtotal, applyDiscount } from '../src/basket.mjs';
test('subtotal multiplies each price by quantity', () => assert.equal(subtotal([{ price: 1.25, quantity: 3 }, { price: 2, quantity: 2 }]), 7.75));
test('empty basket totals zero', () => assert.equal(subtotal([]), 0));
test('discount is a percentage, not a flat deduction', () => assert.equal(applyDiscount(80, 25), 60));
test('discount rounds the final amount to cents', () => assert.equal(applyDiscount(9.99, 15), 8.49));
`;
await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'generated-basket-demo', private: true, type: 'module', scripts: { test: 'node --test test/basket.test.mjs' } }, null, 2));
await writeFile(resolve(root, 'README.md'), 'Generated acceptance fixture. Run npm test. Fix only src/basket.mjs. subtotal sums price multiplied by quantity. applyDiscount applies a percentage and rounds the result to cents. Do not change test files or install dependencies.');
await writeFile(resolve(root, 'src/basket.mjs'), 'export function subtotal(items) {\n  return items.reduce((total, item) => total + item.price + item.quantity, 0);\n}\n\nexport function applyDiscount(total, percent) {\n  return total - percent;\n}\n');
await writeFile(resolve(root, 'test/basket.test.mjs'), tests);
const hash = value => createHash('sha256').update(value).digest('hex');
async function verify() {
  try { const result = await exec(process.execPath, ['--test', 'test/basket.test.mjs'], { cwd: root, windowsHide: true, timeout: 15000 }); return { passed: true, stdout: result.stdout }; }
  catch (error) { return { passed: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}
const baseline = await verify(); if (baseline.passed) throw new Error('Fixture must fail before the agent repair');
await writeFile(resolve(runs, 'latest-project.txt'), root);
const { config, registry } = await loadConfig(resolve(project, 'configs/deepseek.json'));
const workspace = await Workspace.open(root); const tools = new ToolRegistry();
[...fileTools(workspace), shellTool()].forEach(tool => tools.register(tool));
const logPath = resolve(runs, 'live-' + Date.now() + '.jsonl');
let logging = Promise.resolve(); const events = [];
function record(event) { events.push(event); logging = logging.then(() => writeFile(logPath, JSON.stringify(event) + '\n', { flag: 'a' })); }
async function create(store) {
  const agent = await AgentSession.create({ store, models: registry, tools, modelKey: config.defaultModel,
    system: DEFAULT_SYSTEM + '\nThis workspace is entirely generated test data. Fix only src/basket.mjs. Do not edit tests or package.json. Use npm test to inspect failures and verify changes. Do not install dependencies. No external communication tools.',
    activeTools: ['read', 'write', 'edit', 'shell'], allowedTools: ['read', 'write', 'edit', 'shell'], maxTurns: 12 });
  agent.subscribe(record); return agent;
}
let agent = await create(await SessionStore.create(root));
const started = Date.now(); let report;
try {
  const repair = await agent.run('请修复这个独立演示项目：先读取 README.md、package.json、src/basket.mjs 和 test/basket.test.mjs，运行 npm test 观察失败，只修改 src/basket.mjs，修复购物车总价和百分比折扣，再运行 npm test 验证全部测试通过。不要改测试，不要安装依赖。');
  const after = await verify(); const testUnchanged = hash(await readFile(resolve(root, 'test/basket.test.mjs'))) === hash(tests);
  if (repair.status !== 'completed' || !after.passed || !testUnchanged) throw new Error('Real coding repair did not meet the acceptance criteria');
  const changes = await readFile(resolve(root, 'src/basket.mjs'), 'utf8');
  let abortRequested = false;
  const unsubscribe = agent.subscribe(event => { if (!abortRequested && event.type === 'tool_start') { abortRequested = true; void agent.abort(); } });
  const cancelled = await agent.run('请调用 read 读取 src/basket.mjs 并简短说明实现。不要修改文件。'); unsubscribe();
  if (cancelled.status !== 'cancelled' || !abortRequested) throw new Error('Cancellation did not stop at the tool boundary');
  assertToolPairs(agent.store.messages()); const sessionPath = agent.store.path; await agent.close();
  agent = await create(await SessionStore.resume(sessionPath));
  const restoredHistory = agent.store.messages().length;
  const resumed = await agent.run('上次读取任务被取消了。现在继续：读取 src/basket.mjs，运行 npm test，简短报告测试结果，不修改任何文件。');
  if (resumed.status !== 'completed' || !(await verify()).passed || await readFile(resolve(root, 'src/basket.mjs'), 'utf8') !== changes) throw new Error('Resume verification failed');
  assertToolPairs(agent.store.messages());
  const toolResults = events.filter(event => event.type === 'tool_end');
  const shellResults = toolResults.filter(event => event.call.name === 'shell');
  const failedTestObserved = shellResults.some(event => event.result.isError);
  const successfulTestObserved = shellResults.some(event => !event.result.isError);
  if (!failedTestObserved || !successfulTestObserved) throw new Error('Agent must observe both failing and passing test commands');
  report = { model: config.defaultModel, fixture: root, baselineFailed: !baseline.passed, repair, testsPassed: after.passed, testFilesUnchanged: testUnchanged,
    cancelled, resumed, restoredHistory, failedTestObserved, successfulTestObserved, sessionPath, logPath,
    usage: agent.store.usage(), elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
    toolCalls: toolResults.map(event => ({ name: event.call.name, isError: event.result.isError })), finalSource: changes };
  await writeFile(resolve(runs, 'latest-report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(runs, 'baseline-test.txt'), baseline.stdout); await writeFile(resolve(runs, 'final-test.txt'), after.stdout);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally { await agent.close(); await logging; }
