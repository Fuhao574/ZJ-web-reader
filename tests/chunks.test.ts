import { describe, expect, it } from 'vitest';
import { chunkURL, parseCatalog } from '../src/catalog';

const base = new URL('https://reader.example/');
describe('cloud chunk catalog', () => {
  it('accepts generated chunk manifests and rejects arbitrary chunk URLs', () => {
    const chunks = 'books/.chunks/cloud-test/manifest.json';
    const entry = { id: 'book', title: '书', file: 'books/source.epub', format: 'epub', version: 'a'.repeat(64), chunks };
    expect(parseCatalog([entry], base)[0].chunks).toBe(chunks);
    expect(chunkURL(chunks, base).pathname).toBe('/books/.chunks/cloud-test/manifest.json');
    expect(() => chunkURL('books/.chunks/cloud-test/../../secret.json', base)).toThrow();
    expect(() => parseCatalog([{ ...entry, chunks: 'https://evil.example/manifest.json' }], base)).toThrow();
  });
});
