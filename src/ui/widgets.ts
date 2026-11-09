/** Shared presentational pieces: the fractured wordmark, key caps, hint bars and sub-screen headers. */
import { h } from './dom';

export type WordmarkSize = 'hero' | 'mid';

/**
 * The BREAKPOINT wordmark: one word, cut on a diagonal. Two clipped copies of the text sit a few
 * pixels apart along the cut and the exposed edge is drawn in the accent colour (see .bp-wm in styles.css).
 */
export function createWordmark(size: WordmarkSize = 'hero'): HTMLElement {
  const text = 'BREAKPOINT';
  const el = h(
    'div',
    `bp-wm bp-wm--${size}`,
    h('span', 'bp-wm__ghost', text),
    h('span', 'bp-wm__half bp-wm__half--a', text),
    h('span', 'bp-wm__half bp-wm__half--b', text),
    h('span', 'bp-wm__cut'),
  );
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', text);
  for (const child of Array.from(el.children)) child.setAttribute('aria-hidden', 'true');
  return el;
}

export function keyCap(text: string): HTMLElement {
  return h('kbd', 'bp-key', text);
}

/** [keys separated by spaces, label], e.g. ['W S', 'Navigate']. */
export type Hint = readonly [keys: string, label: string];

export function setKeyHints(el: HTMLElement, hints: readonly Hint[]): void {
  el.replaceChildren(
    ...hints.map(([keys, label]) =>
      h('span', 'bp-hint', ...keys.split(' ').map((k) => keyCap(k)), h('span', 'bp-hint__label', label)),
    ),
  );
}

export function keyHints(hints: readonly Hint[]): HTMLElement {
  const el = h('div', 'bp-hints');
  setKeyHints(el, hints);
  return el;
}

/** Breadcrumb + title (+ optional one-line summary) used at the top of every sub-screen. */
export function viewHead(crumb: string, title: string, sub?: string): HTMLElement {
  return h(
    'header',
    'bp-head bp-in',
    h('div', 'bp-crumb', crumb),
    h('h2', 'bp-title', title),
    sub ? h('p', 'bp-sub', sub) : null,
  );
}
