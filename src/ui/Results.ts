/** Contract results: verdict, grade, destruction against the requirement, stats and the score breakdown. */
import type { UiSound } from '../audio/types';
import type { ChallengeResult } from '../gameplay/challenges';
import { button, clamp01, createGate, focusQuiet, formatClock, formatInt, h, navKey, prefersReducedMotion } from './dom';
import type { UICallbacks } from './types';
import { keyHints } from './widgets';

const GRADE_CAPTION: Record<ChallengeResult['grade'], string> = {
  S: 'Surgical',
  A: 'Clean',
  B: 'Solid',
  C: 'Rough',
  D: 'Messy',
};

/** Timeline of the count-in, in milliseconds after the screen opens. */
const LINES_START = 460;
const LINE_STAGGER = 140;
const LINE_COUNT = 420;
const TOTAL_COUNT = 700;

interface Counter {
  el: HTMLElement;
  target: number;
  start: number;
  duration: number;
  signed: boolean;
  shown: number;
}

function formatPoints(n: number): string {
  if (n > 0) return `+${formatInt(n)}`;
  return formatInt(n);
}

function stat(label: string, value: string, note: string): HTMLElement {
  return h(
    'div',
    'bp-stat',
    h('span', 'bp-stat__k', label),
    h('span', 'bp-stat__v', value),
    h('span', 'bp-stat__note', note),
  );
}

export class ResultsScreen {
  readonly el: HTMLElement;
  private readonly tag: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly buttons: HTMLButtonElement[];
  private index = 0;
  private counters: Counter[] = [];
  private raf = 0;
  private readonly gate = createGate(900);
  private readonly sound: (kind: UiSound) => void;

  constructor(private readonly cb: UICallbacks) {
    this.sound = (kind) => cb.onUiSound(kind);

    this.tag = h('div', 'bp-mono bp-res__tag bp-in');
    this.title = h('h2', 'bp-title bp-res__title bp-in');
    this.title.style.setProperty('--i', '1');
    const stripe = h('div', 'bp-res__stripe bp-in');
    stripe.style.setProperty('--i', '2');
    this.body = h('div', 'bp-res__body');

    const retry = button('bp-btn', 'Retry');
    const menu = button('bp-btn', 'Main menu');
    this.buttons = [retry, menu];
    this.buttons.forEach((b, i) => {
      b.addEventListener('mouseenter', () => this.setIndex(i, false, true));
      b.addEventListener('focus', () => this.setIndex(i, false, false));
      b.addEventListener('click', () => {
        this.setIndex(i, true, false);
        this.activate();
      });
    });

    const foot = h(
      'div',
      'bp-res__foot bp-in',
      retry,
      menu,
      keyHints([
        ['A D', 'Choose'],
        ['Enter', 'Confirm'],
      ]),
    );
    foot.style.setProperty('--i', '6');

    this.el = h(
      'div',
      'bp-screen bp-results',
      h('div', 'bp-scrim'),
      h('div', 'bp-res__frame', h('header', 'bp-res__head', this.tag, this.title, stripe), this.body, foot),
    );
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Contract results');
  }

