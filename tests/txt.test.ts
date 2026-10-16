import { describe, expect, it } from 'vitest';
import { parseTxt } from '../src/txt';

describe('TXT parser', () => {
  it('splits common Chinese chapter headings', () => {
    const book = parseTxt(new TextEncoder().encode('\uFEFF第一章 开始\n\n第一段。\n第二章 转弯\n\n第二段。'));
    expect(book.chapters.map(chapter => chapter.title)).toEqual(['第一章 开始', '第二章 转弯']);
    expect(book.chapters[0].blocks[0]).toEqual({ kind: 'paragraph', text: '第一段。' });
  });
  it('rejects binary-looking content', () => { expect(() => parseTxt(new Uint8Array([65, 0, 66]))).toThrow('不像'); });
  it('decodes GB18030 and rejects mismatched encoding', () => {
    expect(parseTxt(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]), 'gb18030').chapters[0].blocks[0]).toEqual({ kind: 'paragraph', text: '你好' });
    expect(() => parseTxt(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]))).toThrow('解码');
  });
  it('bounds very long chapters without losing text', () => {
    const book = parseTxt(new TextEncoder().encode('字'.repeat(150000)));
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters.every(chapter => chapter.blocks.length <= 120)).toBe(true);
    expect(book.chapters.flatMap(chapter => chapter.blocks).reduce((n, block) => n + ('text' in block ? block.text.length : 0), 0)).toBe(150000);
  });
});
