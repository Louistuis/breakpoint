/**
 * Settings panel, shared by the main menu and the pause menu.
 * Every control writes straight to the `settings` store and repaints from it, so external
 * changes (adaptive quality, F3, reset) show up immediately.
 */
import type { UiSound } from '../audio/types';
import { SETTING_LIMITS, settings, type GameSettings } from '../utils/settings';
import { button, focusQuiet, h, navKey } from './dom';
import { viewHead } from './widgets';

type NumKey = keyof typeof SETTING_LIMITS;
type BoolKey = 'bloom' | 'adaptiveQuality' | 'lowPower' | 'showPerf' | 'unlimitedAmmo';
type EnumKey = 'quality' | 'shadows' | 'frameLimit';

interface Row {
  /** Element that carries the highlight. */
  readonly el: HTMLElement;
  /** Element that receives keyboard focus. */
  readonly focusEl: HTMLElement;
  readonly hint: string;
  /** Footer buttons (reset / back) rather than a setting. */
  readonly action: boolean;
  sync(): void;
  /** Left / right. */
  adjust(dir: -1 | 1): void;
  /** Enter. */
  activate(): void;
}

export interface SettingsMount {
  /** Breadcrumb shown above the title, e.g. "BREAKPOINT // OPTIONS". */
  crumb: string;
  onBack(): void;
}

const percent = (v: number): string => `${Math.round(v * 100)}%`;

export class SettingsPanel {
  readonly el: HTMLElement;
  private readonly rows: Row[] = [];
  private readonly byKey = new Map<keyof GameSettings, Row>();
  private readonly crumb: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly scroller: HTMLElement;
  private index = 0;
  private lastTick = 0;
  private onBack: () => void = () => {};