  open(r: ChallengeResult): void {
    this.cancel();
    this.counters = [];

    const c = r.challenge;
    this.el.dataset.passed = r.passed ? 'true' : 'false';
    this.el.dataset.grade = r.grade;
    this.tag.textContent = `${c.code} // ${c.title} // ${c.targetName}`;
    this.title.textContent = r.passed ? 'Contract complete' : 'Contract failed';

    // Grade
    const grade = h(
      'div',
      'bp-grade bp-in',
      h('span', 'bp-mono', 'Grade'),
      h('span', 'bp-grade__letter', r.grade),
      h('span', 'bp-mono bp-grade__cap', GRADE_CAPTION[r.grade]),
    );
    grade.style.setProperty('--i', '3');

    // Destruction against the requirement
    const destroyed = clamp01(r.destroyed);
    const required = clamp01(c.targetFraction);
    const requiredPct = Math.round(required * 100);
    const meter = h(
      'div',
      `bp-meter bp-meter--lg${destroyed >= required ? ' is-complete' : ''}`,
      h('div', 'bp-meter__fill'),
      h('div', 'bp-meter__mark', h('span', 'bp-meter__req', `Req ${requiredPct}%`)),
    );
    meter.style.setProperty('--v', destroyed.toFixed(4));
    meter.style.setProperty('--req', required.toFixed(4));
    const dest = h(
      'div',
      'bp-res__dest bp-in',
      h(
        'div',
        'bp-res__dest-head',
        h('span', 'bp-mono', 'Target destroyed'),
        h(
          'span',
          'bp-res__dest-val',
          `${Math.floor(destroyed * 100 + 1e-6)}%`,
          h('span', 'bp-res__dest-of', `of ${requiredPct}% required`),
        ),
      ),
      meter,
    );
    dest.style.setProperty('--i', '3');

    // Stats
    const efficiency =
      r.explosivesUsed > 0 && r.efficiency > 0
        ? r.efficiency < 100
          ? r.efficiency.toFixed(1)
          : formatInt(r.efficiency)
        : '—';
    const stats = h(
      'div',
      'bp-stats bp-in',
      stat('Time used', formatClock(r.time), `of ${formatClock(c.timeLimit)}`),
      stat('Explosives used', formatInt(r.explosivesUsed), r.explosivesUsed === 1 ? 'device' : 'devices'),
      stat('Efficiency', efficiency, 'voxels / explosive'),
      stat('Structural damage', formatInt(r.structuralDamage), 'voxels removed'),
    );
    stats.style.setProperty('--i', '4');

    // Breakdown, counting in line by line
    const breakdown = h('div', 'bp-bd');
    r.breakdown.forEach((line, i) => {
      const start = LINES_START + i * LINE_STAGGER;
      const pts = h('span', 'bp-bd__pts', '0');
      const row = h(
        'div',
        'bp-bd__row bp-in',
        h('span', 'bp-bd__label', line.label),
        h('span', 'bp-bd__value', line.value),
        pts,
      );
      row.style.setProperty('--d', `${start}ms`);
      breakdown.append(row);
      this.counters.push({ el: pts, target: Math.round(line.points), start, duration: LINE_COUNT, signed: true, shown: 0 });
    });

    // Total and previous best
    const totalStart = LINES_START + r.breakdown.length * LINE_STAGGER + 80;
    const totalValue = h('span', 'bp-total__v', '0');
    this.counters.push({
      el: totalValue,
      target: Math.round(r.score),
      start: totalStart,
      duration: TOTAL_COUNT,
      signed: false,
      shown: 0,
    });
    let newBest: HTMLElement | null = null;
    if (r.score > r.best) {
      newBest = h('span', 'bp-newbest bp-in', 'New best');
      newBest.style.setProperty('--d', `${totalStart + TOTAL_COUNT}ms`);
    }
    const total = h(
      'div',
      'bp-total bp-in',
      h(
        'div',
        'bp-total__left',
        h('span', 'bp-mono', 'Total score'),
        h('span', 'bp-mono bp-total__best', `Previous best ${r.best > 0 ? formatInt(r.best) : '—'}`),
      ),
      h('div', 'bp-total__right', newBest, totalValue),
    );
    total.style.setProperty('--d', `${totalStart}ms`);

    this.body.replaceChildren(grade, h('div', 'bp-res__col', dest, stats, breakdown, total));

    this.el.classList.add('is-open');
    this.index = -1;
    this.setIndex(0, true, true);
    this.runCounters();
  }

  close(): void {
    this.cancel();
    this.el.classList.remove('is-open');
  }

  handleKey(e: KeyboardEvent): boolean {
    const nav = navKey(e);
    switch (nav) {
      case 'left':
      case 'up':
        this.setIndex(0, false, true);
        return true;
      case 'right':
      case 'down':
        this.setIndex(1, false, true);
        return true;
      case 'enter':
        if (!e.repeat) this.activate();
        return true;
      default:
        return false;
    }
  }

  private setIndex(i: number, silent: boolean, moveFocus: boolean): void {
    const changed = i !== this.index;
    this.index = i;
    this.buttons.forEach((b, k) => b.classList.toggle('is-active', k === i));
    if (moveFocus) focusQuiet(this.buttons[i]);
    if (changed && !silent) this.sound('hover');
  }

  private activate(): void {
    if (!this.gate()) return;
    if (this.index === 0) {
      this.sound('start');
      this.cb.onRestart();
    } else {
      this.sound('back');
      this.cb.onQuitToMenu();
    }
  }

  private cancel(): void {
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Count the score lines up. Menu-only work: it stops as soon as every number has landed. */
  private runCounters(): void {
    const write = (c: Counter, v: number): void => {
      c.shown = v;
      c.el.textContent = c.signed ? formatPoints(v) : formatInt(v);
    };
    if (prefersReducedMotion()) {
      for (const c of this.counters) write(c, c.target);
      return;
    }
    const t0 = performance.now();
    const step = (now: number): void => {
      const t = now - t0;
      let pending = false;
      for (const c of this.counters) {
        const p = clamp01((t - c.start) / c.duration);
        if (p < 1) pending = true;
        const v = p >= 1 ? c.target : Math.round(c.target * (1 - (1 - p) ** 3));
        if (v !== c.shown) write(c, v);
      }
      this.raf = pending ? requestAnimationFrame(step) : 0;
    };
    this.raf = requestAnimationFrame(step);
  }
}
