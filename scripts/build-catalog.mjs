import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';

const LIMIT = 32 * 1024 * 1024;
const GROUP_SIZE = 20;
const sha = value => createHash('sha256').update(value).digest('hex');

function epubMetadata(bytes) {
  // Only decompress container + OPF metadata, not the entire book.
  let total = 0;
  const files = unzipSync(bytes, { filter(entry) {
    if (entry.name !== 'META-INF/container.xml' && !/\.opf$/i.test(entry.name)) return false;
    total += entry.originalSize;
    if (entry.originalSize > 1024 * 1024 || total > 2 * 1024 * 1024) throw new Error('EPUB 元信息过大');
    return true;
  } });
  const parse = bytes => {
    const source = new TextDecoder().decode(bytes);
    if (/<!ENTITY\s/i.test(source)) throw new Error('EPUB 不支持 XML 实体');
    const dom = new JSDOM(source, { contentType: 'application/xml' });
    return dom;
  };
  const container = files['META-INF/container.xml'];
  if (!container) throw new Error('EPUB 缺少 container.xml');
  const containerDOM = parse(container);
  const opfPath = containerDOM.window.document.querySelector('rootfile')?.getAttribute('full-path');
  containerDOM.window.close();
  if (!opfPath || !files[opfPath]) throw new Error('EPUB 找不到 OPF');
  const opfDOM = parse(files[opfPath]);
  try {
    const doc = opfDOM.window.document;
    const dc = 'http://purl.org/dc/elements/1.1/';
    const title = doc.getElementsByTagNameNS(dc, 'title')[0]?.textContent?.trim();
    const author = doc.getElementsByTagNameNS(dc, 'creator')[0]?.textContent?.trim();
    return { ...(title ? { title } : {}), ...(author ? { author } : {}) };
  } finally { opfDOM.window.close(); }
}

function cleanText(value) { return value.replace(/\s+/g, ' ').trim(); }
function splitText(text) {
  const heading = /^(?:第[零〇一二三四五六七八九十百千万两\d]+[章节回卷部篇].{0,45}|序章|序言|楔子|尾声|后记|番外.{0,35})$/;
  const chapters = []; let current = { title: '正文', blocks: [] };
  for (const raw of text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim(); if (!line) continue;
    if (line.length <= 60 && heading.test(line)) { if (current.blocks.length) chapters.push(current); current = { title: line, blocks: [] }; continue; }
    for (const chunk of line.match(/[\s\S]{1,2000}/g) ?? []) current.blocks.push({ kind: 'paragraph', text: chunk });
  }
  if (current.blocks.length) chapters.push(current);
  return chapters.length ? chapters : [{ title: '正文', blocks: [{ kind: 'paragraph', text: cleanText(text) }] }];
}
function splitEpub(bytes) {
  const files = unzipSync(bytes); const parse = b => new JSDOM(new TextDecoder().decode(b), { contentType: 'application/xml' });
  const container = parse(files['META-INF/container.xml']).window.document;
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  const opf = parse(files[opfPath]).window.document; const dir = opfPath.slice(0, opfPath.lastIndexOf('/') + 1);
  const resolve = href => (dir + href.split('#')[0]).split('/').reduce((a,p) => p === '..' ? a.slice(0,-1) : p === '.' ? a : [...a,p], []).join('/');
  const manifest = new Map([...opf.querySelectorAll('manifest > item')].map(item => [item.id, { path: resolve(item.getAttribute('href')), media: item.getAttribute('media-type') }]));
  const chapters = [];
  for (const ref of [...opf.querySelectorAll('spine > itemref')]) {
    const item = manifest.get(ref.getAttribute('idref')); if (!item || !/xhtml|html/.test(item.media)) continue;
    const doc = parse(files[item.path]).window.document; doc.querySelectorAll('script,style,svg,video,audio').forEach(n => n.remove());
    const blocks = []; for (const node of [...(doc.querySelector('body') ?? doc.documentElement).children]) { const text = cleanText(node.textContent ?? ''); if (!text) continue; blocks.push({ kind: /^h[1-6]$/i.test(node.localName) ? 'heading' : 'paragraph', text }); }
    if (blocks.length) chapters.push({ title: cleanText(doc.querySelector('h1,h2,title')?.textContent ?? `第 ${chapters.length + 1} 章`), blocks });
  }
  return chapters;
}
async function writeChunks(publicDir, entry, bytes) {
  const id = entry.id.slice(6); const root = path.join(publicDir, 'books', '.chunks', id); await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const source = entry.format === 'txt' ? new TextDecoder(entry.encoding).decode(bytes) : null;
  const chapters = source ? splitText(source) : splitEpub(bytes);
  const groups = [];
  for (let i = 0; i < chapters.length; i += GROUP_SIZE) {
    const name = `group-${String(groups.length).padStart(4, '0')}.json`;
    groups.push(name);
    await fs.writeFile(path.join(root, name), JSON.stringify({ chapters: chapters.slice(i, i + GROUP_SIZE) }));
  }
  const manifest = { title: entry.title, author: entry.author, format: entry.format, version: entry.version, groupSize: GROUP_SIZE, groups, chapters: chapters.map((c, i) => ({ title: c.title, group: Math.floor(i / GROUP_SIZE), index: i % GROUP_SIZE })) };
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  entry.chunks = `books/.chunks/${id}/manifest.json`;
}

