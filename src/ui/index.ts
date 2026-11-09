/**
 * BREAKPOINT UI layer: a DOM / CSS overlay on top of the game canvas.
 * The game talks to it only through IUI / IHud (see ./types).
 */
import './styles.css';
import type { UiSound } from '../audio/types';
import { h } from './dom';
import { Hud } from './HUD';
import { MainMenu } from './MainMenu';
import { PauseMenu } from './PauseMenu';
import { ResultsScreen } from './Results';
import { ErrorScreen, LoadingScreen } from './Screens';
import { SettingsPanel } from './Settings';
import type { CreateUI, IUI } from './types';

type Overlay = 'none' | 'main' | 'pause' | 'results';

export const createUI: CreateUI = (root, callbacks, challenges) => {
  const sound = (kind: UiSound): void => callbacks.onUiSound(kind);

  const hud = new Hud();
  const settingsPanel = new SettingsPanel(sound);
  const mainMenu = new MainMenu(callbacks, challenges, settingsPanel);
  const pauseMenu = new PauseMenu(callbacks, settingsPanel);
  const results = new ResultsScreen(callbacks);
  const loading = new LoadingScreen();
  const error = new ErrorScreen();

  const layer = h('div', 'bp-ui', hud.el, mainMenu.el, pauseMenu.el, results.el, loading.el, error.el);
  root.append(layer);

  let overlay: Overlay = 'none';

  const closeCurrent = (): void => {
    switch (overlay) {
      case 'main':
        mainMenu.close();
        break;
      case 'pause':
        pauseMenu.close();
        break;
      case 'results':
        results.close();
        break;
      case 'none':
        break;
    }
    overlay = 'none';
  };

  /** Give keyboard focus back to the game canvas when a menu that held it goes away. */
  const releaseFocus = (): void => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !layer.contains(active)) return;
    active.blur();
    const canvas = document.getElementById('game');
    if (canvas instanceof HTMLElement) canvas.focus({ preventScroll: true });
  };

  // One key router for every menu. It runs in the capture phase and swallows only the keys a
  // menu actually used, so everything else (Escape on the pause root, F3, ...) reaches the game.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (overlay === 'none' || error.isVisible || loading.isVisible) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    let handled = false;
    switch (overlay) {
      case 'main':
        handled = mainMenu.handleKey(e);
        break;
      case 'pause':
        handled = pauseMenu.handleKey(e);
        break;
      case 'results':
        handled = results.handleKey(e);
        break;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener('keydown', onKeyDown, true);

  const ui: IUI = {
    hud,

    showLoading(progress, label) {
      loading.show(progress, label);
    },

    hideLoading() {
      const wasVisible = loading.isVisible;
      loading.hide();
      if (wasVisible && overlay === 'main') mainMenu.replayEntrance();
    },

    showMainMenu() {
      if (overlay !== 'main') closeCurrent();
      overlay = 'main';
      mainMenu.open();
    },

    showPause(mode) {
      if (overlay !== 'pause') closeCurrent();
      overlay = 'pause';
      pauseMenu.open(mode);
    },

    showResults(result) {
      if (overlay !== 'results') closeCurrent();
      overlay = 'results';
      results.open(result);
    },

    hideOverlays() {
      if (overlay === 'none') return;
      closeCurrent();
      releaseFocus();
    },

    isOverlayOpen() {
      return overlay !== 'none';
    },

    showError(title, detail) {
      error.show(title, detail);
    },
  };

  return ui;
};

export type { IHud, IUI, UICallbacks } from './types';
