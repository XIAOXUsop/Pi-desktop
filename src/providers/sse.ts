export interface SseEvent { event: string; data: string }

/** Incremental UTF-8 and CR/LF parsing; no assumptions about HTTP chunk boundaries. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader(); const decoder = new TextDecoder();
  let pending = ''; let event = 'message'; let data: string[] = []; let bytes = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  function line(value: string): SseEvent | undefined {
    if (!value) {
      const result = data.length ? { event, data: data.join('\n') } : undefined;
      event = 'message'; data = []; bytes = 0; return result;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'); const field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = content;
    if (field === 'data') { data.push(content); bytes += Buffer.byteLength(content); }
    if (bytes > 4 * 1024 * 1024) throw new Error('SSE event exceeds 4 MiB');
  }
  try {
    signal.throwIfAborted();
    while (true) {
      const chunk = await reader.read(); signal.throwIfAborted();
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      while (true) {
        const match = /[\r\n]/.exec(pending); if (!match) break;
        const index = match.index; const char = pending[index];
        if (char === '\r' && index === pending.length - 1 && !chunk.done) break;
        const length = char === '\r' && pending[index + 1] === '\n' ? 2 : 1;
        const result = line(pending.slice(0, index)); pending = pending.slice(index + length);
        if (result) yield result;
      }
      if (Buffer.byteLength(pending) > 4 * 1024 * 1024) throw new Error('SSE line exceeds 4 MiB');
      if (chunk.done) {
        if (pending) { const result = line(pending); if (result) yield result; }
        const final = line(''); if (final) yield final;
        break;
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
