import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import './styles.css';
import { bookURL, chunkURL, MAX_BOOK_BYTES, MAX_CATALOG_BYTES, parseCatalog, readLimited } from './catalog';
import { parseEpub } from './epub';
import { chapterScrollPercent, percentOf, ProgressStore, validateProgress, type StorageLike } from './progress';
import { parseTxt } from './txt';
import { LocalLibrary, localEntry } from './local-library';
import { jumpToReadingPosition, revealCurrentChapter } from './reading-navigation';
import { HttpSyncTransport, makeSyncKey, SyncController, syncBookKey } from './sync';
import type { Block, Book, CatalogEntry, Chapter, Progress } from './types';

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`页面缺少 ${selector}`);
  return element;
}
const shelfView = $('#shelf-view');
const readerView = $('#reader-view');
const messageView = $('#message-view');
const tocDialog = $<HTMLDialogElement>('#toc-dialog');
const appBase = new URL('./', document.baseURI);
const storage = ((): StorageLike | null => { try { return window.localStorage; } catch { return null; } })();
const store = new ProgressStore(storage);
const localLibrary = new LocalLibrary();
type Shelf = 'cloud' | 'local';
type ReaderEntry = CatalogEntry & { source: Shelf };
// Hash navigation must not reset scroll before the old reading point is saved.
history.scrollRestoration = 'manual';
let catalog: ReaderEntry[] = [];
let localBooks: ReaderEntry[] = [];
let shelf: Shelf = new URLSearchParams(location.hash.slice(1)).get('shelf') === 'local' ? 'local' : 'cloud';
let localReady = false;
let localError = '';
let cloudError = '';
let cloudLoading = true;
let importing = false;
let catalogRequest = 0;
let catalogReady = false;
let current: ReaderEntry | null = null;
let book: Book | null = null;
let chapterIndex = 0;
let restoring = true;
let raf = 0;
let saveTimer = 0;
let toastTimer = 0;
let generation = 0;
let download: AbortController | null = null;
let slowTimer = 0;
let chapterImages: string[] = [];
let trackedPoint: Progress | null = null;
let scrollPending = false;
let retryAction: () => void = () => void loadCatalog();
let chunkBase: URL | null = null;
let chunkGroups: string[] = [];
let chunkGroupSize = 20;
const chunkCache = new Map<number, Chapter[]>();
const chunkRequests = new Map<number, Promise<Chapter[]>>();
const sync = new SyncController(new HttpSyncTransport(new URL('api/index.php', appBase)), storage, {
  status(message) { $('#sync-status').textContent = message; $('#sync-button').title = message; },
  valid(point) { return !!book && !!validateProgress(point, current!.version, book.chapters); },
  restore(point) {
    if (!book || !current || readerView.hidden) return;
    void renderChapter(point.chapter, point, true);
  },
  conflict(value) {
    $('#sync-conflict').hidden = !value;
    if (value) {
      $('#conflict-detail').textContent = `本机：第 ${value.local.chapter + 1} 章 · ${value.local.percent}%；线上：第 ${value.remote.chapter + 1} 章 · ${value.remote.percent}%。请选择继续的位置，未选择前不会覆盖线上进度。`;
      $<HTMLDialogElement>('#sync-dialog').close();
    }
  },
});

function syncContext() {
  if (!current) return null;
  const key = syncBookKey(current.format, current.version);
  return key ? { book: key, version: current.version } : null;
}
async function startBookSync(local: Progress | null) {
  const context = syncContext();
  if (context && !readerView.hidden) await sync.start(context, local);
}
function renderSyncSettings() {
  $('#sync-connected').hidden = !sync.connected;
  $('#sync-disconnected').hidden = sync.connected;
  $('#sync-button').textContent = sync.connected ? '已连接' : '同步';
  $('#sync-key-output').hidden = true;
  $<HTMLInputElement>('#sync-key-output').value = '';
  $('#reveal-sync-key').textContent = '查看密钥';
}