  constructor(private readonly sound: (kind: UiSound) => void) {
    const head = viewHead('', 'Settings');
    this.crumb = head.querySelector<HTMLElement>('.bp-crumb') ?? h('div');

    const graphics = this.group('Graphics', [
      this.segmented(
        'quality',
        'Graphics quality',
        [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
        'Overall detail preset.',
      ),
      this.slider('resolutionScale', 'Resolution scale', percent, 'Share of the display’s native pixels that is rendered. Lower is faster.'),
      this.segmented(
        'shadows',
        'Shadow quality',
        [
          { value: 'off', label: 'Off' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
        'Shadow detail. Off is the cheapest.',
      ),
      this.slider('renderDistance', 'Render distance', (v) => `${Math.round(v)} m`, 'Geometry beyond this distance is not drawn.'),
      this.toggle('bloom', 'Bloom', 'Glow around bright lights and explosions.'),
      this.toggle('adaptiveQuality', 'Adaptive quality', 'Lowers detail automatically when frames drop.'),
      this.toggle('lowPower', 'Low-power mode', '30 FPS cap and lighter effects for long sessions on fanless machines.'),
      this.segmented(
        'frameLimit',
        'Frame limit / VSync',
        [
          { value: 'display', label: 'Display' },
          { value: '60', label: '60' },
          { value: '30', label: '30' },
        ],
        'Caps the simulation and render rate. Browsers always sync to the display refresh.',
      ),
      this.toggle('showPerf', 'Performance overlay', 'Frame time, physics and memory readout in the corner. F3 toggles it in play.'),
    ]);

    const controls = this.group('Controls', [
      this.slider('fov', 'Field of view', (v) => `${Math.round(v)}°`, 'Vertical field of view in degrees.'),
      this.slider('mouseSensitivity', 'Mouse sensitivity', (v) => `${v.toFixed(2)}×`, 'Look speed multiplier.'),
      this.slider('cameraShake', 'Camera shake', percent, 'Strength of screen shake from impacts and explosions.'),
    ]);

    const audio = this.group('Audio', [this.slider('volume', 'Master volume', percent, 'Overall output level.')]);

    const gameplay = this.group('Gameplay', [
      this.toggle('unlimitedAmmo', 'Unlimited ammo in sandbox', 'Sandbox only. Contracts always use their own loadout.'),
    ]);

    this.scroller = h(
      'div',
      'bp-set__scroll bp-in',
      h('div', 'bp-set__cols', h('div', 'bp-set__col', graphics), h('div', 'bp-set__col', controls, audio, gameplay)),
    );
    this.scroller.style.setProperty('--i', '1');

    this.hint = h('p', 'bp-set__hint');
    this.hint.setAttribute('aria-live', 'polite');

    const reset = this.actionRow('Reset to defaults', 'Restore every setting to its default value.', () => {
      this.sound('click');
      settings.reset();
    });
    const back = this.actionRow('Back', 'Return to the previous menu.', () => this.back());
    back.el.classList.add('bp-btn--back');

    const foot = h('div', 'bp-set__foot bp-in', this.hint, h('div', 'bp-set__actions', reset.el, back.el));
    foot.style.setProperty('--i', '2');

    this.el = h('div', 'bp-set', head, this.scroller, foot);

    this.rows.forEach((row, i) => {
      // Hover takes keyboard focus too, so the highlighted row is always the one keys act on.
      // Ignored while a button is held, so a slider drag that wanders over other rows keeps its row.
      row.el.addEventListener('mouseenter', (e) => {
        if (e.buttons === 0) this.setActive(i, false, 'focus');
      });
      row.focusEl.addEventListener('focus', () => this.setActive(i, false, 'none'));
    });

    settings.subscribe((_values, changed) => {
      if (changed === null) this.syncAll();
      else this.byKey.get(changed)?.sync();
    });
    this.syncAll();
  }

  /** Move the panel into a host screen and focus its first row. */
  mount(host: HTMLElement, opts: SettingsMount): void {
    this.onBack = opts.onBack;
    this.crumb.textContent = opts.crumb;
    if (this.el.parentElement !== host) host.append(this.el);
    this.syncAll();
    this.scroller.scrollTop = 0;
    this.rows[this.index]?.el.classList.remove('is-active');
    this.index = -1;
    this.setActive(0, true, 'reveal');
  }

  handleKey(e: KeyboardEvent): boolean {
    const row = this.rows[this.index];
    if (!row) return false;
    if (e.code === 'Space') {
      // Buttons (switches, reset, back) get Space natively. Sliders and segmented groups are not
      // buttons, so act for them here (and keep Space from scrolling the list).
      if (row.focusEl instanceof HTMLButtonElement) return false;
      if (!e.repeat) row.activate();
      return true;
    }
    const nav = navKey(e);
    if (nav === null) return false;
    switch (nav) {
      case 'up':
        this.move(-1);
        return true;
      case 'down':
        this.move(1);
        return true;
      case 'left':
      case 'right': {
        const dir = nav === 'left' ? -1 : 1;
        if (row.action) {
          const next = this.rows[this.index + dir];
          if (next?.action) this.setActive(this.index + dir, false, 'reveal');
        } else {
          row.adjust(dir);
        }
        return true;
      }
      case 'enter':
        if (!e.repeat) row.activate();
        return true;
      case 'back':
        if (!e.repeat) this.back();
        return true;
    }
  }

  private back(): void {
    this.sound('back');
    this.onBack();
  }

  private move(delta: number): void {
    const n = this.rows.length;
    this.setActive((this.index + delta + n) % n, false, 'reveal');
  }

  /**
   * `focus`: 'none' leaves DOM focus alone (it is already there), 'focus' moves it,
   * 'reveal' moves it and scrolls the row into view (keyboard navigation).
   */
  private setActive(i: number, silent: boolean, focus: 'none' | 'focus' | 'reveal'): void {
    if (i === this.index) return;
    this.rows[this.index]?.el.classList.remove('is-active');
    this.index = i;
    const row = this.rows[i];
    row.el.classList.add('is-active');
    this.hint.textContent = row.hint;
    if (focus !== 'none') focusQuiet(row.focusEl);
    if (focus === 'reveal' && !row.action) this.reveal(row.el);
    if (!silent) this.sound('hover');
  }

  /** Keep the focused row inside the scroll area (only matters in very short windows). */
  private reveal(el: HTMLElement): void {
    const s = this.scroller;
    if (s.scrollHeight <= s.clientHeight) return;
    const box = s.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < box.top) s.scrollTop -= box.top - r.top + 8;
    else if (r.bottom > box.bottom) s.scrollTop += r.bottom - box.bottom + 8;
  }

  private syncAll(): void {
    for (const row of this.rows) row.sync();
  }

  /** Slider drags fire many input events; keep the feedback sound sparse. */
  private tick(): void {
    const now = performance.now();
    if (now - this.lastTick < 70) return;
    this.lastTick = now;
    this.sound('tick');
  }

  private group(title: string, rows: Row[]): HTMLElement {
    const el = h('section', 'bp-set__group', h('h3', 'bp-set__group-title', title));
    for (const row of rows) el.append(row.el);
    return el;
  }

  private register(key: keyof GameSettings, row: Row): Row {
    this.rows.push(row);
    this.byKey.set(key, row);
    return row;
  }

  private slider(key: NumKey, label: string, format: (v: number) => string, hint: string): Row {
    const lim = SETTING_LIMITS[key];
    const span = lim.max - lim.min;

    const input = h('input', 'bp-slider__input');
    input.type = 'range';
    input.min = String(lim.min);
    input.max = String(lim.max);
    input.step = String(lim.step);
    input.setAttribute('aria-label', label);

    const visual = h(
      'div',
      'bp-slider',
      h('div', 'bp-slider__track', h('div', 'bp-slider__fill')),
      h('div', 'bp-slider__thumb'),
      input,
    );
    const value = h('span', 'bp-row__value');
    const el = h('div', 'bp-row bp-row--slider', h('span', 'bp-row__label', label), visual, value);

    const snap = (v: number): number => {
      const stepped = lim.min + Math.round((v - lim.min) / lim.step) * lim.step;
      return Number(Math.min(lim.max, Math.max(lim.min, stepped)).toFixed(4));
    };

    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      const next = snap(v);
      if (next === settings.get(key)) return;
      settings.set(key, next);
      this.tick();
    });

    return this.register(key, {
      el,
      focusEl: input,
      hint,
      action: false,
      sync: () => {
        const v = settings.get(key);
        const text = format(v);
        input.value = String(v);
        input.setAttribute('aria-valuetext', text);
        visual.style.setProperty('--p', String(span > 0 ? Math.min(1, Math.max(0, (v - lim.min) / span)) : 0));
        value.textContent = text;
      },
      adjust: (dir) => {
        const cur = settings.get(key);
        const next = snap(cur + dir * lim.step);
        if (next === cur) return;
        settings.set(key, next);
        this.tick();
      },
      activate: () => {},
    });
  }

