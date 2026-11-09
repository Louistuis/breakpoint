/**
 * In-game HUD.
 *
 * Several setters are called every frame, so each one compares against the last value it wrote
 * and only then touches the DOM. Everything that moves is driven by transform / opacity (or a CSS
 * custom property feeding one), animations are restarted by swapping between two identical
 * keyframe names (no forced reflow), and nothing here uses innerHTML or backdrop-filter.
 */
import { TextCell, clamp01, formatClock, formatInt, h, prefersReducedMotion, svg } from './dom';
import { weaponIcon } from './icons';
import type { AmmoHud, CrosshairKind, IHud, ObjectiveHud, PerfHud, WeaponSlotInfo } from './types';

const SELECTOR_IDLE_MS = 2500;
const TOAST_MS = 2600;
const TOAST_OUT_MS = 220;
const TOAST_MAX = 3;
const FLASH_MS = 500;
const FLASH_PEAK = 0.85;
const CRITICAL_SECONDS = 20;

type ToastKind = 'info' | 'warn' | 'success';

interface Toast {
  el: HTMLElement;
  timer: number;
}

interface PerfCells {
  fps: TextCell;
  frame: TextCell;
  worst: TextCell;
  physics: TextCell;
  bodies: TextCell;
  debris: TextCell;
  particles: TextCell;
  draws: TextCell;
  tris: TextCell;
  chunks: TextCell;
  memory: TextCell;
  scale: TextCell;
  quality: TextCell;
  voices: TextCell;
}

export class Hud implements IHud {
  readonly el: HTMLElement;

  // visibility
  private visible = true;

  // crosshair
  private readonly ch: HTMLElement;
  private readonly hit: HTMLElement;
  private chKind: CrosshairKind = 'none';
  private chSpread = 0;
  private hitFlip = false;

  // prompt
  private readonly prompt: HTMLElement;
  private readonly promptKey: TextCell;
  private readonly promptText: TextCell;
  private promptOn = false;

  // weapon selector
  private readonly weapons: HTMLElement;
  private slotEls: HTMLElement[] = [];
  private selected = -1;
  private idleTimer = 0;

  // ammo
  private readonly ammo: HTMLElement;
  private readonly ammoMag: TextCell;
  private readonly ammoRes: TextCell;
  private readonly ammoLabel: TextCell;
  private readonly ammoDetail: TextCell;
  private readonly gaugeFill: HTMLElement;
  private readonly reloadFill: HTMLElement;
  private aMag: number | null | undefined = undefined;
  private aReserve: number | null | undefined = undefined;
  private aDetail: string | null | undefined = undefined;
  private aGauge = -2;
  private aReload = -2;

  // objective
  private readonly meter: HTMLElement;
  private readonly objCode: TextCell;
  private readonly objTitle: TextCell;
  private readonly objTarget: TextCell;
  private readonly objPct: TextCell;
  private readonly objReq: TextCell;
  private readonly objTime: TextCell;
  private readonly objScore: TextCell;
  private readonly objExpl: TextCell;
  private objOn = false;
  private oProgress = -1;
  private oRequired = -1;
  private oSeconds = -1;
  private oScore = Number.NaN;
  private oExpl = -1;
  private oComplete = false;
  private oCritical = false;

  // mode label
  private readonly mode: TextCell;

  // performance overlay
  private readonly perf: HTMLElement;
  private readonly perfCells: PerfCells;
  private perfOn = false;
  private perfLevel = '';

  // toasts
  private readonly toastHost: HTMLElement;
  private toasts: Toast[] = [];

  // flash
  private readonly flashEl: HTMLElement;
  private flashFlip = false;
  private flashPeak = 0;
  private flashAt = 0;

