import { beforeAll, describe, expect, it, vi } from 'vitest';
import html from '../index.html?raw';
import 'fake-indexeddb/auto';
import { LocalLibrary } from '../src/local-library';

const savedKey = 'paper-reader:v1:book:test';
const ready = () => vi.waitFor(() => expect(document.querySelector('#reader-view')!.getAttribute('aria-busy')).toBe('false'));

describe('reader lifecycle', () => {
  beforeAll(async () => {
    document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1];
    localStorage.clear(); history.replaceState(null, '', '/');
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; };
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      const text = String(url).includes('catalog.json')
        ? JSON.stringify([{ id: 'test', title: '测试书', file: 'books/test.txt', format: 'txt', version: '1' }])
        : '第一章 开始\n段落一\n段落二\n第二章 继续\n段落三';
      return new Response(text, { status: 200 });
    }));
    await import('../src/main');
    await vi.waitFor(() => expect(document.querySelector('.book-card')).not.toBeNull());
  });
  it('searches chapter titles in the modal only, clears results and preserves the original chapter target', async () => {
    (document.querySelector('.book-card') as HTMLButtonElement).click(); await ready();
    (document.querySelector('#toc-button') as HTMLButtonElement).click();
    const input = document.querySelector('#toc-search') as HTMLInputElement;
    const search = (value: string) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
    expect(document.querySelectorAll('#modal-toc button')).toHaveLength(2);
    search('  开始  ');
    expect(document.querySelectorAll('#modal-toc button')).toHaveLength(1);
    expect(document.querySelector('#modal-toc')!.textContent).toContain('第一章 开始');
    expect(document.querySelectorAll('#side-toc button')).toHaveLength(2);
    expect(document.querySelector('#toc-search-status')!.textContent).toContain('1');
    search('不存在的章节');
    expect(document.querySelectorAll('#modal-toc button')).toHaveLength(0);
    expect(document.querySelector('#toc-search-status')!.textContent).toContain('没有找到');
    (document.querySelector('#toc-search-clear') as HTMLButtonElement).click();
    expect(input.value).toBe('');
    expect(document.querySelectorAll('#modal-toc button')).toHaveLength(2);
    search('开始');
    (document.querySelector('#modal-toc button') as HTMLButtonElement).click(); await ready();
    expect((document.querySelector('#toc-dialog') as HTMLDialogElement).open).toBe(false);
    expect(document.querySelector('#chapter-title')!.textContent).toBe('第一章 开始');
    expect(JSON.parse(localStorage.getItem(savedKey)!).chapter).toBe(0);
    (document.querySelector('#toc-button') as HTMLButtonElement).click();
    expect(input.value).toBe('');
    expect(document.querySelectorAll('#modal-toc button')).toHaveLength(2);
    (document.querySelector('#close-toc') as HTMLButtonElement).click();
    (document.querySelector('#shelf-button') as HTMLButtonElement).click();
    localStorage.removeItem(savedKey);
  });
  it('opens a server book, saves chapter changes, and does not corrupt progress on shelf scroll', async () => {
    const visible = (id: string) => !(document.querySelector(id) as HTMLElement).hidden;
    expect(visible('#shelf-view')).toBe(true);
    (document.querySelector('.book-card') as HTMLButtonElement).click();
    await ready();
    expect(visible('#reader-view')).toBe(true);
    expect(document.querySelector('#chapter-title')!.textContent).toBe('第一章 开始');
    (document.querySelector('#next') as HTMLButtonElement).click(); await ready();
    expect(JSON.parse(localStorage.getItem(savedKey)!).chapter).toBe(1);
    (document.querySelector('#shelf-button') as HTMLButtonElement).click();
    expect(visible('#shelf-view')).toBe(true);
    const before = localStorage.getItem(savedKey);
    window.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem(savedKey)).toBe(before);
    (document.querySelector('.book-card') as HTMLButtonElement).click(); await ready();
    expect(document.querySelector('#chapter-title')!.textContent).toBe('第二章 继续');
    expect(document.querySelector('#save-state')!.textContent).toContain('已恢复');
    expect(document.querySelectorAll('input[type=file]')).toHaveLength(1);
    expect((document.querySelector('#local-import') as HTMLElement).hidden).toBe(true);
    (document.querySelector('#next') as HTMLButtonElement).click();
    expect(JSON.parse(localStorage.getItem(savedKey)!).percent).toBe(100);
    expect(visible('#shelf-view')).toBe(true);
    (document.querySelector('.book-card') as HTMLButtonElement).click(); await ready();
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(localStorage.getItem(savedKey)!).percent).toBe(100);
  });
  it('keeps local books separate and reads them without requesting the file from the server', async () => {
    const library = new LocalLibrary();
    await library.put({ entry: { id: 'local-fixture', title: '本机书', format: 'txt', file: '', version: '1' }, bytes: new TextEncoder().encode('第一章 本地\n本机正文').buffer, addedAt: Date.now() });
    (document.querySelector('#shelf-button') as HTMLButtonElement).click();
    (document.querySelector('#local-tab') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('#shelf-grid')!.textContent).toContain('本机书'));
    expect(document.querySelector('#shelf-grid')!.textContent).not.toContain('测试书');
    expect((document.querySelector('#local-import') as HTMLElement).hidden).toBe(false);
    const requests = vi.mocked(fetch).mock.calls.length;
    (document.querySelector('.book-card') as HTMLButtonElement).click(); await ready();
    expect(document.querySelector('#chapter-title')!.textContent).toBe('第一章 本地');
    expect(document.querySelector('#format-label')!.textContent).toContain('LOCAL');
    expect(vi.mocked(fetch).mock.calls).toHaveLength(requests);
    expect(localStorage.getItem('paper-reader:v1:local:local-fixture')).not.toBeNull();
    (document.querySelector('#shelf-button') as HTMLButtonElement).click();
    (document.querySelector('#cloud-tab') as HTMLButtonElement).click();
    expect(document.querySelector('#shelf-grid')!.textContent).toContain('测试书');
    expect(document.querySelector('#shelf-grid')!.textContent).not.toContain('本机书');
  });
});
