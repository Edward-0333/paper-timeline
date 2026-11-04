import type { ReaderJson } from '../shared/reader';

/** Preserve SDK dates and stamp appearance buffers when round-tripping through JSON. */
export function packReaderValue(value: unknown): ReaderJson {
  if (value instanceof Date) return { $readerDate: value.toISOString() };
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const data = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = '';
    for (let i = 0; i < data.length; i += 16384) binary += String.fromCharCode(...data.subarray(i, i + 16384));
    return { $readerBinary: btoa(binary) };
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(v => packReaderValue(v ?? null));
  if (typeof value !== 'object' || !value) throw new Error('批注包含无法保存的数据');
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, packReaderValue(v)]));
}
export function unpackReaderValue(value: ReaderJson): unknown {
  if (Array.isArray(value)) return value.map(unpackReaderValue);
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.$readerDate === 'string') return new Date(value.$readerDate);
    if (Object.keys(value).length === 1 && typeof value.$readerBinary === 'string') return Uint8Array.from(atob(value.$readerBinary), c => c.charCodeAt(0)).buffer;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unpackReaderValue(v)]));
  }
  return value;
}