  constructor() {
    // ---- crosshair ----------------------------------------------------------------------------
    this.hit = h('div', 'bp-hit', h('i'), h('i'), h('i'), h('i'));
    this.ch = h(
      'div',
      'bp-ch',
      h('i', 'bp-ch__dot'),
      h('i', 'bp-ch__tick bp-ch__tick--t'),
      h('i', 'bp-ch__tick bp-ch__tick--r'),
      h('i', 'bp-ch__tick bp-ch__tick--b'),
      h('i', 'bp-ch__tick bp-ch__tick--l'),
      svg('-1 -1 2 2', '<circle class="bp-ch__ring-o" r="8"/><circle class="bp-ch__ring-i" r="8"/>', 'bp-ch__ring'),
      this.hit,
    );
    this.ch.dataset.kind = 'none';

    // ---- interaction prompt -------------------------------------------------------------------
    const promptKey = h('kbd', 'bp-key bp-prompt__key');
    const promptText = h('span', 'bp-prompt__text');
    this.promptKey = new TextCell(promptKey);
    this.promptText = new TextCell(promptText);
    this.prompt = h('div', 'bp-prompt', promptKey, promptText);

    // ---- objective ----------------------------------------------------------------------------
    const cell = (className: string): TextCell => new TextCell(h('span', className));
    this.objCode = cell('bp-code bp-obj__code');
    this.objTitle = cell('bp-obj__title');
    this.objTarget = new TextCell(h('div', 'bp-obj__target'));
    this.objPct = cell('bp-obj__pct');
    this.objReq = cell('bp-obj__req');
    this.objTime = cell('bp-obj__time');
    this.objScore = cell('bp-obj__v');
    this.objExpl = cell('bp-obj__v');
    this.meter = h('div', 'bp-meter', h('div', 'bp-meter__fill'), h('div', 'bp-meter__mark'));
    const objective = h(
      'div',
      'bp-obj',
      h('div', 'bp-obj__head', this.objCode.el, this.objTitle.el),
      this.objTarget.el,
      this.meter,
      h('div', 'bp-obj__legend', this.objPct.el, this.objReq.el),
      h(
        'div',
        'bp-obj__foot',
        this.objTime.el,
        h('span', 'bp-obj__stat', h('span', 'bp-obj__k', 'Score'), this.objScore.el),
        h('span', 'bp-obj__stat', h('span', 'bp-obj__k', 'Explosives'), this.objExpl.el),
      ),
    );

    // ---- mode label ---------------------------------------------------------------------------
    this.mode = new TextCell(h('div', 'bp-mode'));

    // ---- performance overlay ------------------------------------------------------------------
    this.perf = h('div', 'bp-perf');
    const perfRow = (label: string): TextCell => {
      const v = h('span', 'bp-perf__v');
      this.perf.append(h('span', 'bp-perf__k', label), v);
      return new TextCell(v);
    };
    this.perfCells = {
      fps: perfRow('FPS'),
      frame: perfRow('Frame'),
      worst: perfRow('Worst'),
      physics: perfRow('Physics'),
      bodies: perfRow('Bodies'),
      debris: perfRow('Debris'),
      particles: perfRow('Particles'),
      draws: perfRow('Draws'),
      tris: perfRow('Tris'),
      chunks: perfRow('Chunks'),
      memory: perfRow('Memory'),
      scale: perfRow('Scale'),
      quality: perfRow('Quality'),
      voices: perfRow('Voices'),
    };
    this.perfCells.fps.el.classList.add('bp-perf__fps');

    // ---- toasts -------------------------------------------------------------------------------
    this.toastHost = h('div', 'bp-toasts');
    this.toastHost.setAttribute('aria-live', 'polite');

    // ---- weapon selector ----------------------------------------------------------------------
    this.weapons = h('div', 'bp-wpn');

    // ---- ammo ---------------------------------------------------------------------------------
    this.ammoDetail = new TextCell(h('div', 'bp-ammo__detail'));
    this.ammoMag = cell('bp-ammo__mag');
    this.ammoRes = cell('bp-ammo__res');
    this.ammoLabel = new TextCell(h('div', 'bp-ammo__label'));
    this.gaugeFill = h('i');
    this.reloadFill = h('i');
    this.ammo = h(
      'div',
      'bp-ammo',
      this.ammoDetail.el,
      h('div', 'bp-ammo__nums', this.ammoMag.el, this.ammoRes.el),
      h('div', 'bp-ammo__bar bp-ammo__reload', this.reloadFill),
      this.ammoLabel.el,
      h('div', 'bp-ammo__bar bp-ammo__gauge', this.gaugeFill),
    );

    // ---- flash --------------------------------------------------------------------------------
    this.flashEl = h('div', 'bp-flash');
    this.flashEl.addEventListener('animationend', () => {
      this.flashEl.className = 'bp-flash';
      this.flashPeak = 0;
    });

    this.el = h(
      'div',
      'bp-hud',
      this.flashEl,
      this.ch,
      this.prompt,
      objective,
      this.mode.el,
      this.perf,
      this.toastHost,
      this.weapons,
      this.ammo,
    );
    this.el.setAttribute('aria-hidden', 'true');
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.el.classList.toggle('is-hidden', !visible);
  }

