/**
 * Main menu: a left-aligned column over the live fly-over of the district.
 * Views: root list, contract selection, settings (shared panel), controls reference, about.
 */
import { REPO_URL, VERSION } from '../utils/links';
import type { UiSound } from '../audio/types';
import type { ChallengeDef, GameMode } from '../gameplay/challenges';
import { button, createGate, focusQuiet, formatClock, formatInt, formatPercent, h, navKey } from './dom';
import { MenuList, type MenuItemDef } from './MenuList';
import type { SettingsPanel } from './Settings';
import type { UICallbacks } from './types';
import { createWordmark, keyCap, keyHints, setKeyHints, viewHead, type Hint } from './widgets';

/** External link to the public repository (opens in a new tab, never steals the game's focus). */
function repoLink(label: string): HTMLAnchorElement {
  const a = h('a', 'bp-repo', label, h('span', 'bp-repo__arrow', ' \u2197'));
  a.href = REPO_URL;
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = 'Open the BREAKPOINT source code on GitHub';
  return a;
}

type View = 'root' | 'contracts' | 'settings' | 'controls' | 'about';
const VIEWS: readonly View[] = ['root', 'contracts', 'settings', 'controls', 'about'];

const HINTS: Record<View, readonly Hint[]> = {
  root: [
    ['W S', 'Navigate'],
    ['Enter', 'Select'],
  ],
  contracts: [
    ['A D', 'Browse'],
    ['Enter', 'Accept'],
    ['Esc', 'Back'],
  ],
  settings: [
    ['W S', 'Navigate'],
    ['A D', 'Adjust'],
    ['Esc', 'Back'],
  ],
  controls: [['Esc', 'Back']],
  about: [['Esc', 'Back']],
};

interface ControlDef {
  keys: string[];
  /** Text between the key caps, e.g. "or". */
  join?: string;
  action: string;
  note?: string;
}

const CONTROLS: readonly ControlDef[] = [
  { keys: ['W', 'A', 'S', 'D'], action: 'Move' },
  { keys: ['Mouse'], action: 'Look' },
  { keys: ['Space'], action: 'Jump' },
  { keys: ['Shift'], action: 'Sprint' },
  { keys: ['Ctrl', 'C'], join: 'or', action: 'Crouch' },
  { keys: ['E'], action: 'Interact / grab / drop' },
  { keys: ['R'], action: 'Reload', note: 'With charges selected: cycle detonation mode' },
  { keys: ['1', '6'], join: '–', action: 'Select tool' },
  { keys: ['Mouse wheel'], action: 'Cycle tools' },
  { keys: ['Q'], action: 'Previous tool' },
  { keys: ['Left click'], action: 'Use tool', note: 'Throws a held object' },
  { keys: ['Right click'], action: 'Aim / detonate charges' },
  { keys: ['F'], action: 'Enter or exit vehicle' },
  { keys: ['F3'], action: 'Performance overlay' },
  { keys: ['Esc'], action: 'Pause' },
];

const ABOUT: readonly string[] = [
  'BREAKPOINT is a browser-native, fully destructible voxel sandbox. Every wall, beam and slab is real voxel geometry, so anything you can see you can cut, crack or blow apart.',
  'Collapse is simulated, not scripted. Take away what holds a structure up and the unsupported sections break free as rigid-body debris that falls, tumbles and breaks again.',
  'Built with Three.js and Rapier in TypeScript. All art and audio are procedural: nothing is loaded but the code.',
];

const ABOUT_SPECS: readonly (readonly [string, string])[] = [
  ['Renderer', 'Three.js'],
  ['Physics', 'Rapier'],
  ['Language', 'TypeScript'],
  ['Art / audio', 'Procedural'],
];

interface Card {
  def: ChallengeDef;
  el: HTMLButtonElement;
  best: HTMLElement;
}

