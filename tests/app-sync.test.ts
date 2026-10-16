import { beforeAll, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import 'fake-indexeddb/auto';
import html from '../index.html?raw';
import type { Progress } from '../src/types';

const hash = 'b'.repeat(64);
let remote: { revision: number; progress: Progress | null } = { revision: 1, progress: { version: hash, chapter: 1, block: 0, fraction: .2, percent: 60, updatedAt: 1 } };
const ready = () => vi.waitFor(() => {
  expect((document.querySelector('#reader-view') as HTMLElement).hidden).toBe(false);
  expect(document.querySelector('#reader-view')!.getAttribute('aria-busy')).toBe('false');
});

describe('online progress user flow', () => {
  beforeAll(async () => {
    document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1];
    localStorage.clear(); history.replaceState(null, '', '/');
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init?: RequestInit) => {
      if (String(url).includes('api/index.php')) {
        const body = JSON.parse(init!.body as string);
        if (body.action === 'connect') return Response.json({ ok: true });
        if (body.action === 'get') return Response.json({ record: remote });
        if (body.action === 'put') {
          if (body.revision !== remote.revision) return Response.json({ record: remote }, { status: 409 });
          remote = { revision: remote.revision + 1, progress: body.progress }; return Response.json({ record: remote });
        }
      }
      if (String(url).includes('catalog.json')) return Response.json([{ id: 'synced', title: '同步测试书', file: 'books/test.txt', format: 'txt', version: hash }]);
      return new Response('第一章 开始\n本机正文\n第二章 继续\n第二章正文');
    }));
    await import('../src/main');
    await vi.waitFor(() => expect(document.querySelector('.book-card')).not.toBeNull());
  });
  it('connects by key, asks about conflicting positions and adopts remote without writing over it', async () => {
    (document.querySelector('.book-card') as HTMLButtonElement).click(); await ready();
    (document.querySelector('#sync-button') as HTMLButtonElement).click();
    (document.querySelector('#sync-key-input') as HTMLInputElement).value = 'a'.repeat(64);
    document.querySelector('#connect-sync-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect((document.querySelector('#sync-conflict') as HTMLElement).hidden).toBe(false));
    expect(document.querySelector('#conflict-detail')!.textContent).toContain('线上：第 2 章');
    expect(remote.revision).toBe(1);
    (document.querySelector('#close-sync') as HTMLButtonElement).click();
    (document.querySelector('#use-remote') as HTMLButtonElement).click(); await ready();
    expect(document.querySelector('#chapter-title')!.textContent).toBe('第二章 继续');
    expect(remote.revision).toBe(1);
    expect(JSON.parse(localStorage.getItem('paper-reader:v1:book:synced')!).chapter).toBe(1);
    (document.querySelector('#sync-button') as HTMLButtonElement).click();
    (document.querySelector('#disconnect-sync') as HTMLButtonElement).click();
    expect(localStorage.getItem('paper-reader:sync-key')).toBeNull();
    expect(remote.revision).toBe(1);
  });
});
