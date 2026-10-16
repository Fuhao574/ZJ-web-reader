import { validateProgress, type StorageLike } from './progress';
import type { Progress } from './types';

export interface SyncRecord { revision: number; progress: Progress | null }
export interface SyncContext { book: string; version: string }
interface State { revision: number; base: Progress | null; dirty: boolean; point: Progress | null }
export interface SyncConflict { local: Progress; remote: Progress; revision: number }
export interface SyncEvents {
  status(message: string): void;
  restore(point: Progress): void;
  conflict(value: SyncConflict | null): void;
  valid?(point: Progress): boolean;
}
export interface SyncTransport {
  call(key: string, action: string, data?: Record<string, unknown>): Promise<{ record?: SyncRecord }>;
}
export class SyncFailure extends Error {
  constructor(message: string, readonly status: number, readonly record?: SyncRecord) { super(message); }
}

export function samePosition(a: Progress | null, b: Progress | null): boolean {
  return a === b || (!!a && !!b && a.version === b.version && a.chapter === b.chapter && a.block === b.block && a.fraction === b.fraction && a.percent === b.percent);
}
export function makeSyncKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
}
export function validSyncKey(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
export function syncBookKey(format: 'txt' | 'epub', version: string): string | null {
  return /^[a-f0-9]{64}$/.test(version) ? `${format}:${version}` : null;
}

export class HttpSyncTransport implements SyncTransport {
  constructor(private endpoint: URL) {}
  async call(key: string, action: string, data: Record<string, unknown> = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
    const response = await fetch(this.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ action, ...data }), cache: 'no-store', credentials: 'omit',
      signal: controller.signal, keepalive: true,
    });
    let result;
    try { result = await response.json(); } catch { throw new SyncFailure('同步接口尚未就绪，本机进度仍会保留', response.status); }
    if (!response.ok) throw new SyncFailure(result.message || '同步失败，本机进度仍会保留', response.status, result.record);
    if (!result || typeof result !== 'object' || (['create', 'connect', 'erase'].includes(action) && result.ok !== true)) throw new SyncFailure('同步回执格式无效', 502);
    return result as { record?: SyncRecord };
    } finally { clearTimeout(timeout); }
  }
}

/** One active book, serialized writes, CAS revisions and durable offline intent.
 * Never advances a dirty baseline just because a newer remote position exists.
 */
export class SyncController {
  private key = '';
  private namespace = '';
  private context: SyncContext | null = null;
  private state: State | null = null;
  private epoch = 0;
  private ready = false;
  private checking = false;
  private writing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private conflictValue: SyncConflict | null = null;

  constructor(private transport: SyncTransport, private storage: StorageLike | null, private events: SyncEvents) {}
  get connected() { return !!this.key; }
  get credential() { return this.key; }

