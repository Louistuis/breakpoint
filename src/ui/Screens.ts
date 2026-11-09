/** Full-screen, opaque system screens: loading and fatal error. */
import { button, clamp01, h } from './dom';
import { createWordmark } from './widgets';

export class LoadingScreen {
  readonly el: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly label: HTMLElement;
  private readonly pct: HTMLElement;
  private readonly bar: HTMLElement;
  private visible = false;
  private lastLabel = '';
  private lastPct = -1;
  private lastPctText = '';

  constructor() {
    this.fill = h('i', 'bp-loading__fill');
    this.bar = h('div', 'bp-loading__bar', this.fill);
    this.bar.setAttribute('role', 'progressbar');
    this.bar.setAttribute('aria-valuemin', '0');
    this.bar.setAttribute('aria-valuemax', '100');
    this.label = h('span', 'bp-loading__label');
    this.pct = h('span', 'bp-loading__pct');

    this.el = h(
      'div',
      'bp-loading',
      h(
        'div',
        'bp-loading__inner',
        createWordmark('mid'),
        this.bar,
        h('div', 'bp-loading__row', this.label, this.pct),
      ),
      h('div', 'bp-mono bp-loading__foot', 'Everything on this site is generated on your machine'),
    );
    this.el.setAttribute('aria-live', 'polite');
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Safe to call as often as progress changes; only differences reach the DOM. */
  show(progress: number, label: string): void {
    if (!this.visible) {
      this.visible = true;
      this.el.classList.add('is-open');
    }
    const p = clamp01(Number.isFinite(progress) ? progress : 0);
    const pct = Math.round(p * 100);
    if (pct !== this.lastPct) {
      this.lastPct = pct;
      this.fill.style.transform = `scaleX(${p.toFixed(3)})`;
      this.bar.setAttribute('aria-valuenow', String(pct));
    }
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      this.label.textContent = label;
    }
    // The caller may already put a percentage in the label ("MESHING DISTRICT 62%").
    const pctText = label.includes('%') ? '' : `${pct}%`;
    if (pctText !== this.lastPctText) {
      this.lastPctText = pctText;
      this.pct.textContent = pctText;
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.remove('is-open');
  }
}

export class ErrorScreen {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly reload: HTMLButtonElement;
  private visible = false;

  constructor() {
    this.title = h('h2', 'bp-title bp-error__title');
    this.detail = h('p', 'bp-error__detail');
    this.reload = button('bp-btn is-active', 'Reload');
    this.reload.addEventListener('click', () => window.location.reload());

    this.el = h(
      'div',
      'bp-error',
      h(
        'div',
        'bp-error__inner',
        h('div', 'bp-mono bp-error__tag', 'Breakpoint // Fault'),
        h('div', 'bp-stripe bp-stripe--hazard'),
        this.title,
        this.detail,
        this.reload,
      ),
    );
    this.el.setAttribute('role', 'alertdialog');
    this.el.setAttribute('aria-label', 'Error');
  }

  get isVisible(): boolean {
    return this.visible;
  }

  show(title: string, detail: string): void {
    this.visible = true;
    this.title.textContent = title;
    this.detail.textContent = detail;
    this.el.classList.add('is-open');
    this.reload.focus({ preventScroll: true });
  }
}
