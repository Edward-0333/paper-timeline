export type ReaderJson = null | boolean | number | string | ReaderJson[] | { [key: string]: ReaderJson };
export interface ReaderPosition { page: number; zoom: number }
export interface ReaderState {
  version: 1; pdfHash: string; revision: number; updatedAt?: string;
  /** null retains annotations embedded in the source PDF until the first edit. */
  annotations: ReaderJson[] | null;
  position: ReaderPosition;
}
export interface ReaderUpdate { pdfHash: string; revision: number; annotations?: ReaderJson[]; position?: ReaderPosition }
export interface ReaderDocument { data: Uint8Array; state: ReaderState }

export function validateReaderUpdate(value: ReaderUpdate) {
  if (!value || typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(value.pdfHash)
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || Object.keys(value).some(k => !['pdfHash', 'revision', 'annotations', 'position'].includes(k))) throw new Error('阅读标注数据格式无效');
  if (value.position !== undefined && (!value.position || !Number.isSafeInteger(value.position.page) || value.position.page < 1
    || value.position.page > 100000 || !Number.isFinite(value.position.zoom) || value.position.zoom < 0.1 || value.position.zoom > 5
    || Object.keys(value.position).some(k => !['page', 'zoom'].includes(k)))) throw new Error('阅读位置或缩放比例无效');
  if (value.annotations !== undefined) {
    if (!Array.isArray(value.annotations) || value.annotations.length > 10000) throw new Error('标注数量超出范围');
    let count = 0;
    const walk = (v: unknown, depth: number) => {
      if (++count > 200000 || depth > 20) throw new Error('标注数据过于复杂');
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
      if (typeof v === 'number' && Number.isFinite(v)) return;
      if (typeof v !== 'object' || !v) throw new Error('标注数据必须可保存为 JSON');
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('标注对象格式无效');
      for (const [k, x] of Object.entries(v)) {
        if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new Error('标注字段无效');
        walk(x, depth + 1);
      }
    };
    walk(value.annotations, 0);
    if (new TextEncoder().encode(JSON.stringify(value.annotations)).length > 20 * 1024 * 1024) throw new Error('单篇标注最多保存 20 MB');
  }
}
