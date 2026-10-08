import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { bounded } from '../util.js';

/** Shell commands run with the user's OS permissions; workspace cwd is not a sandbox. */
export type ShellExecutor = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
export function shellTool(executor?: ShellExecutor, onSpawn?: (pid: number | undefined) => void): Tool {
  return {
    name: 'shell', kind: 'execute', description: 'Run a command in the project directory using PowerShell on Windows or /bin/sh on Unix. Bounded output and timeout; no background jobs.',
    parameters: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 100_000 },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 } }, required: ['command'], additionalProperties: false },
    async execute(args, context) {
      if(executor)return executor(args,context);
      context.signal.throwIfAborted(); const command = args.command as string;
      const started = Date.now();
      const timeoutMs = (args.timeoutMs as number | undefined) ?? 30_000;
      const executable = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
      const windowsCommand="$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding;\n"+command;
      const parameters = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsCommand] : ['-c', command];
      return await new Promise((resolve, reject) => {
        const child = spawn(executable, parameters, { cwd: context.workspace, windowsHide: true,
          detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        onSpawn?.(child.pid);
        let output = ''; let bytes = 0, truncated = false; let killed: 'cancelled' | 'timeout' | undefined;
        const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
        const append = (piece: string) => { if(piece) { output += piece; context.update(piece); } };
        const collect = (chunk: Buffer, decoder: StringDecoder) => {
          const remaining = 64 * 1024 - bytes;
          const accepted = chunk.subarray(0,remaining); bytes += accepted.length;
          if (accepted.length < chunk.length) truncated = true;
          append(decoder.write(accepted));
        };
        child.stdout.on('data', chunk => collect(chunk,stdout)); child.stderr.on('data', chunk => collect(chunk,stderr));
        const kill = (reason: 'cancelled' | 'timeout') => {
          if (killed) return; killed = reason;
          if (process.platform === 'win32' && child.pid) {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => child.kill());
            killer.on('exit', code => { if (code !== 0) child.kill(); });
          } else if (child.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          }
        };
        const abort = () => kill('cancelled'); const timer = setTimeout(() => kill('timeout'), timeoutMs);
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) abort();
        const cleanup = () => { clearTimeout(timer); context.signal.removeEventListener('abort', abort); };
        child.on('error', error => { cleanup(); reject(error); });
        child.on('close', code => {
          cleanup();
          if (killed === 'cancelled') { reject(context.signal.reason ?? new Error('Cancelled')); return; }
          // A capped stream may leave an incomplete code point buffered. Do not
          // flush that tail as U+FFFD; streams that fit are decoded normally.
          if (!truncated) { append(stdout.end()); append(stderr.end()); }
          resolve({ text: bounded(output + `\n[exit=${code}, ${killed ?? 'finished'}]${truncated ? '\n[output truncated]' : ''}`, 66 * 1024),
            isError: killed === 'timeout' || code !== 0, details: { exitCode: code, timeout: killed === 'timeout', durationMs: Date.now() - started, outputTruncated: truncated, outputBytes: Buffer.byteLength(output) } });
        });
      });
    },
  };
}
