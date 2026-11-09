/**
 * Pause menu over a dark, lightly blurred scrim.
 *
 * Escape is NOT bound to resume here: the browser releases pointer lock on Escape and will not
 * re-lock from the same key press, so the game owns that key. The only thing Escape does in this
 * screen is step back from the settings sub-panel to the pause root.
 */
import type { UiSound } from '../audio/types';
import type { GameMode } from '../gameplay/challenges';
import { createGate, h } from './dom';
import { MenuList, type MenuItemDef } from './MenuList';
import type { SettingsPanel } from './Settings';
import type { UICallbacks } from './types';
import { keyHints, setKeyHints, type Hint } from './widgets';

type View = 'root' | 'settings';

const HINTS: Record<View, readonly Hint[]> = {
  root: [
    ['W S', 'Navigate'],
    ['Enter', 'Select'],
  ],
  settings: [
    ['W S', 'Navigate'],
    ['A D', 'Adjust'],
    ['Esc', 'Back'],
  ],
};

export class PauseMenu {
  readonly el: HTMLElement;
  private view: View = 'root';
  private readonly list: MenuList;
  private readonly tag: HTMLElement;
  private readonly desc: HTMLElement;
  private readonly hints: HTMLElement;
  private readonly rootView: HTMLElement;
  private readonly settingsView: HTMLElement;
  private readonly gate = createGate(700);
  private readonly sound: (kind: UiSound) => void;

  constructor(
    private readonly cb: UICallbacks,
    private readonly settingsPanel: SettingsPanel,
  ) {
    this.sound = (kind) => cb.onUiSound(kind);

    this.tag = h('div', 'bp-mono bp-pause__tag bp-in');
    const title = h('h2', 'bp-title bp-pause__title bp-in', 'Paused');
    title.style.setProperty('--i', '1');
    const stripe = h('div', 'bp-stripe bp-in');
    stripe.style.setProperty('--i', '1');

    this.desc = h('p', 'bp-desc bp-in');
    this.desc.style.setProperty('--i', '7');
    this.desc.setAttribute('aria-live', 'polite');

    this.list = new MenuList(this.sound, (item) => {
      this.desc.textContent = item.hint;
    });

    this.rootView = h('section', 'bp-view bp-view--root bp-pause__root', this.tag, title, stripe, this.list.el, this.desc);
    this.settingsView = h('section', 'bp-view bp-view--sub bp-view--settings');
    this.hints = keyHints(HINTS.root);

    this.el = h(
      'div',
      'bp-screen bp-pause',
      h('div', 'bp-scrim'),
      this.rootView,
      this.settingsView,
      h('div', 'bp-foot', this.hints),
    );
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Paused');
  }

  open(mode: GameMode): void {
    const challenge = mode === 'challenge';
    this.tag.textContent = challenge ? 'Contract // Clock stopped' : 'Sandbox // Simulation held';

    const items: MenuItemDef[] = [
      {
        id: 'resume',
        label: 'Resume',
        hint: challenge ? 'Back to the contract. The clock starts again.' : 'Back to the site.',
        onSelect: () => this.fire(() => this.cb.onResume()),
      },
      {
        id: 'restart',
        label: challenge ? 'Restart contract' : 'Restart environment',
        hint: challenge
          ? 'Rebuild the target and start the contract from zero.'
          : 'Rebuild the district exactly as it was at the start.',
        confirm: {
          ask: challenge ? 'Discard this run?' : 'Undo all damage?',
          yes: 'Restart',
          no: 'Cancel',
        },
        sound: 'start',
        onSelect: () => this.fire(() => this.cb.onRestart()),
      },
      {
        id: 'settings',
        label: 'Settings',
        hint: 'Graphics, controls, audio and gameplay options.',
        onSelect: () => this.show('settings'),
      },
      {
        id: 'quit',
        label: 'Return to main menu',
        hint: challenge ? 'Abandon the contract and leave the site.' : 'Leave the site. The district is not saved.',
        confirm: {
          ask: challenge ? 'Abandon the contract?' : 'Leave the site?',
          yes: 'Leave',
          no: 'Stay',
        },
        sound: 'back',
        onSelect: () => this.fire(() => this.cb.onQuitToMenu()),
      },
    ];
    this.list.setItems(items);

    this.el.classList.add('is-open');
    this.show('root');
    this.list.focus(0);
  }

  close(): void {
    this.el.classList.remove('is-open');
  }

  handleKey(e: KeyboardEvent): boolean {
    if (this.view === 'settings') return this.settingsPanel.handleKey(e);
    // Root: the list never consumes Escape, so the game still sees it.
    return this.list.handleKey(e);
  }

  private fire(action: () => void): void {
    if (this.gate()) action();
  }

  private show(view: View): void {
    this.view = view;
    this.el.dataset.view = view;
    this.rootView.classList.toggle('is-current', view === 'root');
    this.settingsView.classList.toggle('is-current', view === 'settings');
    setKeyHints(this.hints, HINTS[view]);
    if (view === 'settings') {
      this.settingsPanel.mount(this.settingsView, {
        crumb: 'Paused // Settings',
        onBack: () => this.show('root'),
      });
    } else {
      this.list.focus();
    }
  }
}
