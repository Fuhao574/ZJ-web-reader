import { unzip } from 'fflate';
import type { Block, Book, Chapter } from './types';

const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED = 96 * 1024 * 1024;
const imageMime: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

function safePath(path: string): string {
  if (path.includes('\\')) throw new Error('EPUB 内含无效文件路径');
  const clean = path;
  if (!clean || clean.startsWith('/') || clean.includes('\0') || clean.split('/').some(part => part === '..')) throw new Error('EPUB 内含无效文件路径');
  return clean.split('/').filter(part => part && part !== '.').join('/');
}
/** Allow normal ../Images links, but reject network / data / out-of-root links. */
export function resolveEpubPath(base: string, relative: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/)|[\\\u0000-\u001f]/i.test(relative)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(relative.split('#')[0]); } catch { return null; }
  if (/^(?:[a-z][a-z\d+.-]*:|\/)|[\\\u0000-\u001f?]/i.test(decoded)) return null;
  const parts = base.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/') || null;
}
function text(node: Element | null): string { return node?.textContent?.replace(/\s+/g, ' ').trim() ?? ''; }
function xml(bytes: Uint8Array, name: string): Document {
  const source = new TextDecoder().decode(bytes);
  if (/<!ENTITY\s/i.test(source)) throw new Error('EPUB 不支持自定义 XML 实体');
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error(`EPUB 的 ${name} 不是有效 XML`);
  return doc;
}
function attr(element: Element, name: string): string { return element.getAttribute(name) ?? ''; }
function blocksFromXhtml(bytes: Uint8Array, path: string, images: Map<string, { bytes: Uint8Array; mime: string }>): Block[] {
  const document = xml(bytes, `章节 ${path}`);
  document.querySelectorAll('script,style,iframe,object,embed,form,textarea,select,button,svg,math,audio,video,noscript').forEach(node => node.remove());
  const result: Block[] = [];
  const root = document.querySelector('body') ?? document.documentElement;
  function addText(kind: 'paragraph' | 'heading' | 'quote', value: string, anchor?: string) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    for (const chunk of normalized.match(/[\s\S]{1,2000}/g) ?? []) result.push({ kind, text: chunk, ...(anchor ? { anchor } : {}) });
  }
  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) { addText('paragraph', node.textContent ?? ''); return; }
    if (!(node instanceof Element)) return;
    const tag = node.localName.toLowerCase();
    const anchor = attr(node, 'id') || attr(node, 'name') || undefined;
    if (tag === 'img') {
      const source = attr(node, 'src');
      const imagePath = source ? resolveEpubPath(path, source) : null;
      if (imagePath && images.has(imagePath)) result.push({ kind: 'image', path: imagePath, alt: attr(node, 'alt') || '插图', ...(anchor ? { anchor } : {}) });
      return;
    }
    if (/^h[1-6]$/.test(tag)) { addText('heading', node.textContent ?? '', anchor); return; }
    if (tag === 'blockquote') { addText('quote', node.textContent ?? '', anchor); return; }
    if (/^(p|pre|li|dt|dd|figcaption)$/.test(tag)) {
      addText('paragraph', node.textContent ?? '', anchor);
      node.querySelectorAll('img').forEach(visit);
      return;
    }
    for (const child of [...node.childNodes]) visit(child);
  }
  for (const child of [...root.childNodes]) visit(child);
  return result;
}