  private segmented<K extends EnumKey>(
    key: K,
    label: string,
    options: readonly { value: GameSettings[K]; label: string }[],
    hint: string,
  ): Row {
    const group = h('div', 'bp-seg');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    group.tabIndex = 0;
    group.style.setProperty('--n', String(options.length));
    group.append(h('div', 'bp-seg__ind'));

    const pick = (i: number): void => {
      const opt = options[i];
      if (!opt || settings.get(key) === opt.value) return;
      settings.set(key, opt.value);
      this.sound('click');
    };

    const buttons = options.map((opt, i) => {
      const b = button('bp-seg__opt', opt.label);
      b.setAttribute('role', 'radio');
      b.tabIndex = -1;
      b.addEventListener('click', () => {
        pick(i);
        focusQuiet(group); // keep focus on the group so keys keep acting on the row
      });
      group.append(b);
      return b;
    });

    const value = h('span', 'bp-row__value');
    const el = h('div', 'bp-row bp-row--seg', h('span', 'bp-row__label', label), group, value);
    const current = (): number => Math.max(0, options.findIndex((o) => o.value === settings.get(key)));

    return this.register(key, {
      el,
      focusEl: group,
      hint,
      action: false,
      sync: () => {
        const i = current();
        group.style.setProperty('--at', String(i));
        buttons.forEach((b, n) => {
          b.classList.toggle('is-on', n === i);
          b.setAttribute('aria-checked', n === i ? 'true' : 'false');
        });
        value.textContent = options[i]?.label ?? '';
      },
      adjust: (dir) => pick(current() + dir),
      activate: () => pick((current() + 1) % options.length),
    });
  }

  private toggle(key: BoolKey, label: string, hint: string): Row {
    const sw = button('bp-toggle', h('span', 'bp-toggle__knob'));
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', label);
    const value = h('span', 'bp-row__value');
    const el = h('div', 'bp-row bp-row--toggle', h('span', 'bp-row__label', label), h('div', 'bp-row__control', sw), value);

    const write = (on: boolean): void => {
      if (settings.get(key) === on) return;
      settings.set(key, on);
      this.sound('click');
    };
    // The whole row is the click target, which is friendlier than the small switch alone.
    el.addEventListener('click', () => write(!settings.get(key)));

    return this.register(key, {
      el,
      focusEl: sw,
      hint,
      action: false,
      sync: () => {
        const on = settings.get(key);
        sw.classList.toggle('is-on', on);
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        value.textContent = on ? 'On' : 'Off';
      },
      adjust: (dir) => write(dir > 0),
      activate: () => write(!settings.get(key)),
    });
  }

  private actionRow(label: string, hint: string, run: () => void): Row {
    const btn = button('bp-btn', label);
    btn.addEventListener('click', run);
    const row: Row = { el: btn, focusEl: btn, hint, action: true, sync: () => {}, adjust: () => {}, activate: run };
    this.rows.push(row);
    return row;
  }
}