  async connect(key: string, create = false): Promise<void> {
    if (!validSyncKey(key)) throw new Error('同步密钥应为 64 位十六进制字符');
    if (!crypto.subtle) throw new Error('线上同步需要 HTTPS 或 localhost 环境');
    // Finish the previous identity before validating / activating a replacement.
    // A failed new-key connection must not strand its unsent local queue.
    if (this.key && this.state?.dirty) {
      await this.flush();
      if (this.state?.dirty || this.conflictValue) throw new Error('当前同步还有未处理的进度冲突，请先处理后再切换密钥');
    }
    await this.transport.call(key, create ? 'create' : 'connect');
    await this.activate(key);
  }
  private async activate(key: string): Promise<void> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    this.detach();
    this.key = key;
    this.namespace = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
    try { this.storage?.setItem('paper-reader:sync-key', key); } catch { this.events.status('同步已连接，但无法记住密钥，请自行保存'); }
  }
  async resume(key: string): Promise<void> {
    if (!validSyncKey(key)) throw new Error('已保存的密钥无效');
    // Keep an existing identity while offline. get/put still authenticate at the server.
    await this.activate(key);
    this.events.status('同步密钥已连接，阅读时检查线上位置');
  }
  detach(): void {
    this.epoch++; this.context = null; this.state = null; this.ready = false; this.checking = false;
    this.conflictValue = null; clearTimeout(this.timer); this.events.conflict(null);
  }
  disconnect(): void {
    this.detach(); this.key = ''; this.namespace = '';
    try { this.storage?.removeItem('paper-reader:sync-key'); } catch { /* in-memory disconnect still works */ }
    this.events.status('未开启同步 · 进度仍保存在本机');
  }
  async erase(): Promise<void> {
    if (!this.key) return;
    await this.transport.call(this.key, 'erase'); this.disconnect();
  }
  private storageKey(context: SyncContext) { return `paper-reader:sync-state:${this.namespace}:${context.book}`; }
  private load(context: SyncContext): State | null {
    try {
      const raw = JSON.parse(this.storage?.getItem(this.storageKey(context)) ?? 'null');
      if (!raw || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || typeof raw.dirty !== 'boolean') return null;
      const base = raw.base === null ? null : validateProgress(raw.base, context.version);
      const point = raw.point === null ? null : validateProgress(raw.point, context.version);
      if ((raw.base !== null && !base) || (raw.point !== null && !point)) return null;
      return { revision: raw.revision, base, point, dirty: raw.dirty };
    } catch { return null; }
  }
  private persist() {
    if (!this.context || !this.state) return;
    try { this.storage?.setItem(this.storageKey(this.context), JSON.stringify(this.state)); }
    catch { this.events.status('浏览器无法保存同步队列，请保持页面打开后重试'); }
  }
  async start(context: SyncContext, local: Progress | null): Promise<void> {
    this.detach(); this.context = context;
    if (!this.key) return;
    this.state = this.load(context) ?? { revision: 0, base: null, dirty: !!local, point: local };
    // Another source of the same file (local/cloud) may not have its own local
    // record yet. Reuse the durable sync point instead of silently showing page 1.
    if (!local && this.state.point && (!this.events.valid || this.events.valid(this.state.point))) this.events.restore(this.state.point);
    this.state.point = local ?? this.state.point;
    this.state.dirty = !samePosition(this.state.point, this.state.base);
    await this.check();
  }
  update(point: Progress): void {
    if (!this.key || !this.context || !this.state) return;
    this.state.point = { ...point, version: this.context.version };
    this.state.dirty = !samePosition(this.state.point, this.state.base);
    if (this.conflictValue) {
      this.conflictValue.local = this.state.point;
      this.events.conflict(this.conflictValue);
    }
    this.persist();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 1500);
  }
  private record(raw: SyncRecord | undefined): SyncRecord {
    if (!this.context || !raw || !Number.isSafeInteger(raw.revision) || raw.revision < 0) throw new Error('同步回执无效');
    const point = raw.progress === null ? null : validateProgress(raw.progress, this.context.version);
    if ((raw.progress !== null && !point) || (raw.revision === 0) !== (point === null) || (point && this.events.valid && !this.events.valid(point))) throw new Error('线上进度格式无效');
    return { revision: raw.revision, progress: point };
  }
  private report(error: unknown) {
    this.events.status(error instanceof SyncFailure ? error.message : '网络异常 · 本机进度已保留，可稍后重试同步');
  }
  async check(): Promise<void> {
    if (!this.key || !this.context || !this.state || this.checking || this.writing || this.conflictValue) return;
    const epoch = this.epoch; this.checking = true;
    this.events.status('正在检查线上进度…');
    try {
      const result = await this.transport.call(this.key, 'get', { book: this.context.book });
      if (epoch !== this.epoch) return;
      const remote = this.record(result.record);
      const state = this.state!;
      if (remote.progress && state.point && !samePosition(remote.progress, state.point) && state.dirty && remote.revision !== state.revision) {
        this.conflictValue = { local: state.point, remote: remote.progress, revision: remote.revision };
        this.events.conflict(this.conflictValue); this.events.status('发现不同阅读位置，请选择保留哪一份'); return;
      }
      if (!state.dirty || samePosition(remote.progress, state.point)) {
        const changed = !samePosition(state.point, remote.progress);
        state.point = remote.progress; state.base = remote.progress; state.revision = remote.revision; state.dirty = false;
        if (changed && remote.progress) this.events.restore(remote.progress);
      } else if (!remote.progress) {
        state.revision = 0; state.base = null;
      }
      this.ready = true; this.persist();
      this.events.status(state.dirty ? '本机进度等待同步' : '线上进度已同步');
    } catch (error) { if (epoch === this.epoch) { this.ready = false; this.report(error); } }
    finally { if (epoch === this.epoch) this.checking = false; }
    if (epoch === this.epoch && this.ready) await this.flush();
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.key || !this.context || !this.state || this.conflictValue || this.writing || this.checking) return;
    if (!this.ready) { await this.check(); return; }
    if (!this.state.dirty || !this.state.point) return;
    const epoch = this.epoch;
    const sent = { ...this.state.point };
    const revision = this.state.revision;
    this.writing = true; this.events.status('正在保存线上进度…');
    try {
      const result = await this.transport.call(this.key, 'put', { book: this.context.book, revision, progress: sent });
      if (epoch !== this.epoch) return;
      const remote = this.record(result.record);
      if (!samePosition(remote.progress, sent) || remote.revision !== revision + 1) throw new Error('同步回执位置或版本不匹配');
      this.state!.revision = remote.revision; this.state!.base = sent;
      this.state!.dirty = !samePosition(this.state!.point, sent); this.persist();
      this.events.status(this.state!.dirty ? '新进度等待同步' : '线上进度已保存');
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (error instanceof SyncFailure && error.status === 409) {
        try {
          const remote = this.record(error.record);
          if (!remote.progress) { this.ready = false; this.report(error); }
          else {
            this.conflictValue = { local: this.state!.point!, remote: remote.progress, revision: remote.revision };
            this.events.conflict(this.conflictValue); this.events.status('另一设备更新了进度，请选择保留哪一份');
          }
        } catch { this.ready = false; this.events.status('线上冲突回执无效，本机进度已保留'); }
      } else { this.ready = false; this.report(error); }
    } finally {
      this.writing = false;
      if (epoch !== this.epoch && this.context) queueMicrotask(() => void this.check());
    }
    if (epoch === this.epoch && this.ready && this.state?.dirty && !this.conflictValue) this.timer = setTimeout(() => void this.flush(), 1500);
  }
  async choose(choice: 'local' | 'remote'): Promise<void> {
    if (!this.state || !this.conflictValue || this.writing) return;
    const conflict = this.conflictValue;
    this.conflictValue = null; this.state.revision = conflict.revision; this.state.base = conflict.remote;
    if (choice === 'remote') { this.state.point = conflict.remote; this.state.dirty = false; this.events.restore(conflict.remote); }
    else this.state.dirty = !samePosition(this.state.point, conflict.remote);
    this.ready = true; this.persist(); this.events.conflict(null);
    this.events.status(choice === 'remote' ? '已采用线上位置' : '正在保留本机位置…');
    await this.flush();
  }
}
