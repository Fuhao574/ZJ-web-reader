import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { LocalLibrary, localEntry } from '../src/local-library';

describe('local bookshelf', () => {
  it('stores source files, survives a new library instance, deduplicates and removes', async () => {
    const entry = { id: 'local-test', title: '本地小说', format: 'txt' as const, file: '', version: '1' };
    const first = new LocalLibrary();
    await first.put({ entry, bytes: new Uint8Array([1, 2, 3]).buffer, addedAt: 1 });
    await first.put({ entry, bytes: new Uint8Array([1, 2, 3]).buffer, addedAt: 2 });
    const second = new LocalLibrary();
    expect((await second.list()).filter(item => item.id === entry.id)).toHaveLength(1);
    expect(new Uint8Array((await second.get(entry.id))!.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    await second.remove(entry.id);
    expect(await first.get(entry.id)).toBeUndefined();
    expect((await first.list()).find(item => item.id === entry.id)).toBeUndefined();
  });
  it('uses content fingerprints regardless of filename and detects TXT encoding', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const bytes = new TextEncoder().encode('第一章 开始\n正文').buffer;
    const a = await localEntry(new File([], 'a.txt'), bytes);
    const b = await localEntry(new File([], 'b.TXT'), bytes);
    expect(a.id).toBe(b.id); expect(a.encoding).toBe('utf-8');
    const gbk = await localEntry(new File([], 'gbk.txt'), new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]).buffer);
    expect(gbk.encoding).toBe('gb18030');
    await expect(localEntry(new File([], 'bad.exe'), bytes)).rejects.toThrow('TXT');
    vi.unstubAllGlobals();
  });
});
