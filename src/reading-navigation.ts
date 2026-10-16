/** Reveal an active chapter by scrolling ONLY its list, never document ancestors. */
export function revealCurrentChapter(list: HTMLElement): void {
  const active = list.querySelector<HTMLElement>('[aria-current="true"]');
  if (!active || list.clientHeight <= 0) return;
  const bounds = list.getBoundingClientRect();
  const item = active.getBoundingClientRect();
  const top = bounds.top + list.clientTop;
  const bottom = top + list.clientHeight;
  const delta = item.top < top ? item.top - top : item.bottom > bottom ? item.bottom - bottom : 0;
  if (delta) list.scrollTop = Math.max(0, list.scrollTop + delta);
}

/** Ignore smooth-scroll preferences when switching chapters or restoring an exact point. */
export function jumpToReadingPosition(top: number): void {
  const root = document.documentElement;
  const previous = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  try { window.scrollTo({ top: Math.max(0, top), left: 0, behavior: 'instant' }); }
  finally { root.style.scrollBehavior = previous; }
}