function toast(message: string) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { $('#toast').hidden = true; }, 3200);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '加载失败，请稍后再试'; }
function cancelPending() {
  generation++;
  download?.abort(); download = null;
  window.clearTimeout(slowTimer); window.clearTimeout(saveTimer);
  restoring = true;
}
function releaseImages() { chapterImages.forEach(url => URL.revokeObjectURL(url)); chapterImages = []; }
function clearChunkCache() { chunkBase = null; chunkGroups = []; chunkCache.clear(); chunkRequests.clear(); }
function showMessage(title: string, detail: string, retry = false) {
  shelfView.hidden = true; readerView.hidden = true; messageView.hidden = false;
  $('#toc-button').hidden = true;
  $('#message-title').textContent = title;
  $('#message-detail').textContent = detail;
  $('#retry').hidden = !retry;
}
function showShelf() {
  saveProgress(); void sync.flush(); sync.detach(); cancelPending(); releaseImages();
  shelfView.hidden = false; readerView.hidden = true; messageView.hidden = true;
  $('#toc-button').hidden = true;
  $('#toolbar-book').textContent = '慢慢读，读到哪就记到哪。';
  $('#status-strip').style.width = '0%';
  document.title = '纸间 · 书架';
  renderShelf(); window.scrollTo(0, 0);
}
const idFor = (entry: ReaderEntry) => entry.source === 'local' ? `local:${entry.id}` : `book:${entry.id}`;
function formatPercent(entry: ReaderEntry): string {
  const progress = store.read(idFor(entry), entry.version);
  return progress ? `已读 ${progress.percent}% · 继续第 ${progress.chapter + 1} 章` : '开始阅读';
}
function renderShelf() {
  $('#cloud-tab').setAttribute('aria-current', String(shelf === 'cloud'));
  $('#local-tab').setAttribute('aria-current', String(shelf === 'local'));
  $('#local-import').hidden = shelf !== 'local';
  $<HTMLButtonElement>('#local-import').disabled = importing;
  $('#local-import').textContent = importing ? '正在添加…' : '添加本地书籍';
  const status = shelf === 'local' ? (localReady ? localError : '正在打开本地书架…') : cloudLoading ? '正在加载云端书架…' : cloudError;
  $('#shelf-status').textContent = status; $('#shelf-status').hidden = !status;
  $('#cloud-retry').hidden = shelf !== 'cloud' || !cloudError;
  $('#shelf-note').textContent = shelf === 'cloud'
    ? '云端书籍由站长发布，阅读进度只保存在你的浏览器里。'
    : '本地文件仅存于这个浏览器，不上传服务器。清理站点数据会清除本地书籍和进度。';
  const grid = $('#shelf-grid'); grid.replaceChildren();
  const entries = shelf === 'cloud' ? catalog : localBooks;
  for (const entry of entries) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'book-card';
    const cover = document.createElement('span'); cover.className = 'book-cover'; cover.textContent = [...entry.title][0]; cover.setAttribute('aria-hidden', 'true');
    const content = document.createElement('span'); content.className = 'book-card-content';
    const title = document.createElement('strong'); title.textContent = entry.title;
    const meta = document.createElement('small'); meta.textContent = `${entry.format.toUpperCase()} · ${formatPercent(entry)}`;
    const description = document.createElement('span'); description.textContent = entry.description || entry.author || (entry.source === 'local' ? '仅本机保存 · 不上传' : '云端书架 · 点击开始阅读'); description.className = 'book-card-description';
    content.append(title, meta, description); button.append(cover, content);
    button.onclick = () => navigateBook(entry.id, entry.source);
    if (entry.source === 'local') {
      const wrapper = document.createElement('div'); wrapper.className = 'book-wrapper';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-book';
      remove.textContent = '移除'; remove.setAttribute('aria-label', `移除本地书籍 ${entry.title}`);
      remove.onclick = () => void removeLocal(entry);
      wrapper.append(button, remove); grid.append(wrapper);
    } else grid.append(button);
  }
  if (!entries.length && !status) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = shelf === 'local' ? '本地书架还是空的，添加一本 TXT 或 EPUB 吧。' : '云端书架还没有书，过些时候再来看看吧。'; grid.append(empty);
  }
}
function makeProgress(chapter: number, block: number, fraction: number): Progress {
  return { version: current!.version, chapter, block, fraction, percent: percentOf(book!.chapters, chapter, block, fraction), updatedAt: Date.now() };
}
function currentPoint(): Progress {
  const blocks = [...$('#reading').children];
  const top = $('.toolbar').getBoundingClientRect().bottom + 18;
  let block = blocks.findIndex(element => element.getBoundingClientRect().bottom > top);
  if (block < 0) block = Math.max(0, blocks.length - 1);
  const rect = blocks[block]?.getBoundingClientRect();
  const fraction = rect ? Math.max(0, Math.min(1, (top - rect.top) / Math.max(1, rect.height))) : 0;
  return makeProgress(chapterIndex, block, fraction);
}
function renderProgress(point: Progress) {
  $('#book-progress').style.width = `${point.percent}%`;
  renderChapterProgress();
  $('#progress-label').textContent = `${point.percent}%`;
  $('#chapter-label').textContent = `第 ${point.chapter + 1} 章`;
}
function renderChapterProgress() {
  if (readerView.hidden || !book) return;
  const reading = $('#reading');
  const lastBlock = reading.lastElementChild;
  const percent = chapterScrollPercent(
    $('.paper').getBoundingClientRect().top,
    (lastBlock ?? reading).getBoundingClientRect().bottom,
    $('.toolbar').getBoundingClientRect().bottom,
    window.innerHeight,
  );
  $('#status-strip').style.width = `${percent}%`;
  $('#status-strip').title = `本章阅读进度 ${Math.round(percent)}%`;
}
function writePoint(point: Progress, notifySync = true) {
  if (!current) return;
  trackedPoint = point;
  const saved = store.write(idFor(current), point);
  if (notifySync) sync.update(point);
  $('#save-state').textContent = saved ? `已记住第 ${point.chapter + 1} 章的位置 · 仅当前浏览器` : '当前浏览器无法保存进度，请勿依赖刷新恢复';
  renderProgress(point);
}
function saveProgress() {
  window.clearTimeout(saveTimer);
  if (restoring || readerView.hidden || !current || !book) return;
  // A short chapter cannot always scroll its restored block to the toolbar.
  // Keep the restored point until the reader actually scrolls, rather than
  // replacing a saved completion/offset merely by opening the shelf.
  if (scrollPending || !trackedPoint) trackedPoint = currentPoint();
  scrollPending = false;
  writePoint(trackedPoint);
}
function goChapter(index: number) {
  if (restoring || !book || index < 0 || index >= book.chapters.length) return;
  saveProgress(); void renderChapter(index, null);
}
function renderToc() {
  const nav = $('#side-toc'); nav.replaceChildren();
  book!.chapters.forEach((chapter, index) => nav.append(chapterButton(chapter, index)));
  $<HTMLInputElement>('#toc-search').value = '';
  renderModalToc();
}
function chapterButton(chapter: Chapter, index: number) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = chapter.title;
  if (index === chapterIndex) button.setAttribute('aria-current', 'true');
  button.onclick = () => { tocDialog.close(); goChapter(index); };
  return button;
}
function renderModalToc() {
  const input = $<HTMLInputElement>('#toc-search');
  const query = input.value.trim().toLocaleLowerCase();
  const nav = $('#modal-toc'); const fragment = document.createDocumentFragment();
  let matches = 0;
  book?.chapters.forEach((chapter, index) => {
    if (query && !chapter.title.toLocaleLowerCase().includes(query)) return;
    fragment.append(chapterButton(chapter, index)); matches++;
  });
  nav.replaceChildren(fragment); nav.scrollTop = 0;
  $('#toc-search-clear').hidden = input.value.length === 0;
  $('#toc-search-status').textContent = query
    ? (matches ? `找到 ${matches} 个章节` : '没有找到匹配的章节，换个关键词试试。')
    : `共 ${book?.chapters.length ?? 0} 个章节`;
}
function renderBlock(block: Block): HTMLElement {
  if (block.kind === 'image') {
    const figure = document.createElement('figure');
    const data = book!.images.get(block.path);
    if (data) {
      const image = document.createElement('img');
      const url = URL.createObjectURL(new Blob([new Uint8Array(data.bytes)], { type: data.mime }));
      chapterImages.push(url); image.src = url; image.alt = block.alt; image.loading = 'lazy'; image.decoding = 'async';
      figure.append(image);
    }
    return figure;
  }
  const element = document.createElement(block.kind === 'heading' ? 'h2' : block.kind === 'quote' ? 'blockquote' : 'p');
  element.textContent = block.text; return element;
}
const chapterTextLength = (chapter: Chapter) => chapter.blocks.reduce((count, block) => count + ('text' in block ? block.text.length : 0), 0);
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

