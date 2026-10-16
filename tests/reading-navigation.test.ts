import { afterEach, describe, expect, it, vi } from 'vitest';
import { jumpToReadingPosition, revealCurrentChapter } from '../src/reading-navigation';

const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, width: 200, left: 0, right: 200, x: 0, y: top, toJSON: () => ({}) });
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

function fixture(itemTop: number, itemBottom: number) {
  const list = document.createElement('nav');
  const active = document.createElement('button'); active.setAttribute('aria-current', 'true');
  list.append(active); document.body.append(list);
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(rect(100, 300));
  vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(itemTop, itemBottom));
  return list;
}

describe('reading navigation', () => {
  it('reveals a later chapter inside the list without scrolling the page', () => {
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const list = fixture(470, 514); list.scrollTop = 1000;
    const ancestorScroll = vi.fn();
    list.firstElementChild!.scrollIntoView = ancestorScroll;
    revealCurrentChapter(list);
    expect(list.scrollTop).toBe(1214);
    expect(scroll).not.toHaveBeenCalled(); expect(ancestorScroll).not.toHaveBeenCalled();
  });
  it('reveals an earlier chapter and does not move an already visible chapter', () => {
    const earlier = fixture(50, 94); earlier.scrollTop = 200;
    revealCurrentChapter(earlier); expect(earlier.scrollTop).toBe(150);
    const visible = fixture(130, 174); visible.scrollTop = 250;
    revealCurrentChapter(visible); expect(visible.scrollTop).toBe(250);
  });
  it('does nothing for hidden lists or missing current chapters', () => {
    const list = fixture(470, 514); list.scrollTop = 100;
    Object.defineProperty(list, 'clientHeight', { value: 0 });
    revealCurrentChapter(list); expect(list.scrollTop).toBe(100);
    list.replaceChildren(); revealCurrentChapter(list); expect(list.scrollTop).toBe(100);
  });
  it('jumps instantly and preserves existing smooth scroll preferences', () => {
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    document.documentElement.style.scrollBehavior = 'smooth';
    jumpToReadingPosition(-20);
    expect(scroll).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
    expect(document.documentElement.style.scrollBehavior).toBe('smooth');
    jumpToReadingPosition(1024);
    expect(scroll).toHaveBeenLastCalledWith({ top: 1024, left: 0, behavior: 'instant' });
    document.documentElement.style.scrollBehavior = '';
  });
});
