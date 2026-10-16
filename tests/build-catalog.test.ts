// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateCatalog } from '../scripts/build-catalog.mjs';
import { zipSync, strToU8 } from 'fflate';

const roots: string[] = [];
async function setup() {
  const temporary = path.join(os.tmpdir(), 'opencode');
  await fs.mkdir(temporary, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporary, 'paper-reader-catalog-'));
  roots.push(directory); await fs.mkdir(path.join(directory, 'books', '小说'), { recursive: true });
  return directory;
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
describe('automatic cloud catalog', () => {
  it('scans nested books, encodes paths and updates versions without changing the identity', async () => {
    const root = await setup();
    const file = path.join(root, 'books/小说/书 #1.TXT');
    await fs.writeFile(file, '第一章 开始\n正文');
    await fs.writeFile(path.join(root, 'books/ignore.md'), 'not a book');
    const first = await generateCatalog(root);
    expect(first).toHaveLength(1);
    expect(first[0].title).toBe('书 #1');
    expect(first[0].file).toBe('books/%E5%B0%8F%E8%AF%B4/%E4%B9%A6%20%231.TXT');
    expect(first[0].encoding).toBe('utf-8');
    expect(await generateCatalog(root)).toEqual(first);
    await fs.writeFile(file, '第一章 开始\n新版正文');
    const next = await generateCatalog(root);
    expect(next[0].id).toBe(first[0].id); expect(next[0].version).not.toBe(first[0].version);
    await fs.unlink(file); expect(await generateCatalog(root)).toEqual([]);
  });
  it('extracts EPUB metadata and recognizes GB18030', async () => {
    const root = await setup();
    await fs.writeFile(path.join(root, 'books/a.txt'), new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]));
    const bytes = zipSync({
      'META-INF/container.xml': strToU8('<container><rootfile full-path="OEBPS/a.opf"/></container>'),
      'OEBPS/a.opf': strToU8('<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>真实书名</dc:title><dc:creator>作者</dc:creator></metadata></package>'),
    });
    await fs.writeFile(path.join(root, 'books/b.epub'), bytes);
    const result = await generateCatalog(root);
    expect(result[0].encoding).toBe('gb18030');
    expect(result[1]).toMatchObject({ title: '真实书名', author: '作者', format: 'epub' });
  });
  it('does not replace the previous catalog if scanning fails', async () => {
    const root = await setup();
    await fs.writeFile(path.join(root, 'catalog.json'), 'previous');
    await fs.writeFile(path.join(root, 'books/bad.epub'), 'bad archive');
    await expect(generateCatalog(root)).rejects.toThrow('元信息无法读取');
    expect(await fs.readFile(path.join(root, 'catalog.json'), 'utf8')).toBe('previous');
  });
});