function readBest(id: string): number | null {
  try {
    const raw = localStorage.getItem(`breakpoint.best.${id}`);
    if (raw === null || raw.trim() === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function spec(key: string, value: string | HTMLElement): HTMLElement {
  const v = typeof value === 'string' ? h('span', 'bp-spec__v', value) : value;
  return h('span', 'bp-spec', h('span', 'bp-spec__k', key), v);
}

export class MainMenu {
  readonly el: HTMLElement;
  private view: View = 'root';
  private readonly views: Record<View, HTMLElement>;
  private readonly list: MenuList;
  private readonly desc: HTMLElement;
  private readonly hints: HTMLElement;
  private readonly cards: Card[] = [];
  private readonly contractsBack: HTMLButtonElement;
  private readonly controlsBack: HTMLButtonElement;
  private readonly aboutBack: HTMLButtonElement;
  /** Focus inside the contract view: 0..n-1 = card, n = BACK. */
  private focusIdx = 0;
  private lastCard = 0;
  private readonly startGate = createGate(1200);
  private readonly sound: (kind: UiSound) => void;

  constructor(
    private readonly cb: UICallbacks,
    challenges: ChallengeDef[],
    private readonly settingsPanel: SettingsPanel,
  ) {
    this.sound = (kind) => cb.onUiSound(kind);

    // ---- root -------------------------------------------------------------------------------
    this.desc = h('p', 'bp-desc bp-in');
    this.desc.style.setProperty('--i', '8');
    this.desc.setAttribute('aria-live', 'polite');

    this.list = new MenuList(this.sound, (item) => {
      this.desc.textContent = item.hint;
    });
    const items: MenuItemDef[] = [
      {
        id: 'play',
        label: 'Play',
        hint: 'Timed demolition contracts: one target, one loadout, one clock.',
        onSelect: () => this.show('contracts'),
      },
      {
        id: 'sandbox',
        label: 'Sandbox',
        hint: 'The whole district, every tool, no clock.',
        sound: 'start',
        onSelect: () => this.start('sandbox'),
      },
      {
        id: 'settings',
        label: 'Settings',
        hint: 'Graphics, controls, audio and gameplay options.',
        onSelect: () => this.show('settings'),
      },
      {
        id: 'controls',
        label: 'Controls',
        hint: 'Keyboard and mouse reference.',
        onSelect: () => this.show('controls'),
      },
      {
        id: 'about',
        label: 'About',
        hint: 'What BREAKPOINT is and how it is built.',
        onSelect: () => this.show('about'),
      },
    ];
    this.list.setItems(items);

    const wordmark = h('div', 'bp-in', createWordmark('hero'));
    const tagline = h('p', 'bp-tagline bp-in', 'Every structure has one');
    tagline.style.setProperty('--i', '1');
    const root = h('section', 'bp-view bp-view--root', wordmark, tagline, this.list.el, this.desc);

    // ---- contracts --------------------------------------------------------------------------
    const cardRow = h('div', 'bp-cards');
    challenges.forEach((def, i) => {
      const card = this.buildCard(def, i);
      this.cards.push(card);
      cardRow.append(card.el);
    });
    if (challenges.length === 0) cardRow.append(h('p', 'bp-sub', 'No contracts are open right now.'));

    this.contractsBack = this.backButton(() => this.goRoot());
    this.contractsBack.addEventListener('mouseenter', () => this.focusContract(this.cards.length, false, true));
    this.contractsBack.addEventListener('focus', () => this.focusContract(this.cards.length, false, false));
    const count = challenges.length;
    const contracts = h(
      'section',
      'bp-view bp-view--sub bp-view--contracts',
      viewHead(
        'Breakpoint // Contracts',
        'Select contract',
        `${count} open ${count === 1 ? 'contract' : 'contracts'}. Destroy the required share of the target before the clock runs out.`,
      ),
      cardRow,
      this.contractsBack,
    );

    // ---- settings (panel is mounted on demand) ----------------------------------------------
    const settingsView = h('section', 'bp-view bp-view--sub bp-view--settings');

    // ---- controls ---------------------------------------------------------------------------
    const perColumn = Math.ceil(CONTROLS.length / 2);
    const columns = [h('div', 'bp-ctl__col'), h('div', 'bp-ctl__col')];
    CONTROLS.forEach((c, n) => {
      const keys = h('span', 'bp-ctl__keys');
      c.keys.forEach((k, i) => {
        if (i > 0 && c.join) keys.append(h('span', 'bp-ctl__join', c.join));
        keys.append(keyCap(k));
      });
      columns[n < perColumn ? 0 : 1].append(
        h(
          'div',
          'bp-ctl__row',
          keys,
          h('span', 'bp-ctl__action', c.action, c.note ? h('span', 'bp-ctl__note', c.note) : null),
        ),
      );
    });
    const table = h('div', 'bp-ctl bp-in', ...columns);
    table.style.setProperty('--i', '1');
    this.controlsBack = this.backButton(() => this.goRoot());
    this.controlsBack.classList.add('is-active');
    const controls = h(
      'section',
      'bp-view bp-view--sub bp-view--controls',
      viewHead('Breakpoint // Controls', 'Controls'),
      table,
      this.controlsBack,
    );

    // ---- about ------------------------------------------------------------------------------
    const copy = h('div', 'bp-about__copy', ...ABOUT.map((text) => h('p', null, text)));
    const specs = h(
      'dl',
      'bp-about__specs',
      ...ABOUT_SPECS.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
      h('dt', null, 'Version'),
      h('dd', 'bp-about__ver', VERSION),
      h('dt', null, 'Source'),
      h('dd', null, repoLink('github.com/Louistuis/breakpoint')),
    );
    const aboutBody = h('div', 'bp-about bp-in', copy, specs);
    aboutBody.style.setProperty('--i', '1');
    this.aboutBack = this.backButton(() => this.goRoot());
    this.aboutBack.classList.add('is-active');
    const about = h(
      'section',
      'bp-view bp-view--sub bp-view--about',
      viewHead('Breakpoint // About', 'About'),
      aboutBody,
      this.aboutBack,
    );

    this.views = { root, contracts, settings: settingsView, controls, about };

    // ---- frame ------------------------------------------------------------------------------
    this.hints = keyHints(HINTS.root);
    const top = h(
      'div',
      'bp-menu__top',
      h('span', 'bp-mono bp-menu__unit', 'Unit 07 // Demolition contracts // Site open'),
      h('span', 'bp-mono bp-cam', h('i', 'bp-cam__dot'), 'Site cam 03 · Live'),
    );
    const foot = h('div', 'bp-foot', this.hints, h('span', 'bp-mono bp-foot__meta', `${VERSION} · `, repoLink('Source on GitHub')));

    this.el = h(
      'div',
      'bp-screen bp-menu',
      h('div', 'bp-menu__scrim'),
      h('div', 'bp-menu__scrim bp-menu__scrim--wide'),
      top,
      root,
      contracts,
      settingsView,
      controls,
      about,
      foot,
    );
    this.el.dataset.view = 'root';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Main menu');
  }

  open(): void {
    this.el.classList.add('is-open');
    this.show('root');
    this.list.focus(0);
  }

  close(): void {
    this.el.classList.remove('is-open');
  }

  /**
   * Play the entrance again. Used when the loading screen lifts off a menu that was opened
   * underneath it, so the stagger and the wordmark cut are actually seen. One reflow, menu only.
   */
  replayEntrance(): void {
    if (!this.el.classList.contains('is-open')) return;
    this.el.classList.remove('is-open');
    void this.el.offsetWidth;
    this.el.classList.add('is-open');
    if (this.view === 'root') this.list.focus();
  }

  handleKey(e: KeyboardEvent): boolean {
    switch (this.view) {
      case 'root':
        return this.list.handleKey(e);
      case 'settings':
        return this.settingsPanel.handleKey(e);
      case 'contracts':
        return this.contractsKey(e);
      default: {
        const nav = navKey(e);
        if (nav === 'enter' || nav === 'back') {
          if (!e.repeat) this.goRoot();
          return true;
        }
        return false;
      }
    }
  }

  private show(view: View): void {
    this.view = view;
    this.el.dataset.view = view;
    for (const v of VIEWS) this.views[v].classList.toggle('is-current', v === view);
    setKeyHints(this.hints, HINTS[view]);

    switch (view) {
      case 'root':
        this.list.focus();
        break;
      case 'contracts': {
        for (const card of this.cards) {
          const best = readBest(card.def.id);
          card.best.textContent = best === null ? '—' : formatInt(best);
        }
        const n = this.cards.length;
        this.focusContract(n === 0 ? 0 : Math.min(this.lastCard, n - 1), true, true);
        break;
      }
      case 'settings':
        this.settingsPanel.mount(this.views.settings, {
          crumb: 'Breakpoint // Settings',
          onBack: () => this.show('root'),
        });
        break;
      case 'controls':
        focusQuiet(this.controlsBack);
        break;
      case 'about':
        focusQuiet(this.aboutBack);
        break;
    }
  }

  private goRoot(): void {
    this.sound('back');
    this.show('root');
  }

  private start(mode: GameMode, challengeId?: string): void {
    if (!this.startGate()) return;
    this.cb.onStart(mode, challengeId);
  }

  private backButton(onClick: () => void): HTMLButtonElement {
    const b = button('bp-btn bp-btn--back bp-in', 'Back');
    b.style.setProperty('--i', '3');
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- contract selection -------------------------------------------------------------------

  private buildCard(def: ChallengeDef, i: number): Card {
    const pips = h('span', 'bp-pips');
    pips.setAttribute('role', 'img');
    pips.setAttribute('aria-label', `Difficulty ${def.difficulty} of 3`);
    for (let p = 1; p <= 3; p++) pips.append(h('i', p <= def.difficulty ? 'is-on' : null));

    const best = h('span', 'bp-spec__v bp-spec__v--mono', '—');
    const load = (label: string, amount: number | null): HTMLElement =>
      h('span', 'bp-load', h('b', null, amount === null ? '∞' : String(amount)), label);

    const el = button(
      'bp-card bp-in',
      h('span', 'bp-card__stripe'),
      h('span', 'bp-card__head', h('span', 'bp-code', def.code), h('span', 'bp-card__diff', 'Difficulty', pips)),
      h('span', 'bp-card__title', def.title),
      h('span', 'bp-card__brief', def.brief),
      h(
        'span',
        'bp-card__specs',
        spec('Target', def.targetName),
        spec('Time limit', h('span', 'bp-spec__v bp-spec__v--mono', formatClock(def.timeLimit))),
        spec('Required', h('span', 'bp-spec__v bp-spec__v--mono', formatPercent(def.targetFraction))),
        spec('Best score', best),
      ),
      h(
        'span',
        'bp-card__loadout',
        load('Charges', def.loadout.charges),
        load('Rockets', def.loadout.rockets),
        load('Shells', def.loadout.shells),
        load('Rounds', def.loadout.rounds),
      ),
      h('span', 'bp-card__cta', 'Accept contract', h('span', 'bp-card__go', '→')),
    );
    el.style.setProperty('--i', String(i + 1));
    el.setAttribute('aria-label', `${def.code} ${def.title}. Accept contract.`);

    // Hover also takes keyboard focus so the highlighted card is always the one Enter / Space acts on.
    el.addEventListener('mouseenter', () => this.focusContract(i, false, true));
    el.addEventListener('focus', () => this.focusContract(i, false, false));
    el.addEventListener('click', () => {
      this.focusContract(i, true, false);
      this.acceptContract();
    });
    return { def, el, best };
  }

  private focusContract(i: number, silent: boolean, moveFocus: boolean): void {
    const n = this.cards.length;
    const changed = i !== this.focusIdx;
    this.focusIdx = i;
    if (i < n) this.lastCard = i;
    this.cards.forEach((c, k) => c.el.classList.toggle('is-active', k === i));
    this.contractsBack.classList.toggle('is-active', i >= n);
    if (moveFocus) focusQuiet(i < n ? this.cards[i].el : this.contractsBack);
    if (changed && !silent) this.sound('hover');
  }

  private acceptContract(): void {
    const card = this.cards[this.focusIdx];
    if (!card) {
      this.goRoot();
      return;
    }
    this.sound('start');
    this.start('challenge', card.def.id);
  }

  private contractsKey(e: KeyboardEvent): boolean {
    const nav = navKey(e);
    if (nav === null) return false;
    const n = this.cards.length;
    const onBack = this.focusIdx >= n;
    switch (nav) {
      case 'left':
        if (!onBack && n > 1) this.focusContract((this.focusIdx - 1 + n) % n, false, true);
        return true;
      case 'right':
        if (!onBack && n > 1) this.focusContract((this.focusIdx + 1) % n, false, true);
        return true;
      case 'down':
        if (!onBack) this.focusContract(n, false, true);
        return true;
      case 'up':
        if (onBack && n > 0) this.focusContract(this.lastCard, false, true);
        return true;
      case 'enter':
        if (!e.repeat) this.acceptContract();
        return true;
      case 'back':
        if (!e.repeat) this.goRoot();
        return true;
    }
  }
}
