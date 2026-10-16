import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseEpub, resolveEpubPath } from '../src/epub';

function fixture(body = '<h1>第一章 开始</h1><p>真正的正文</p>', options: { ncx?: boolean; invalidSpine?: boolean } = {}) {
  return zipSync({
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="EPUB/book.opf"/></rootfiles></container>'),
    'EPUB/book.opf': strToU8(`<package><manifest><item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="img" href="Images/a.png" media-type="image/png"/>${options.ncx ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'}</manifest><spine><itemref idref="${options.invalidSpine ? 'missing' : 'c1'}"/></spine></package>`),
    'EPUB/Text/ch1.xhtml': strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>章节</title></head><body>${body}</body></html>`),
    'EPUB/nav.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><a href="Text/ch1.xhtml#start">目录中的名字</a></nav></body></html>'),
    'EPUB/toc.ncx': strToU8('<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>旧版目录</text></navLabel><content src="Text/ch1.xhtml"/></navPoint></navMap></ncx>'),
    'EPUB/Images/a.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  });
}
describe('EPUB', () => {
  it('reads EPUB 3 navigation and spine in order', async () => {
    const book = await parseEpub(fixture());
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('目录中的名字');
    expect(book.chapters[0].blocks.some(block => 'text' in block && block.text === '真正的正文')).toBe(true);
  });
  it('reads EPUB 2 NCX navigation', async () => { expect((await parseEpub(fixture(undefined, { ncx: true }))).chapters[0].title).toBe('旧版目录'); });
  it('does not execute or retain scripts, foreign markup, CSS or remote image URLs', async () => {
    const book = await parseEpub(fixture('<script>window.hacked=true</script><style>body{display:none}</style><svg xmlns="http://www.w3.org/2000/svg"><script>bad</script></svg><p onclick="evil()">安全正文<img src="../Images/a.png" alt="内部图"/></p><img src="https://evil.example/tracker.png"/><iframe src="https://evil.example"/>'));
    expect(book.chapters[0].blocks).toEqual([{ kind: 'paragraph', text: '安全正文' }, { kind: 'image', path: 'EPUB/Images/a.png', alt: '内部图' }]);
  });
  it('normalizes internal parent paths without allowing network or outside-root access', () => {
    expect(resolveEpubPath('EPUB/Text/ch1.xhtml', '../Images/a.png')).toBe('EPUB/Images/a.png');
    for (const path of ['../../../secret', 'https://evil.example', '//evil.example/a', 'data:image/svg+xml,a', '%2f%2fevil.example/a', '..\\a']) expect(resolveEpubPath('EPUB/Text/a.xhtml', path)).toBeNull();
  });
  it('rejects broken spine, malformed zip and zip traversal entries', async () => {
    await expect(parseEpub(fixture(undefined, { invalidSpine: true }))).rejects.toThrow('缺失文件');
    await expect(parseEpub(new Uint8Array([1, 2, 3]))).rejects.toThrow('无法打开');
    await expect(parseEpub(zipSync({ '../secret.xml': strToU8('bad') }))).rejects.toThrow('无效文件路径');
  });
  it('rejects oversized archives before inflating the entry', async () => {
    const bytes = zipSync({ 'large.xhtml': strToU8('x') });
    // Inflate the central-directory declared size without allocating the body.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.length - 46; i++) {
      if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, 17 * 1024 * 1024, true); break; }
    }
    await expect(parseEpub(bytes)).rejects.toThrow('大小超出限制');
  });
  it('removes duplicated chapter heading and blocks XML entities', async () => {
    const book = await parseEpub(fixture('<h1>目录中的名字</h1><p>正文</p>'));
    expect(book.chapters[0].blocks).toEqual([{ kind: 'paragraph', text: '正文' }]);
    const malicious = zipSync({ 'META-INF/container.xml': strToU8('<!DOCTYPE container [<!ENTITY x "payload">]><container>&x;</container>') });
    await expect(parseEpub(malicious)).rejects.toThrow('XML 实体');
  });
});
