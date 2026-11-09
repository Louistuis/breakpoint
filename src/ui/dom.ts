/** Small framework-free DOM helpers shared by the UI modules. */

export type Child = Node | string | null | undefined | false;

/** Create an element with a class name and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c);
  }
  return el;
}

export function button(className: string, ...children: Child[]): HTMLButtonElement {
  const b = h('button', className, ...children);
  b.type = 'button';
  return b;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Inline SVG from static, trusted markup (icons authored in this folder). Built once, never per frame. */
export function svg(viewBox: string, markup: string, className?: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  if (className) el.setAttribute('class', className);
  el.innerHTML = markup;
  return el;
}

/** Text node wrapper that only touches the DOM when the string actually changes. */
export class TextCell {
  private last: string;

  constructor(
    readonly el: HTMLElement,
    initial = '',
  ) {
    this.last = initial;
    el.textContent = initial;
  }

  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    this.el.textContent = value;
  }
}

export function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/** Whole seconds as m:ss. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** Integer with thousands separators, independent of the browser locale. */
export function formatInt(n: number): string {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const digits = String(Math.abs(v));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return v < 0 ? `−${out}` : out;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

const reducedMotionQuery: MediaQueryList | null =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

export function prefersReducedMotion(): boolean {
  return reducedMotionQuery !== null && reducedMotionQuery.matches;
}

/** Returns a function that answers true at most once per `ms` (guards against double activation). */
export function createGate(ms: number): () => boolean {
  let until = 0;
  return () => {
    const now = performance.now();
    if (now < until) return false;
    until = now + ms;
    return true;
  };
}

export type NavKey = 'up' | 'down' | 'left' | 'right' | 'enter' | 'back';

/** Map a key press to a menu navigation intent (arrows or W A S D, Enter, Esc / Backspace). */
export function navKey(e: KeyboardEvent): NavKey | null {
  switch (e.code) {
    case 'ArrowUp':
    case 'KeyW':
      return 'up';
    case 'ArrowDown':
    case 'KeyS':
      return 'down';
    case 'ArrowLeft':
    case 'KeyA':
      return 'left';
    case 'ArrowRight':
    case 'KeyD':
      return 'right';
    case 'Enter':
    case 'NumpadEnter':
      return 'enter';
    case 'Escape':
    case 'Backspace':
      return 'back';
    default:
      return null;
  }
}

/** Move keyboard focus without scrolling anything. */
export function focusQuiet(el: HTMLElement): void {
  el.focus({ preventScroll: true });
}
