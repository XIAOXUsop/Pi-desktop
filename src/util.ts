export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
export function string(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
export function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function checkAbort(signal: AbortSignal): void { signal.throwIfAborted(); }
export function clone<T>(value: T): T { return structuredClone(value); }
export function bounded(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer');
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = '\n[output truncated]';
  const marker = maxBytes >= Buffer.byteLength(suffix) ? suffix : '';
  const bytes = Buffer.from(value); let end = maxBytes - Buffer.byteLength(marker);
  // The first excluded byte must not be a continuation byte. Back up over an
  // incomplete code point instead of decoding it as a replacement character.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.toString('utf8',0,end) + marker;
}
export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
