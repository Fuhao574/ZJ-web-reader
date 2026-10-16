import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { HttpSyncTransport, makeSyncKey, samePosition, SyncController, SyncFailure, syncBookKey, validSyncKey, type SyncRecord, type SyncTransport } from '../src/sync';
import type { Progress } from '../src/types';
import type { StorageLike } from '../src/progress';

const key = 'a'.repeat(64), hash = 'b'.repeat(64);
const context = { book: `epub:${hash}`, version: hash };
const point = (chapter = 1): Progress => ({ version: hash, chapter, block: 0, fraction: .3, percent: chapter * 2, updatedAt: 1790000000000 });
function storage(): StorageLike {
  const map = new Map<string, string>();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: key => { map.delete(key); } };
}
function fixture(saved = storage()) {
  const records = new Map<string, SyncRecord>();
  const transport: SyncTransport = { call: vi.fn(async (_key, action, body = {}) => {
    if (action === 'connect' || action === 'create' || action === 'erase') return {};
    const book = body.book as string;
    const record = records.get(book) ?? { revision: 0, progress: null };
    if (action === 'get') return { record: structuredClone(record) };
    if (record.revision !== body.revision) throw new SyncFailure('冲突', 409, structuredClone(record));
    const next = { revision: record.revision + 1, progress: body.progress as Progress };
    records.set(book, structuredClone(next)); return { record: structuredClone(next) };
  }) };
  const events = { status: vi.fn(), restore: vi.fn(), conflict: vi.fn() };
  return { records, transport, saved, events, controller: new SyncController(transport, saved, events) };
}
beforeAll(() => { vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { vi.useRealTimers(); });

describe('progress synchronization', () => {
  it('makes high entropy keys and matches local/cloud copies only by format and content hash', () => {
    const a = makeSyncKey(), b = makeSyncKey();
    expect(a).not.toBe(b); expect(validSyncKey(a)).toBe(true);
    expect(validSyncKey('password')).toBe(false);
    expect(syncBookKey('epub', hash)).toBe(context.book);
    expect(syncBookKey('txt', hash)).not.toBe(context.book);
    expect(syncBookKey('epub', 'sample-1')).toBeNull();
  });
  it('does nothing without a key, and does not send book contents or names', async () => {
    const f = fixture(); await f.controller.start(context, point()); f.controller.update(point(2)); await f.controller.flush();
    expect(f.transport.call).not.toHaveBeenCalled();
    await f.controller.connect(key, true); await f.controller.start(context, point());
    expect(f.records.get(context.book)).toEqual({ revision: 1, progress: point() });
    const call = vi.mocked(f.transport.call).mock.calls.find(call => call[1] === 'put')!;
    expect(Object.keys(call[2]!)).toEqual(['book', 'revision', 'progress']); f.controller.disconnect();
  });
  it('restores a remote position on a new device without writing a default beginning over it', async () => {
    const f = fixture(); f.records.set(context.book, { revision: 3, progress: point(20) });
    await f.controller.connect(key); await f.controller.start(context, null);
    expect(f.events.restore).toHaveBeenCalledWith(point(20));
    expect(vi.mocked(f.transport.call).mock.calls.filter(call => call[1] === 'put')).toHaveLength(0);
    f.controller.disconnect();
  });
  it('requires explicit choice when an existing local reading point differs from another device', async () => {
    const f = fixture(); f.records.set(context.book, { revision: 2, progress: point(20) });
    await f.controller.connect(key); await f.controller.start(context, point(4));
    expect(f.events.conflict).toHaveBeenLastCalledWith({ local: point(4), remote: point(20), revision: 2 });
    expect(f.records.get(context.book)!.revision).toBe(2);
    await f.controller.choose('remote'); expect(f.events.restore).toHaveBeenCalledWith(point(20));
    expect(f.records.get(context.book)!.revision).toBe(2); f.controller.disconnect();
  });
  it('uses CAS even after choosing the local conflict, and permits intentionally going backwards', async () => {
    const f = fixture(); f.records.set(context.book, { revision: 2, progress: point(20) });
    await f.controller.connect(key); await f.controller.start(context, point(4));
    f.records.set(context.book, { revision: 3, progress: point(21) });
    await f.controller.choose('local');
    expect(f.events.conflict).toHaveBeenLastCalledWith({ local: point(4), remote: point(21), revision: 3 });
    await f.controller.choose('local');
    expect(f.records.get(context.book)).toEqual({ revision: 4, progress: point(4) }); f.controller.disconnect();
  });
  it('adopts remote changes when this device has no unsynced changes', async () => {
    const f = fixture(); await f.controller.connect(key); await f.controller.start(context, point(4));
    f.records.set(context.book, { revision: 2, progress: point(6) });
    await f.controller.check();
    expect(f.events.restore).toHaveBeenCalledWith(point(6));
    expect(f.events.conflict).not.toHaveBeenCalledWith(expect.objectContaining({ local: expect.anything() }));
    f.controller.disconnect();
  });
  it('retains dirty positions through offline reload, then detects remote conflicts', async () => {
    const f = fixture(); await f.controller.connect(key); await f.controller.start(context, point(4));
    f.controller.update(point(5));
    vi.mocked(f.transport.call).mockRejectedValueOnce(new Error('offline'));
    await f.controller.flush(); f.controller.detach();
    f.records.set(context.book, { revision: 2, progress: point(20) });
    const resumed = new SyncController(f.transport, f.saved, f.events);
    await resumed.resume(key); await resumed.start(context, point(5));
    expect(f.events.conflict).toHaveBeenLastCalledWith({ local: point(5), remote: point(20), revision: 2 });
    expect(f.records.get(context.book)!.progress!.chapter).toBe(20); resumed.disconnect();
  });
  it('can resume an existing identity without an online connect request', async () => {
    const f = fixture(); vi.mocked(f.transport.call).mockRejectedValue(new Error('offline'));
    await f.controller.resume(key); expect(f.controller.connected).toBe(true);
    expect(f.transport.call).not.toHaveBeenCalled();
    await f.controller.start(context, point()); f.controller.update(point(3));
    expect(f.events.status).toHaveBeenLastCalledWith(expect.stringContaining('本机进度'));
    f.controller.disconnect();
  });
  it('restores an already synchronized copy when the same file is opened from a different shelf', async () => {
    const f = fixture(); await f.controller.connect(key); await f.controller.start(context, point(4));
    f.controller.detach(); f.events.restore.mockClear();
    await f.controller.start(context, null);
    expect(f.events.restore).toHaveBeenCalledWith(point(4)); f.controller.disconnect();
  });
  it('does not apply late remote reads to a different book', async () => {
    const f = fixture(); await f.controller.connect(key);
    let resolve!: (value: { record: SyncRecord }) => void;
    vi.mocked(f.transport.call).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const old = f.controller.start(context, null);
    const other = { book: `txt:${'c'.repeat(64)}`, version: 'c'.repeat(64) };
    await f.controller.start(other, null);
    resolve({ record: { revision: 9, progress: point(99) } }); await old;
    expect(f.events.restore).not.toHaveBeenCalled(); f.controller.disconnect();
  });
  it('merges rapid updates and does not mark newer in-flight reading as already saved', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.controller.connect(key); await f.controller.start(context, point(1));
    let resolve!: (value: { record: SyncRecord }) => void;
    vi.mocked(f.transport.call).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    f.controller.update(point(2)); const inFlight = f.controller.flush();
    f.controller.update(point(3)); f.controller.update(point(4));
    f.records.set(context.book, { revision: 2, progress: point(2) });
    resolve({ record: { revision: 2, progress: point(2) } }); await inFlight;
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.records.get(context.book)).toEqual({ revision: 3, progress: point(4) });
    f.controller.disconnect();
  });
  it('isolates different credentials, rejects malformed remote positions and disconnects without erasing', async () => {
    const f = fixture(); await f.controller.connect(key); await f.controller.start(context, point(1));
    const valid = vi.fn(() => false);
    const other = new SyncController(f.transport, f.saved, { ...f.events, valid });
    await other.connect('d'.repeat(64)); await other.start(context, null);
    expect(f.events.restore).not.toHaveBeenCalled();
    expect(f.events.status).toHaveBeenLastCalledWith(expect.stringContaining('本机进度'));
    const before = f.records.size; other.disconnect(); expect(f.records.size).toBe(before); f.controller.disconnect();
  });
  it('compares reading positions without relying on client timestamps', () => {
    expect(samePosition(point(1), { ...point(1), updatedAt: 1 })).toBe(true);
    expect(samePosition(point(1), point(2))).toBe(false);
  });
});

describe('sync HTTP transport', () => {
  it('puts the key in an authorization header, never in the URL, and rejects HTML fallbacks', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const transport = new HttpSyncTransport(new URL('https://reader.example/api/index.php'));
    await transport.call(key, 'connect');
    expect(String(fetcher.mock.calls[0][0])).toBe('https://reader.example/api/index.php');
    const options = fetcher.mock.calls[0][1]!;
    expect(options.headers).toMatchObject({ Authorization: `Bearer ${key}` });
    expect(options.body).toBe('{"action":"connect"}');
    fetcher.mockResolvedValueOnce(new Response('<html>fallback</html>'));
    await expect(transport.call(key, 'connect')).rejects.toThrow('接口尚未就绪');
    fetcher.mockRestore();
  });
});
