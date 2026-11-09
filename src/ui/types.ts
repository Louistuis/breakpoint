/** Public contract of the UI layer (DOM overlay). The game only talks to the UI through these interfaces. */
import type { ChallengeDef, ChallengeResult, GameMode, WeaponId } from '../gameplay/challenges';
import type { UiSound } from '../audio/types';

export interface WeaponSlotInfo {
  id: WeaponId;
  /** Display name, e.g. "Sledgehammer". */
  name: string;
  /** Number key 1–6. */
  key: number;
}

export interface AmmoHud {
  /** Rounds in the magazine / current count. null hides the number (melee). */
  mag: number | null;
  /** Reserve ammunition. null = no reserve concept; Infinity = unlimited. */
  reserve: number | null;
  /** Small caption under the number, e.g. "9MM", "CHARGES", "FUEL". */
  label: string;
  reloading: boolean;
  /** 0..1 while reloading. */
  reloadProgress: number;
  /** Optional 0..1 gauge (blowtorch fuel / heat). null hides it. */
  gauge: number | null;
  /** Optional secondary line, e.g. "REMOTE · 3 PLACED" for explosive charges. */
  detail: string | null;
}

export interface ObjectiveHud {
  code: string;
  title: string;
  targetName: string;
  /** 0..1 destroyed so far. */
  progress: number;
  /** 0..1 required. */
  required: number;
  /** Seconds remaining. */
  timeLeft: number;
  score: number;
  explosivesUsed: number;
}

export interface PerfHud {
  fps: number;
  frameMs: number;
  /** Worst frame in the last second. */
  worstMs: number;
  physicsMs: number;
  bodies: number;
  awakeBodies: number;
  debris: number;
  particles: number;
  drawCalls: number;
  triangles: number;
  chunks: number;
  /** Megabytes, or null when the browser does not expose it. */
  memoryMb: number | null;
  /** Current render scale actually used (0..1 of native). */
  renderScale: number;
  /** 0 = full quality … 4 = most reduced. */
  qualityLevel: number;
  voices: number;
}

export type CrosshairKind = 'dot' | 'cross' | 'circle' | 'none';

export interface IHud {
  setVisible(visible: boolean): void;
  setWeapons(slots: WeaponSlotInfo[]): void;
  /** Highlight a slot (0-based) and play the selection transition. */
  selectWeapon(index: number): void;
  setAmmo(ammo: AmmoHud): void;
  /** Contextual prompt near the crosshair, e.g. key "E", text "Pick up crate". null hides it. */
  setPrompt(prompt: { key: string; text: string } | null): void;
  /** spread = extra gap in CSS pixels (0 = tight). Called every frame; must be cheap. */
  setCrosshair(kind: CrosshairKind, spread: number): void;
  /** Brief hit confirmation on the crosshair. strength 0..1. */
  hitMarker(strength: number): void;
  setObjective(o: ObjectiveHud | null): void;
  setPerf(p: PerfHud | null): void;
  toast(text: string, kind?: 'info' | 'warn' | 'success'): void;
  /** Full-screen white/orange flash from a nearby explosion. intensity 0..1. */
  flash(intensity: number): void;
  /** Mode tag in the corner, e.g. "SANDBOX". */
  setModeLabel(text: string): void;
}

export interface UICallbacks {
  /** Player picked a mode from the main menu. challengeId is set when mode === 'challenge'. */
  onStart(mode: GameMode, challengeId?: string): void;
  onResume(): void;
  /** Restart / reset the environment (pause menu, results screen "Retry"). */
  onRestart(): void;
  onQuitToMenu(): void;
  /** UI feedback sounds; the game routes this to the audio system. */
  onUiSound(kind: UiSound): void;
}

export interface IUI {
  readonly hud: IHud;
  /** progress 0..1. */
  showLoading(progress: number, label: string): void;
  hideLoading(): void;
  showMainMenu(): void;
  /** mode decides which entries make sense (e.g. label of the restart button). */
  showPause(mode: GameMode): void;
  showResults(result: ChallengeResult): void;
  /** Hide menu / pause / results overlays (the HUD is controlled separately). */
  hideOverlays(): void;
  /** True while any menu overlay (main, pause, settings, results) is on screen. */
  isOverlayOpen(): boolean;
  /** Fatal error screen (e.g. WebGL2 unavailable). */
  showError(title: string, detail: string): void;
}

export type CreateUI = (root: HTMLElement, callbacks: UICallbacks, challenges: ChallengeDef[]) => IUI;
