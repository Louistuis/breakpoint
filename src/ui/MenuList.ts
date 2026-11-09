/**
 * Vertical menu list shared by the main menu and the pause menu.
 * Keyboard (arrows / W S / Enter) and mouse drive one selection model; a thin accent bar slides
 * to the selected item. Items may ask for an inline two-step confirmation before they fire.
 */
import type { UiSound } from '../audio/types';
import { button, focusQuiet, h, navKey } from './dom';

export interface MenuItemDef {
  id: string;
  label: string;
  /** One-line description shown while the item is focused. */
  hint: string;
  /** When set, activating the item first asks this question inline. */
  confirm?: { ask: string; yes: string; no: string };
  /** Sound played when the item fires. Default 'click'. */
  sound?: UiSound;
  onSelect(): void;
}

interface Row {
  root: HTMLElement;
  btn: HTMLButtonElement;
  yes: HTMLButtonElement | null;
  no: HTMLButtonElement | null;
}

export class MenuList {
  readonly el: HTMLElement;
  private items: MenuItemDef[] = [];
  private rows: Row[] = [];
  private index = 0;
  /** Index of the item currently showing its confirm step, or -1. */
  private armed = -1;
  /** 0 = confirm, 1 = cancel. */
  private choice: 0 | 1 = 0;

  constructor(
    private readonly sound: (kind: UiSound) => void,
    private readonly onFocus: (item: MenuItemDef) => void,
  ) {
    this.el = h('div', 'bp-list');
    this.el.setAttribute('role', 'menu');
  }

  setItems(items: MenuItemDef[]): void {
    this.items = items;
    this.rows = [];
    this.armed = -1;
    this.index = 0;
    const nodes: HTMLElement[] = [h('div', 'bp-list__bar')];

    items.forEach((item, i) => {
      const no = String(i + 1).padStart(2, '0');
      const btn = button('bp-item__btn', h('span', 'bp-item__no', no), h('span', 'bp-item__label', item.label));
      btn.setAttribute('role', 'menuitem');
      const root = h('div', 'bp-item bp-in', btn);
      root.style.setProperty('--i', String(i + 2));

      let yes: HTMLButtonElement | null = null;
      let cancel: HTMLButtonElement | null = null;
      if (item.confirm) {
        yes = button('bp-chip', item.confirm.yes);
        cancel = button('bp-chip', item.confirm.no);
        const y = yes;
        const c = cancel;
        y.addEventListener('click', () => this.choose(true));
        c.addEventListener('click', () => this.choose(false));
        y.addEventListener('mouseenter', () => this.setChoice(0, false));
        c.addEventListener('mouseenter', () => this.setChoice(1, false));
        y.addEventListener('focus', () => this.setChoice(0, true));
        c.addEventListener('focus', () => this.setChoice(1, true));
        root.append(h('div', 'bp-item__confirm', h('span', 'bp-item__ask', item.confirm.ask), y, c));
      }

      root.addEventListener('mouseenter', () => this.select(i, false, true));
      btn.addEventListener('focus', () => this.select(i, false, false));
      btn.addEventListener('click', () => {
        this.select(i, true, false);
        this.activate(i);
      });

      this.rows.push({ root, btn, yes, no: cancel });
      nodes.push(root);
    });

    this.el.replaceChildren(...nodes);
    this.paint();
  }

  /** Select an item silently and move keyboard focus to it (used when a screen opens). */
  focus(index = this.index): void {
    if (this.items.length === 0) return;
    this.disarm();
    this.index = Math.max(0, Math.min(this.items.length - 1, index));
    this.paint();
    focusQuiet(this.rows[this.index].btn);
    this.onFocus(this.items[this.index]);
  }

  handleKey(e: KeyboardEvent): boolean {
    if (this.items.length === 0) return false;
    const nav = navKey(e);
    if (nav === null) return false;

    if (this.armed >= 0) {
      switch (nav) {
        case 'left':
        case 'right':
          this.setChoice(this.choice === 0 ? 1 : 0, false);
          return true;
        case 'enter':
          if (!e.repeat) this.choose(this.choice === 0);
          return true;
        case 'up':
          this.move(-1);
          return true;
        case 'down':
          this.move(1);
          return true;
        case 'back':
          // Backspace cancels the confirm step. Escape is deliberately left alone (the game owns it).
          if (e.code !== 'Backspace') return false;
          this.choose(false);
          return true;
      }
    }

    switch (nav) {
      case 'up':
        this.move(-1);
        return true;
      case 'down':
        this.move(1);
        return true;
      case 'enter':
        if (!e.repeat) this.activate(this.index);
        return true;
      default:
        return false;
    }
  }

  private move(delta: number): void {
    const n = this.items.length;
    this.select((this.index + delta + n) % n, false, true);
  }

  private select(i: number, silent: boolean, moveFocus: boolean): void {
    if (this.armed >= 0 && this.armed !== i) this.disarm();
    if (i === this.index) return;
    this.index = i;
    this.paint();
    if (moveFocus) focusQuiet(this.rows[i].btn);
    if (!silent) this.sound('hover');
    this.onFocus(this.items[i]);
  }

  private paint(): void {
    this.el.style.setProperty('--bp-sel', String(this.index));
    this.rows.forEach((row, i) => row.root.classList.toggle('is-active', i === this.index));
  }

  private activate(i: number): void {
    const item = this.items[i];
    if (!item) return;
    if (item.confirm) {
      if (this.armed !== i) this.arm(i);
      return;
    }
    this.sound(item.sound ?? 'click');
    item.onSelect();
  }

  private arm(i: number): void {
    this.armed = i;
    this.choice = 0;
    const row = this.rows[i];
    row.root.classList.add('is-armed');
    this.paintChoice();
    this.sound('click');
    if (row.yes) focusQuiet(row.yes);
  }

  private disarm(): void {
    if (this.armed < 0) return;
    this.rows[this.armed].root.classList.remove('is-armed');
    this.armed = -1;
  }

  private setChoice(choice: 0 | 1, fromFocus: boolean): void {
    if (this.armed < 0 || choice === this.choice) return;
    this.choice = choice;
    this.paintChoice();
    this.sound('hover');
    if (!fromFocus) {
      const row = this.rows[this.armed];
      const target = choice === 0 ? row.yes : row.no;
      if (target) focusQuiet(target);
    }
  }

  private paintChoice(): void {
    if (this.armed < 0) return;
    const row = this.rows[this.armed];
    row.yes?.classList.toggle('is-active', this.choice === 0);
    row.no?.classList.toggle('is-active', this.choice === 1);
  }

  private choose(confirmed: boolean): void {
    const i = this.armed;
    if (i < 0) return;
    const item = this.items[i];
    this.disarm();
    focusQuiet(this.rows[i].btn);
    if (confirmed) {
      this.sound(item.sound ?? 'click');
      item.onSelect();
    } else {
      this.sound('back');
    }
  }
}
