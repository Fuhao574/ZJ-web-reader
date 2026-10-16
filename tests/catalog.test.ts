import { describe, expect, it } from 'vitest';
import { bookURL, parseCatalog, readLimited } from '../src/catalog';

const base = new URL('https://reader.example/');
describe('catalog security boundaries', () => {
  it('accepts an internal book URL', () => { expect(bookURL('books/a.txt', base).pathname).toBe('/books/a.txt'); });
  it('rejects traversal and external URLs', () => { expect(() => bookURL('../secret.txt', base)).toThrow(); expect(() => bookURL('https://evil.example/a.epub', base)).toThrow(); });
  it('validates catalog format and location', () => { expect(parseCatalog([{ id: 'a', title: 'A', file: 'books/a.txt', format: 'txt', version: '1' }], base)).toHaveLength(1); expect(() => parseCatalog([{ id: 'a', title: 'A', file: 'a.epub', format: 'epub', version: '1' }], base)).toThrow(); });
  it('allows subdirectory deployment, rejects duplicate IDs and encoded traversal', () => {
    expect(bookURL('books/a.txt', new URL('https://reader.example/reader/')).pathname).toBe('/reader/books/a.txt');
    expect(() => bookURL('books/%2e%2e/%2e%2e/secret.txt', base)).toThrow();
    expect(() => bookURL('books/%00a.txt', base)).toThrow();
    const entry = { id: 'a', title: 'A', file: 'books/a.txt', format: 'txt', version: '1' };
    expect(() => parseCatalog([entry, entry], base)).toThrow('重复');
  });
  it('bounds downloads with or without Content-Length', async () => {
    expect(await readLimited(new Response('abc'), 3)).toHaveLength(3);
    await expect(readLimited(new Response('abcd'), 3)).rejects.toThrow('大小限制');
    await expect(readLimited(new Response('a', { headers: { 'content-length': '9999' } }), 3)).rejects.toThrow('大小限制');
    await expect(readLimited(new Response('', { status: 404 }), 3)).rejects.toThrow('HTTP 404');
  });
});