export async function parseEpub(bytes: Uint8Array): Promise<Book> {
  let declaredSize = 0, entries = 0;
  // Check central-directory sizes before decompression, not after allocating a zip bomb.
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    let rejected = false;
    try {
      unzip(bytes, { filter(entry) {
        if (rejected) return false;
        try { if (entry.name.endsWith('/')) safePath(entry.name.slice(0, -1)); else safePath(entry.name); }
        catch (error) { rejected = true; reject(error); return false; }
        entries++; declaredSize += entry.originalSize;
        if (entries > MAX_ENTRIES || entry.originalSize > 16 * 1024 * 1024 || declaredSize > MAX_UNCOMPRESSED) {
          rejected = true; reject(new Error('EPUB 解压后的文件数量或大小超出限制')); return false;
        }
        return !entry.name.endsWith('/') && /\.(?:xml|opf|ncx|xhtml|html|htm|png|jpe?g|gif|webp)$/i.test(entry.name);
      } }, (error, data) => {
        if (!rejected) { if (error) reject(new Error('EPUB 压缩包无法打开')); else resolve(data); }
      });
    } catch { reject(new Error('EPUB 压缩包无法打开')); }
  });
  const names = Object.keys(files);
  if (!names.length || names.length > MAX_ENTRIES) throw new Error('EPUB 文件数量超出限制');
  let uncompressed = 0;
  for (const name of names) { safePath(name); uncompressed += files[name].byteLength; if (uncompressed > MAX_UNCOMPRESSED) throw new Error('EPUB 解压后超过大小限制'); }
  const container = files['META-INF/container.xml'];
  if (!container) throw new Error('EPUB 缺少 META-INF/container.xml');
  const rootfile = xml(container, 'container').querySelector('rootfile');
  const opfPath = rootfile ? safePath(attr(rootfile, 'full-path')) : '';
  if (!opfPath || !files[opfPath]) throw new Error('EPUB 找不到内容清单');
  const opf = xml(files[opfPath], 'content.opf');
  const dc = 'http://purl.org/dc/elements/1.1/';
  const title = text(opf.getElementsByTagNameNS(dc, 'title')[0] ?? null);
  const author = text(opf.getElementsByTagNameNS(dc, 'creator')[0] ?? null);
  const manifest = new Map<string, { path: string; media: string; properties: string }>();
  for (const item of [...opf.querySelectorAll('manifest > item')]) {
    const id = attr(item, 'id'); const href = attr(item, 'href');
    if (!id || !href) continue;
    const path = resolveEpubPath(opfPath, href);
    if (path && files[path]) manifest.set(id, { path, media: attr(item, 'media-type'), properties: attr(item, 'properties') });
  }
  const images = new Map<string, { bytes: Uint8Array; mime: string }>();
  for (const item of manifest.values()) {
    const ext = item.path.slice(item.path.lastIndexOf('.')).toLowerCase();
    if (imageMime[ext] && item.media === imageMime[ext]) images.set(item.path, { bytes: files[item.path], mime: imageMime[ext] });
  }
  const navTitles = new Map<string, string>();
  const navItem = [...manifest.values()].find(item => item.properties.split(/\s+/).includes('nav'));
  if (navItem) {
    const navDoc = xml(files[navItem.path], '目录 NAV');
    const navs = [...navDoc.querySelectorAll('nav')];
    const toc = navs.find(nav => nav.getAttributeNS('http://www.idpf.org/2007/ops', 'type')?.split(/\s+/).includes('toc')) ?? navs[0];
    toc?.querySelectorAll('a[href]').forEach(link => {
      const path = resolveEpubPath(navItem.path, attr(link, 'href'));
      if (path && !navTitles.has(path)) navTitles.set(path, text(link));
    });
  }
  const ncxItem = [...manifest.values()].find(item => item.media === 'application/x-dtbncx+xml');
  if (ncxItem) {
    const doc = xml(files[ncxItem.path], '目录 NCX');
    doc.querySelectorAll('navPoint').forEach(point => {
      const content = point.querySelector('content'), label = point.querySelector('navLabel');
      const path = content ? resolveEpubPath(ncxItem.path, attr(content, 'src')) : null;
      if (path && !navTitles.has(path)) navTitles.set(path, text(label));
    });
  }
  const spine = [...opf.querySelectorAll('spine > itemref')];
  const chapters: Chapter[] = [];
  for (const ref of spine) {
    const item = manifest.get(attr(ref, 'idref'));
    if (!item) throw new Error('EPUB 阅读顺序中有缺失文件，可能已加密或损坏');
    if (!/^(application\/xhtml\+xml|text\/html)$/.test(item.media)) continue;
    const blocks = blocksFromXhtml(files[item.path], item.path, images);
    const firstHeading = blocks.find(block => block.kind === 'heading');
    const title = navTitles.get(item.path) || (firstHeading && 'text' in firstHeading ? firstHeading.text : '') || `第 ${chapters.length + 1} 章`;
    // The page already has a chapter heading. Do not print it twice.
    if (blocks[0]?.kind === 'heading' && blocks[0].text.replace(/\s/g, '') === title.replace(/\s/g, '') && blocks.length > 1) blocks.shift();
    for (let i = 0; i < blocks.length; i += 120) {
      chapters.push({ title: title + (i ? ` · ${Math.floor(i / 120) + 1}` : ''), blocks: blocks.slice(i, i + 120), path: item.path });
    }
    if (chapters.length % 5 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (!chapters.length) throw new Error('EPUB 没有可读正文');
  return { chapters, images, ...(title ? { title } : {}), ...(author ? { author } : {}), warnings: ['EPUB 使用统一纸面排版；不运行书内脚本、音视频、SVG 或内嵌字体。'] };
}
