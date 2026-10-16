import { describe, expect, it } from 'vitest';
import { chapterScrollPercent, percentOf, ProgressStore, validateProgress } from '../src/progress';
import type { Chapter } from '../src/types';

const chapters: Chapter[] = [{ title: '一', blocks: [{ kind: 'paragraph', text: 'a' }, { kind: 'paragraph', text: 'b' }] }, { title: '二', blocks: [{ kind: 'paragraph', text: 'c' }] }];
describe('progress', () => {
  it('tracks chapter scrolling continuously even when whole-book progress rounds to zero', () => {
    expect(chapterScrollPercent(82, 1600, 67, 800)).toBe(0);
    const middle = chapterScrollPercent(-318, 1200, 67, 800);
    expect(middle).toBe(50);
    expect(chapterScrollPercent(-718, 800, 67, 800)).toBe(100);
    expect(chapterScrollPercent(-918, 600, 67, 800)).toBe(100);
    expect(chapterScrollPercent(182, 1700, 67, 800)).toBe(0);
  });
  it('finishes a short chapter already fully visible and responds to viewport changes', () => {
    expect(chapterScrollPercent(82, 600, 67, 800)).toBe(100);
    expect(chapterScrollPercent(82, 600, 67, 400)).toBe(0);
  });
  it('weights progress by blocks and validates bounds', () => {
    expect(percentOf(chapters, 0, 1, 0)).toBe(33);
    expect(percentOf(chapters, 1, 0, 0)).toBe(67);
    expect(validateProgress({ version: 'v', chapter: 0, block: 1, fraction: .5, percent: 50, updatedAt: 1 }, 'v', chapters)).not.toBeNull();
    expect(validateProgress({ version: 'v', chapter: 9, block: 0, fraction: 0, percent: 0, updatedAt: 1 }, 'v', chapters)).toBeNull();
  });
  it('survives unavailable storage', () => {
    const store = new ProgressStore(null); expect(store.write('id', { version: 'v', chapter: 0, block: 0, fraction: 0, percent: 0, updatedAt: 1 })).toBe(false); expect(store.read('id', 'v')).toBeNull();
  });
  it('isolates book IDs and invalidates changed editions or malformed saved data', () => {
    const values = new Map<string, string>();
    const store = new ProgressStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } });
    const point = { version: 'v1', chapter: 1, block: 0, fraction: .3, percent: 80, updatedAt: 1 };
    store.write('a', point);
    expect(store.read('a', 'v1')).toEqual(point);
    expect(store.read('b', 'v1')).toBeNull();
    expect(store.read('a', 'v2')).toBeNull();
    store.clear('a'); expect(store.read('a', 'v1')).toBeNull();
    values.set('paper-reader:v1:a', '{'); expect(store.read('a', 'v1')).toBeNull();
    expect(validateProgress({ ...point, fraction: Infinity }, 'v1')).toBeNull();
  });
});
