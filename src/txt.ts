import type { Block, Book, Chapter } from './types';

const heading = /^(?:第[零〇一二三四五六七八九十百千万两\d]+[章节回卷部篇].{0,45}|序章.{0,20}|序言|楔子.{0,20}|尾声.{0,20}|后记.{0,20}|番外.{0,35}|chapter\s+\d+.{0,40})$/i;
const MAX_BLOCKS_PER_CHAPTER = 120;

export function parseTxt(bytes: Uint8Array, encoding: 'utf-8' | 'gb18030' = 'utf-8'): Book {
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error(`TXT 无法按 ${encoding} 解码，请在书架清单中设置正确的 encoding`); }
  if (text.includes('\0')) throw new Error('这个文件不像可读的 TXT 文本');
  const chapters: Chapter[] = [];
  let current: Chapter = { title: '正文', blocks: [] };
  let part = 1;
  let baseTitle = '正文';
  function push() { if (current.blocks.length) chapters.push(current); }
  for (const raw of text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length <= 60 && heading.test(line)) {
      // Preserve a heading-only chapter rather than silently dropping it.
      if (!current.blocks.length && current.title !== '正文') current.blocks.push({ kind: 'paragraph', text: current.title });
      push(); baseTitle = line; part = 1;
      current = { title: line, blocks: [] };
      continue;
    }
    // Bound a single huge line as well as unchaptered novels for mobile DOM size.
    for (const chunk of line.match(/[\s\S]{1,1200}/g) ?? []) {
      if (current.blocks.length >= MAX_BLOCKS_PER_CHAPTER) {
        push(); part++; current = { title: `${baseTitle} · ${part}`, blocks: [] };
      }
      current.blocks.push({ kind: 'paragraph', text: chunk } satisfies Block);
    }
  }
  if (!current.blocks.length && current.title !== '正文') current.blocks.push({ kind: 'paragraph', text: current.title });
  push();
  if (!chapters.length) throw new Error('这份 TXT 没有可读正文');
  return { chapters, images: new Map(), warnings: [] };
}
