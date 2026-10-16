import type { Chapter, Progress } from './types';

const PREFIX = 'paper-reader:v1:';
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function validateProgress(raw: unknown, version: string, chapters?: Chapter[]): Progress | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Progress;
  if (p.version !== version || !Number.isSafeInteger(p.chapter) || p.chapter < 0 || !Number.isSafeInteger(p.block) || p.block < 0 ||
      !Number.isFinite(p.fraction) || p.fraction < 0 || p.fraction > 1 || !Number.isFinite(p.percent) || p.percent < 0 || p.percent > 100 ||
      !Number.isFinite(p.updatedAt) || p.updatedAt < 0) return null;
  if (chapters && (p.chapter >= chapters.length || p.block >= chapters[p.chapter].blocks.length)) return null;
  return p;
}

export class ProgressStore {
  available = true;
  constructor(private storage: StorageLike | null) { this.available = storage !== null; }
  read(id: string, version: string, chapters?: Chapter[]): Progress | null {
    try { return validateProgress(JSON.parse(this.storage?.getItem(PREFIX + id) ?? 'null'), version, chapters); }
    catch { return null; }
  }
  write(id: string, progress: Progress): boolean {
    try {
      if (!this.storage) throw new Error('No storage');
      this.storage.setItem(PREFIX + id, JSON.stringify(progress));
      this.available = true; return true;
    } catch { this.available = false; return false; }
  }
  clear(id: string): boolean {
    try {
      if (!this.storage) throw new Error('No storage');
      this.storage.removeItem(PREFIX + id); return true;
    } catch { this.available = false; return false; }
  }
}

/** Paragraph/block count weighted, not page scroll percentage (sidebar is excluded). */
export function percentOf(chapters: Chapter[], chapter: number, block: number, fraction: number): number {
  const total = chapters.reduce((n, c) => n + c.blocks.length, 0);
  const before = chapters.slice(0, chapter).reduce((n, c) => n + c.blocks.length, 0);
  return total ? Math.max(0, Math.min(100, Math.round((before + block + fraction) / total * 100))) : 0;
}