/** Deterministic, recursive discovery. File contents version progress; paths identify editions. */
export async function generateCatalog(publicDir) {
  const booksDir = path.join(publicDir, 'books');
  await fs.mkdir(booksDir, { recursive: true });
  const entries = [];
  async function walk(directory) {
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (item.name.startsWith('.')) continue;
      if (item.isSymbolicLink()) throw new Error(`书籍目录不允许符号链接：${item.name}`);
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) { await walk(absolute); continue; }
      const format = path.extname(item.name).slice(1).toLowerCase();
      if (!item.isFile() || !['txt', 'epub'].includes(format)) continue;
      const stat = await fs.stat(absolute);
      if (stat.size > LIMIT || stat.size === 0) throw new Error(`书籍为空或超过 32MiB：${absolute}`);
      const bytes = await fs.readFile(absolute);
      const relative = path.relative(booksDir, absolute).split(path.sep).join('/');
      const entry = {
        id: `cloud-${sha(relative).slice(0, 24)}`,
        title: path.basename(item.name, path.extname(item.name)),
        file: 'books/' + relative.split('/').map(encodeURIComponent).join('/'),
        format,
        version: sha(bytes),
      };
      if (format === 'epub') {
        try { Object.assign(entry, epubMetadata(bytes)); }
        catch (error) { throw new Error(`${relative} 的 EPUB 元信息无法读取：${error.message}`); }
      } else {
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); entry.encoding = 'utf-8'; }
        catch {
          try { new TextDecoder('gb18030', { fatal: true }).decode(bytes); entry.encoding = 'gb18030'; }
          catch { throw new Error(`${relative} 不是可识别的 UTF-8 / GB18030 文本`); }
        }
      }
      await writeChunks(publicDir, entry, bytes);
      if (!entry.title || entry.title.length > 500 || entry.file.length > 500 || (entry.author?.length ?? 0) > 2000) throw new Error(`${relative} 的书名、作者或文件路径过长`);
      entries.push(entry);
      if (entries.length > 2000) throw new Error('云端书架最多支持 2000 本');
    }
  }
  await walk(booksDir);
  const content = JSON.stringify(entries, null, 2) + '\n';
  const output = path.join(publicDir, 'catalog.json');
  // Avoid a dev-server reload loop when the generated catalog is unchanged.
  let previous;
  try { previous = await fs.readFile(output, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== content) {
    const temporary = output + '.tmp';
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, output);
  }
  return entries;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = await generateCatalog(fileURLToPath(new URL('../public/', import.meta.url)));
  console.log(`云端书架已生成：${entries.length} 本`);
}