  // ---- weapon selector ------------------------------------------------------------------------

  setWeapons(slots: WeaponSlotInfo[]): void {
    const rail = h('div', 'bp-wpn__rail');
    this.slotEls = slots.map((slot) => {
      const el = h(
        'div',
        'bp-wpn__slot',
        h('span', 'bp-wpn__key', String(slot.key)),
        weaponIcon(slot.id, 'bp-ico bp-wpn__icon'),
        h('span', 'bp-wpn__name', slot.name),
      );
      rail.append(el);
      return el;
    });
    rail.append(h('div', 'bp-wpn__line'));
    this.weapons.replaceChildren(rail);
    if (this.selected >= slots.length) this.selected = -1;
    this.paintSelection();
    this.wakeSelector();
  }

  selectWeapon(index: number): void {
    if (index !== this.selected) {
      this.selected = index;
      this.paintSelection();
    }
    this.wakeSelector();
  }

  private paintSelection(): void {
    const i = this.selected;
    for (let k = 0; k < this.slotEls.length; k++) this.slotEls[k].classList.toggle('is-active', k === i);
    const valid = i >= 0 && i < this.slotEls.length;
    this.weapons.classList.toggle('has-selection', valid);
    if (valid) this.weapons.style.setProperty('--bp-wpn-i', String(i));
  }