async function renderChapter(index: number, saved: Progress | null, fromSync = false) {
  if (!book || !current) return;
  const token = ++generation;
  restoring = true; window.clearTimeout(saveTimer); releaseImages();
  trackedPoint = null; scrollPending = false;
  readerView.setAttribute('aria-busy', 'true');
  // Release focus from the bottom navigation BEFORE changing the page height.
  // The browser must not keep anchoring a focused Next button to the viewport.
  $('#chapter-title').focus({ preventScroll: true });
  $<HTMLButtonElement>('#prev').disabled = true;
  $<HTMLButtonElement>('#next').disabled = true;
  chapterIndex = Math.max(0, Math.min(book.chapters.length - 1, index));
  if (book.chunked) await loadChunkGroup(Math.floor(chapterIndex / book.chunked.groupSize));
  const chapter = book.chapters[chapterIndex];
  $('#chapter-title').textContent = chapter.title;
  $('#chapter-index').textContent = `${String(chapterIndex + 1).padStart(2, '0')} / ${String(book.chapters.length).padStart(2, '0')}`;
  $('#chapter-size').textContent = `${chapterTextLength(chapter).toLocaleString('zh-CN')} 字`;
  $('#mast-label').textContent = `CHAPTER ${String(chapterIndex + 1).padStart(2, '0')}`;
  $('#location-label').textContent = current.title;
  $('#format-label').textContent = `${current.format.toUpperCase()} / ${current.source === 'local' ? 'LOCAL' : 'CLOUD'}`;
  $('#side-title').textContent = current.title;
  $('#toolbar-book').textContent = current.title + (current.author ? ` · ${current.author}` : '');
  $('#book-detail').textContent = `${book.chapters.length} 章 · ${current.source === 'local' ? '本地书架' : '云端书架'} · ${current.format.toUpperCase()}`;
  $('#reader-note').textContent = (current.source === 'local' ? '这本书仅保存在当前浏览器，不上传服务器。' : '这本书来自云端书架。') + ' 阅读进度仅保存在当前浏览器，不跨设备同步；清理站点数据会清除进度。';
  $('#reading').replaceChildren(...chapter.blocks.map(renderBlock));
  const nextButton = $<HTMLButtonElement>('#next');
  nextButton.textContent = chapterIndex === book.chapters.length - 1 ? '读完了 ✓' : '下一章 →';
  renderToc();
  shelfView.hidden = true; readerView.hidden = false; messageView.hidden = true; $('#toc-button').hidden = false;
  // A new chapter starts at the actual page top; do not leave it at the old
  // bottom while waiting for fonts / layout. Saved positions are a separate path.
  if (!saved) jumpToReadingPosition(0);
  // Font metrics must settle before restoring a paragraph offset. Pictures have fixed frames.
  await document.fonts?.ready;
  await frame(); await frame();
  if (token !== generation) return;
  const point = saved ?? makeProgress(chapterIndex, 0, 0);
  const element = $('#reading').children[point.block];
  $('#chapter-title').focus({ preventScroll: true });
  const position = () => {
    const rect = element.getBoundingClientRect();
    const target = saved ? window.scrollY + rect.top + point.fraction * rect.height - $('.toolbar').offsetHeight - 18 : 0;
    jumpToReadingPosition(target);
    revealCurrentChapter($('#side-toc'));
  };
  position();
  await frame();
  if (token !== generation) return;
  // Reconcile once after the layout/focus scroll has been processed, before
  // scroll events are allowed to write a new reading point.
  position();
  writePoint(point, !fromSync);
  if (saved && store.available) $('#save-state').textContent = `已恢复第 ${chapterIndex + 1} 章上次读到的位置`;
  await frame();
  if (token !== generation) return;
  restoring = false;
  readerView.setAttribute('aria-busy', 'false');
  $<HTMLButtonElement>('#prev').disabled = chapterIndex === 0;
  nextButton.disabled = false;
  document.title = `${current.title} · ${chapter.title} · 纸间`;
  void preloadNextChunk(chapterIndex);
}
async function loadChunkedBook(entry: ReaderEntry): Promise<Book> {
  if (!entry.chunks) throw new Error('云端书籍缺少分片清单');
  const manifestURL = chunkURL(entry.chunks, appBase);
  const response = await fetch(manifestURL, { cache: 'force-cache' });
  const manifest = JSON.parse(new TextDecoder().decode(await readLimited(response, MAX_CATALOG_BYTES)));
  if (manifest.version !== entry.version || !Array.isArray(manifest.groups) || !Array.isArray(manifest.chapters) || !Number.isInteger(manifest.groupSize) || manifest.groupSize < 1 || manifest.groupSize > 100 || manifest.chapters.length > 100000 || manifest.groups.length > 5000 || manifest.groups.some((name: unknown) => typeof name !== 'string' || !/^group-\d{4}\.json$/.test(name))) throw new Error('书籍分片清单无效');
  clearChunkCache(); chunkBase = new URL('./', manifestURL); chunkGroups = manifest.groups;
  const chapters = manifest.chapters.map((chapter: { title?: unknown }) => ({ title: typeof chapter.title === 'string' ? chapter.title : '未命名章节', blocks: [{ kind: 'paragraph' as const, text: '' }] }));
  chunkGroupSize = manifest.groupSize;
  const result: Book = { chapters, images: new Map(), warnings: [], chunked: { groups: manifest.groups, groupSize: manifest.groupSize, loaded: new Set() } };
  return result;
}
async function loadChunkGroup(group: number): Promise<Chapter[]> {
  const existing = chunkCache.get(group); if (existing) return existing;
  const pending = chunkRequests.get(group); if (pending) return pending;
  if (!chunkBase || !chunkGroups[group]) throw new Error('章节分片不存在');
  const request = (async () => {
    const url = new URL(chunkGroups[group], chunkBase);
    const response = await fetch(url, { cache: 'force-cache' });
    const json = JSON.parse(new TextDecoder().decode(await readLimited(response, 4 * 1024 * 1024)));
    if (!Array.isArray(json.chapters)) throw new Error('章节分片格式无效');
    const chapters = json.chapters as Chapter[]; chunkCache.set(group, chapters);
    if (book?.chunked) {
      const start = group * book.chunked.groupSize;
      chapters.forEach((chapter, index) => { book!.chapters[start + index] = chapter; });
      book.chunked.loaded.add(group);
    }
    return chapters;
  })();
  chunkRequests.set(group, request); try { return await request; } finally { chunkRequests.delete(group); }
}
async function preloadNextChunk(index: number): Promise<void> {
  if (!book?.chunked || !chunkBase) return;
  const next = Math.floor((index + 1) / chunkGroupSize);
  if (next < chunkGroups.length) void loadChunkGroup(next).catch(() => {});
}
async function openBook(entry: ReaderEntry) {
  saveProgress(); void sync.flush(); sync.detach(); cancelPending();
  readerView.setAttribute('aria-busy', 'true');
  const token = generation;
  showMessage('正在翻开这本书…', entry.title);
  slowTimer = window.setTimeout(() => { if (token === generation) $('#message-detail').textContent = '网络有点慢，书籍仍在加载…'; }, 8000);
  const controller = new AbortController(); download = controller;
  try {
    let parsed: Book;
    if (current?.id === entry.id && current.source === entry.source && current.version === entry.version && book) parsed = book;
    else {
      if (entry.source === 'cloud' && entry.chunks) {
        parsed = await loadChunkedBook(entry);
        current = entry; book = parsed;
        await loadChunkGroup(0);
      } else {
      let bytes: Uint8Array;
      if (entry.source === 'local') {
        const record = await localLibrary.get(entry.id);
        if (!record) throw new Error('这本本地书已被移除，请重新添加');
        bytes = new Uint8Array(record.bytes);
      } else {
        const url = bookURL(entry.file, appBase);
        url.searchParams.set('v', entry.version);
        const response = await fetch(url, { signal: controller.signal });
        bytes = await readLimited(response, MAX_BOOK_BYTES);
      }
      parsed = entry.format === 'txt' ? parseTxt(bytes, entry.encoding ?? 'utf-8') : await parseEpub(bytes);
      }
    }
    if (token !== generation) return;
    current = entry; book = parsed;
    const saved = store.read(idFor(entry), entry.version, parsed.chapters);
    window.clearTimeout(slowTimer);
    await renderChapter(saved?.chapter ?? 0, saved);
    if (current === entry && !readerView.hidden) await startBookSync(saved);
  } catch (error) {
    if (token !== generation) return;
    retryAction = () => void openBook(entry);
    showMessage('这本书暂时打不开', errorMessage(error), true);
  } finally {
    if (download === controller) { window.clearTimeout(slowTimer); download = null; }
  }
}
function route() {
  const params = new URLSearchParams(location.hash.slice(1));
  shelf = params.get('shelf') === 'local' ? 'local' : 'cloud';
  const id = params.get('book');
  if (!id) { showShelf(); return; }
  if (shelf === 'cloud' && !catalogReady) { showShelf(); return; }
  if (shelf === 'local' && !localReady) { showShelf(); return; }
  const entry = (shelf === 'local' ? localBooks : catalog).find(item => item.id === id);
  if (entry) void openBook(entry);
  else { saveProgress(); cancelPending(); showMessage('书架里没有这本书', '它可能已被移走，请从书架选择其他书籍。'); }
}
function navigateBook(id: string, source: Shelf) {
  const hash = source === 'local' ? `shelf=local&book=${encodeURIComponent(id)}` : `book=${encodeURIComponent(id)}`;
  if (location.hash.slice(1) !== hash) history.pushState(null, '', `#${hash}`);
  route();
}
function navigateShelf() {
  const hash = shelf === 'local' ? '#shelf=local' : '';
  history.pushState(null, '', location.pathname + location.search + hash);
  showShelf();
}
async function loadCatalog() {
  const token = ++catalogRequest;
  cloudLoading = true; cloudError = ''; renderShelf();
  try {
    const response = await fetch(new URL('catalog.json', appBase), { cache: 'no-cache' });
    const bytes = await readLimited(response, MAX_CATALOG_BYTES);
    const entries = parseCatalog(JSON.parse(new TextDecoder().decode(bytes)), appBase);
    if (token !== catalogRequest) return;
    catalog = entries.map(entry => ({ ...entry, source: 'cloud' }));
    catalogReady = true; cloudLoading = false;
    if (shelf === 'cloud' && readerView.hidden) route(); else renderShelf();
  } catch (error) {
    if (token !== catalogRequest) return;
    cloudLoading = false; cloudError = `云端书架加载失败：${errorMessage(error)}`;
    renderShelf();
  }
}
async function refreshLocal() {
  try { localBooks = (await localLibrary.list()).map(entry => ({ ...entry, source: 'local' })); localError = ''; }
  catch (error) { localError = errorMessage(error); }
  localReady = true;
  renderShelf();
}
async function removeLocal(entry: ReaderEntry) {
  if (!confirm(`从本地书架移除「${entry.title}」和它的阅读进度？`)) return;
  try {
    await localLibrary.remove(entry.id); store.clear(idFor(entry));
    if (current?.id === entry.id && current.source === 'local') { book = null; current = null; }
    await refreshLocal(); toast('已从本地书架移除');
  } catch (error) { toast(errorMessage(error)); }
}
async function importLocal(files: File[]) {
  if (importing) return;
  importing = true; renderShelf();
  let added = 0; const errors: string[] = [];
  for (const file of files) {
    try {
      if (file.size > MAX_BOOK_BYTES || !file.size) throw new Error('文件为空或超过 32MiB');
      if (!/\.(txt|epub)$/i.test(file.name)) throw new Error('仅支持 TXT / EPUB');
      const bytes = await file.arrayBuffer();
      const entry = await localEntry(file, bytes);
      // Validate before persisting; a broken file does not become a fake readable book.
      if (entry.format === 'txt') parseTxt(new Uint8Array(bytes), entry.encoding);
      else {
        const parsed = await parseEpub(new Uint8Array(bytes));
        if (parsed.title) entry.title = parsed.title;
        if (parsed.author) entry.author = parsed.author;
      }
      await localLibrary.put({ entry, bytes, addedAt: Date.now() }); added++;
    } catch (error) { errors.push(`${file.name}：${errorMessage(error)}`); }
  }
  importing = false;
  await refreshLocal();
  if (errors.length) { localError = errors.join('；'); renderShelf(); }
  if (added) toast(`已添加 ${added} 本到本地书架，文件未上传`);
  $<HTMLInputElement>('#local-files').value = '';
}
window.addEventListener('hashchange', route);
window.addEventListener('scroll', () => {
  if (restoring || readerView.hidden || !book || !current) return;
  scrollPending = true;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (restoring || readerView.hidden || !book || !current) return;
    trackedPoint = currentPoint(); scrollPending = false;
    renderProgress(trackedPoint); window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveProgress, 350);
  });
}, { passive: true });
window.addEventListener('pagehide', () => { saveProgress(); void sync.flush(); });
window.addEventListener('resize', () => {
  renderChapterProgress();
  if (!readerView.hidden) revealCurrentChapter($('#side-toc'));
}, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { saveProgress(); void sync.flush(); }
  else if (!readerView.hidden) { saveProgress(); void sync.check(); }
});
window.addEventListener('online', () => void sync.check());
$('#shelf-button').onclick = navigateShelf;
$('#cloud-tab').onclick = () => { shelf = 'cloud'; navigateShelf(); };
$('#local-tab').onclick = () => { shelf = 'local'; navigateShelf(); void refreshLocal(); };
$('#cloud-retry').onclick = () => void loadCatalog();
$('#local-import').onclick = () => $<HTMLInputElement>('#local-files').click();
$('#local-files').onchange = () => void importLocal([...($<HTMLInputElement>('#local-files').files ?? [])]);
$('#brand').onclick = event => { event.preventDefault(); navigateShelf(); };
$('#toc-button').onclick = () => {
  if (!book || restoring || readerView.hidden) return;
  $<HTMLInputElement>('#toc-search').value = ''; renderModalToc();
  tocDialog.showModal();
  revealCurrentChapter($('#modal-toc'));
};
$('#toc-search').addEventListener('input', event => {
  if (!(event as InputEvent).isComposing) renderModalToc();
});
$('#toc-search').addEventListener('compositionend', renderModalToc);
$('#toc-search-form').onsubmit = event => { event.preventDefault(); };
$('#toc-search-clear').onclick = () => {
  $<HTMLInputElement>('#toc-search').value = ''; renderModalToc(); $('#toc-search').focus();
};
$('#close-toc').onclick = () => tocDialog.close();
tocDialog.onclick = event => {
  if (event.target !== tocDialog) return;
  const rect = tocDialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) tocDialog.close();
};
$('#prev').onclick = () => goChapter(chapterIndex - 1);
$('#next').onclick = () => {
  if (!book || !current || restoring) return;
  if (chapterIndex < book.chapters.length - 1) { goChapter(chapterIndex + 1); return; }
  writePoint(makeProgress(chapterIndex, book.chapters[chapterIndex].blocks.length - 1, 1));
  restoring = true; // Keep the explicit completion point when returning to the shelf.
  navigateShelf();
};
$('#retry').onclick = () => retryAction();
$('#reset-progress').onclick = () => {
  if (!current || !confirm('要从头开始阅读这本书吗？这会覆盖当前浏览器中的旧进度。')) return;
  if (!store.clear(idFor(current))) toast('当前浏览器无法清除进度');
  void renderChapter(0, null);
};
const syncDialog = $<HTMLDialogElement>('#sync-dialog');
$('#sync-button').onclick = () => { renderSyncSettings(); syncDialog.showModal(); };
$('#close-sync').onclick = () => syncDialog.close();
syncDialog.addEventListener('close', () => {
  $<HTMLInputElement>('#sync-key-output').value = '';
  $('#sync-key-output').hidden = true;
  $<HTMLInputElement>('#sync-key-input').value = '';
});
async function connectSync(key: string, create: boolean) {
  const controls = [...syncDialog.querySelectorAll<HTMLButtonElement>('button')];
  controls.forEach(button => { button.disabled = true; });
  try {
    saveProgress(); await sync.connect(key, create); renderSyncSettings();
    $<HTMLInputElement>('#sync-key-input').value = '';
    $('#sync-status').textContent = create ? '同步密钥已创建，请复制并妥善备份' : '已连接同一份线上进度';
    await startBookSync(current && book ? store.read(idFor(current), current.version, book.chapters) : null);
  } catch (error) { $('#sync-status').textContent = errorMessage(error); }
  finally { controls.forEach(button => { button.disabled = false; }); }
}
$('#create-sync').onclick = () => {
  try { void connectSync(makeSyncKey(), true); }
  catch { $('#sync-status').textContent = '此浏览器无法生成安全密钥，请使用 HTTPS 和新版浏览器'; }
};
$('#connect-sync-form').onsubmit = event => { event.preventDefault(); void connectSync($<HTMLInputElement>('#sync-key-input').value.trim().toLowerCase(), false); };
$('#copy-sync-key').onclick = () => {
  void Promise.resolve().then(() => navigator.clipboard.writeText(sync.credential)).then(() => toast('密钥已复制，请只在自己的设备间使用')).catch(() => {
    const output = $<HTMLInputElement>('#sync-key-output'); output.value = sync.credential; output.hidden = false; output.select();
    toast('浏览器不允许复制，请手动复制密钥');
  });
};
$('#reveal-sync-key').onclick = () => {
  const output = $<HTMLInputElement>('#sync-key-output'); output.hidden = !output.hidden;
  output.value = output.hidden ? '' : sync.credential;
  $('#reveal-sync-key').textContent = output.hidden ? '查看密钥' : '隐藏密钥';
};
$('#disconnect-sync').onclick = () => { saveProgress(); sync.disconnect(); renderSyncSettings(); };
$('#erase-sync').onclick = () => {
  if (!confirm('删除这份密钥关联的所有线上进度，并使密钥永久失效？本机书籍和本机进度不会删除。')) return;
  void sync.erase().then(renderSyncSettings).catch(error => { $('#sync-status').textContent = errorMessage(error); });
};
$('#retry-sync').onclick = () => { saveProgress(); void sync.check(); };
$('#keep-local').onclick = () => { saveProgress(); void sync.choose('local'); };
$('#use-remote').onclick = () => void sync.choose('remote');
try {
  const key = storage?.getItem('paper-reader:sync-key');
  if (key) void sync.resume(key).then(async () => {
    renderSyncSettings();
    if (current && book && !restoring) await startBookSync(store.read(idFor(current), current.version, book.chapters));
  }).catch(() => { $('#sync-status').textContent = '自动连接失败，请在同步设置中重新连接或重试'; });
} catch { /* local reading never depends on credentials storage */ }
renderShelf();
void refreshLocal().then(() => { if (shelf === 'local') route(); });
void loadCatalog();
