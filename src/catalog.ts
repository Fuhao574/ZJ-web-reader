import type { CatalogEntry } from './types';

export const MAX_BOOK_BYTES = 32 * 1024 * 1024;
export const MAX_CATALOG_BYTES = 1024 * 1024;

/** Catalog paths are relative to the app, not arbitrary network URLs. */
export function bookURL(path: string, base: URL): URL {
  if (!path || path !== path.trim() || /[\\\u0000-\u001f]/.test(path) || path.startsWith('/')) throw new Error('书籍路径必须相对于站点目录');
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname + 'books/') || url.search || url.hash) {
    throw new Error('书籍必须放在本站 books/ 目录内');
  }
  const decoded = decodeURIComponent(url.pathname);
  if (/[\\\u0000-\u001f]/.test(decoded) || decoded.split('/').some(p => p === '.' || p === '..')) throw new Error('书籍路径无效');
  return url;
}

export function parseCatalog(data: unknown, base: URL): CatalogEntry[] {
  if (!Array.isArray(data) || data.length > 2000) throw new Error('书架清单必须是数组，最多 2000 本');
  const ids = new Set<string>();
  return data.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('书架条目无效');
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)) throw new Error('书籍 ID 缺失、重复或格式无效');
    ids.add(item.id);
    for (const field of ['title', 'file', 'version'] as const) {
      if (typeof item[field] !== 'string' || !item[field].trim() || item[field].length > 500) throw new Error(`书籍 ${item.id} 的 ${field} 无效`);
    }
    if (item.format !== 'txt' && item.format !== 'epub') throw new Error(`书籍 ${item.id} 的格式只能是 txt / epub`);
    if (item.encoding !== undefined && item.encoding !== 'utf-8' && item.encoding !== 'gb18030') throw new Error('TXT 编码只能是 utf-8 / gb18030');
    for (const field of ['author', 'description']) {
      if (item[field] !== undefined && (typeof item[field] !== 'string' || item[field].length > 2000)) throw new Error(`${field} 必须是短文本`);
    }
    const url = bookURL(item.file as string, base);
    if (!url.pathname.toLowerCase().endsWith('.' + item.format)) throw new Error('书籍扩展名与格式不匹配');
    return item as unknown as CatalogEntry;
  });
}

/** Cancel downloads exceeding the limit, even without Content-Length. */
export async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`加载失败（HTTP ${response.status}），请检查文件是否已上传`);
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('文件超过阅读器的大小限制');
  }
  if (!response.body) throw new Error('浏览器没有返回可读的响应内容');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error('文件超过阅读器的大小限制');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