  /** Bring the selector to full presence, then let it settle into its compact state. */
  private wakeSelector(): void {
    this.weapons.classList.remove('is-idle');
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.weapons.classList.add('is-idle'), SELECTOR_IDLE_MS);
  }

  // ---- ammo -----------------------------------------------------------------------------------

  setAmmo(ammo: AmmoHud): void {
    if (ammo.mag !== this.aMag) {
      this.aMag = ammo.mag;
      this.ammo.classList.toggle('is-melee', ammo.mag === null);
      this.ammo.classList.toggle('is-empty', ammo.mag === 0);
      if (ammo.mag !== null) this.ammoMag.set(String(Math.max(0, Math.round(ammo.mag))));
    }

    if (ammo.reserve !== this.aReserve) {
      this.aReserve = ammo.reserve;
      this.ammo.classList.toggle('has-reserve', ammo.reserve !== null);
      if (ammo.reserve !== null) {
        this.ammoRes.set(ammo.reserve === Infinity ? '∞' : String(Math.max(0, Math.round(ammo.reserve))));
      }
    }

    this.ammoLabel.set(ammo.label);

    if (ammo.detail !== this.aDetail) {
      this.aDetail = ammo.detail;
      this.ammo.classList.toggle('has-detail', ammo.detail !== null && ammo.detail !== '');
      if (ammo.detail !== null) this.ammoDetail.set(ammo.detail);
    }

    // Bars are quantised to half a percent so sub-pixel changes do not reach the DOM.
    const gauge = ammo.gauge === null ? -1 : Math.round(clamp01(ammo.gauge) * 200) / 200;
    if (gauge !== this.aGauge) {
      const shown = gauge >= 0;
      const wasShown = this.aGauge >= 0;
      if (shown !== wasShown) this.ammo.classList.toggle('has-gauge', shown);
      const low = shown && gauge < 0.15;
      const wasLow = wasShown && this.aGauge < 0.15;
      if (low !== wasLow) this.ammo.classList.toggle('is-low', low);
      this.aGauge = gauge;
      if (shown) this.gaugeFill.style.transform = `scaleX(${gauge})`;
    }

    const reload = ammo.reloading ? Math.round(clamp01(ammo.reloadProgress) * 200) / 200 : -1;
    if (reload !== this.aReload) {
      const reloading = reload >= 0;
      if (reloading !== this.aReload >= 0) this.ammo.classList.toggle('is-reloading', reloading);
      this.aReload = reload;
      if (reloading) this.reloadFill.style.transform = `scaleX(${reload})`;
    }
  }

  // ---- prompt ---------------------------------------------------------------------------------

  setPrompt(prompt: { key: string; text: string } | null): void {
    if (prompt === null) {
      if (this.promptOn) {
        this.promptOn = false;
        this.prompt.classList.remove('is-on');
      }
      return;
    }
    this.promptKey.set(prompt.key);
    this.promptText.set(prompt.text);
    if (!this.promptOn) {
      this.promptOn = true;
      this.prompt.classList.add('is-on');
    }
  }

  // ---- crosshair ------------------------------------------------------------------------------

  setCrosshair(kind: CrosshairKind, spread: number): void {
    if (kind !== this.chKind) {
      this.chKind = kind;
      this.ch.dataset.kind = kind;
    }
    // Half-pixel steps: finer changes are invisible and would only cost style work.
    const s = spread > 0 ? Math.round(spread * 2) / 2 : 0;
    if (s !== this.chSpread) {
      this.chSpread = s;
      this.ch.style.setProperty('--bp-ch-spread', `${s}px`);
    }
  }

  hitMarker(strength: number): void {
    const s = clamp01(strength);
    this.hit.style.setProperty('--bp-hit-scale', (0.8 + s * 0.6).toFixed(2));
    this.hit.style.setProperty('--bp-hit-peak', (0.6 + s * 0.4).toFixed(2));
    this.hitFlip = !this.hitFlip;
    this.hit.className = this.hitFlip ? 'bp-hit is-a' : 'bp-hit is-b';
  }

  // ---- objective ------------------------------------------------------------------------------

  setObjective(o: ObjectiveHud | null): void {
    if (o === null) {
      if (this.objOn) {
        this.objOn = false;
        this.el.classList.remove('has-objective');
      }
      return;
    }
    if (!this.objOn) {
      this.objOn = true;
      this.el.classList.add('has-objective');
    }

    this.objCode.set(o.code);
    this.objTitle.set(o.title);
    this.objTarget.set(o.targetName);

    const progress = Math.round(clamp01(o.progress) * 1000);
    if (progress !== this.oProgress) {
      this.oProgress = progress;
      this.meter.style.setProperty('--v', String(progress / 1000));
      this.objPct.set(`${Math.floor(progress / 10)}% destroyed`);
    }

    const required = Math.round(clamp01(o.required) * 1000);
    if (required !== this.oRequired) {
      this.oRequired = required;
      this.meter.style.setProperty('--req', String(required / 1000));
      this.objReq.set(`Required ${Math.round(required / 10)}%`);
    }

    const complete = progress >= required;
    if (complete !== this.oComplete) {
      this.oComplete = complete;
      this.meter.classList.toggle('is-complete', complete);
      this.objPct.el.classList.toggle('is-complete', complete);
    }

    const seconds = o.timeLeft > 0 ? Math.ceil(o.timeLeft) : 0;
    if (seconds !== this.oSeconds) {
      this.oSeconds = seconds;
      this.objTime.set(formatClock(seconds));
      // The clock shows whole seconds rounded up, so "0:20" is the first frame under 20 s.
      const critical = seconds <= CRITICAL_SECONDS;
      if (critical !== this.oCritical) {
        this.oCritical = critical;
        this.objTime.el.classList.toggle('is-critical', critical);
      }
    }

    const score = Math.round(o.score);
    if (score !== this.oScore) {
      this.oScore = score;
      this.objScore.set(formatInt(score));
    }

    if (o.explosivesUsed !== this.oExpl) {
      this.oExpl = o.explosivesUsed;
      this.objExpl.set(String(o.explosivesUsed));
    }
  }

  setModeLabel(text: string): void {
    this.mode.set(text);
  }

  // ---- performance overlay --------------------------------------------------------------------

  setPerf(p: PerfHud | null): void {
    if (p === null) {
      if (this.perfOn) {
        this.perfOn = false;
        this.perf.classList.remove('is-on');
      }
      return;
    }
    if (!this.perfOn) {
      this.perfOn = true;
      this.perf.classList.add('is-on');
    }

    const c = this.perfCells;
    c.fps.set(String(Math.round(p.fps)));
    const level = p.fps >= 55 ? 'good' : p.fps >= 40 ? 'warn' : 'bad';
    if (level !== this.perfLevel) {
      this.perfLevel = level;
      c.fps.el.dataset.level = level;
    }
    c.frame.set(`${p.frameMs.toFixed(1)} ms`);
    c.worst.set(`${p.worstMs.toFixed(1)} ms`);
    c.physics.set(`${p.physicsMs.toFixed(1)} ms`);
    c.bodies.set(`${p.awakeBodies} / ${p.bodies}`);
    c.debris.set(String(p.debris));
    c.particles.set(String(p.particles));
    c.draws.set(String(p.drawCalls));
    c.tris.set(`${(p.triangles / 1000).toFixed(1)}k`);
    c.chunks.set(String(p.chunks));
    c.memory.set(p.memoryMb === null ? 'n/a' : `${Math.round(p.memoryMb)} MB`);
    c.scale.set(`${Math.round(p.renderScale * 100)}%`);
    c.quality.set(p.qualityLevel <= 0 ? 'L0 full' : `L${p.qualityLevel}`);
    c.voices.set(String(p.voices));
  }

  // ---- toasts ---------------------------------------------------------------------------------

  toast(text: string, kind: ToastKind = 'info'): void {
    while (this.toasts.length >= TOAST_MAX) this.dropToast(this.toasts[0], true);
    const el = h('div', `bp-toast bp-toast--${kind}`, text);
    const toast: Toast = { el, timer: 0 };
    toast.timer = window.setTimeout(() => this.dropToast(toast, false), TOAST_MS);
    this.toasts.push(toast);
    this.toastHost.append(el);
  }

  private dropToast(toast: Toast, immediately: boolean): void {
    const i = this.toasts.indexOf(toast);
    if (i < 0) return;
    this.toasts.splice(i, 1);
    window.clearTimeout(toast.timer);
    if (immediately) {
      toast.el.remove();
      return;
    }
    toast.el.classList.add('is-out');
    window.setTimeout(() => toast.el.remove(), TOAST_OUT_MS);
  }

  // ---- flash ----------------------------------------------------------------------------------

  flash(intensity: number): void {
    let peak = clamp01(intensity) * FLASH_PEAK;
    if (prefersReducedMotion()) peak *= 0.35;
    if (peak < 0.01) return;

    // Estimate what is left of the flash already on screen and never step down to a weaker one.
    const now = performance.now();
    const left = 1 - (now - this.flashAt) / FLASH_MS;
    const remaining = left > 0 ? this.flashPeak * left * left : 0;
    if (peak <= remaining) return;

    this.flashPeak = peak;
    this.flashAt = now;
    this.flashEl.style.setProperty('--bp-flash', peak.toFixed(3));
    this.flashFlip = !this.flashFlip;
    this.flashEl.className = this.flashFlip ? 'bp-flash is-a' : 'bp-flash is-b';
  }
}
