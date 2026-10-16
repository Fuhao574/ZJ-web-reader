import type { CatalogEntry } from './types';

export interface LocalBook {
  entry: CatalogEntry;
  bytes: ArrayBuffer;
  addedAt: number;
}

export class LocalLibrary {
  private database: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error('当前浏览器不支持本地书架存储')); return; }
      const request = indexedDB.open('paper-reader-local', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'entry.id' });
        if (!db.objectStoreNames.contains('entries')) {
          const entries = db.createObjectStore('entries', { keyPath: 'entry.id' });
          // Metadata stays separate: listing the shelf must not read all novel blobs.
          const cursor = request.transaction!.objectStore('books').openCursor();
          cursor.onsuccess = () => {
            const record = cursor.result;
            if (record) { entries.put({ entry: record.value.entry, addedAt: record.value.addedAt }); record.continue(); }
          };
        }
      };
      request.onerror = () => reject(new Error('无法打开本地书架存储'));
      request.onblocked = () => reject(new Error('本地书架被其他页面占用，请关闭旧页面后重试'));
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); this.database = null; };
        resolve(database);
      };
    }).catch(error => { this.database = null; throw error; });
    return this.database;
  }

  private async run<T>(mode: IDBTransactionMode, operation: (transaction: IDBTransaction) => IDBRequest<T>): Promise<T> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['books', 'entries'], mode);
      const request = operation(transaction);
      let result: T;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(new Error('本地书架保存失败，可能空间不足或存储被禁用'));
      transaction.onerror = () => reject(new Error('本地书架读写失败，请检查浏览器存储权限'));
    });
  }
  async list(): Promise<CatalogEntry[]> {
    return (await this.run('readonly', transaction => transaction.objectStore('entries').getAll()) as LocalBook[])
      .sort((a, b) => b.addedAt - a.addedAt).map(record => record.entry);
  }
  get(id: string): Promise<LocalBook | undefined> { return this.run('readonly', transaction => transaction.objectStore('books').get(id)); }
  async put(record: LocalBook): Promise<void> {
    await this.run('readwrite', transaction => {
      transaction.objectStore('entries').put({ entry: record.entry, addedAt: record.addedAt });
      return transaction.objectStore('books').put(record);
    });
  }
  async remove(id: string): Promise<void> {
    await this.run('readwrite', transaction => {
      transaction.objectStore('entries').delete(id);
      return transaction.objectStore('books').delete(id);
    });
  }
}

/** Same content has a stable identity; no filename collisions or network hashing. */
export async function localEntry(file: File, bytes: ArrayBuffer): Promise<CatalogEntry> {
  const format = file.name.toLowerCase().endsWith('.epub') ? 'epub' : file.name.toLowerCase().endsWith('.txt') ? 'txt' : null;
  if (!format) throw new Error('请选择 TXT 或 EPUB 文件');
  if (!crypto.subtle) throw new Error('本地书架需要 HTTPS 或 localhost 环境');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  let encoding: 'utf-8' | 'gb18030' | undefined;
  if (format === 'txt') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); encoding = 'utf-8'; }
    catch {
      try { new TextDecoder('gb18030', { fatal: true }).decode(bytes); encoding = 'gb18030'; }
      catch { throw new Error('无法识别 TXT 编码，请先转换为 UTF-8'); }
    }
  }
  return { id: `local-${hash}`, title: file.name.replace(/\.(txt|epub)$/i, ''), format, file: '', version: hash, ...(encoding ? { encoding } : {}) };
}
