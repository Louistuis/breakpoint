/**
 * Persistent game settings. This is the single source of truth: the Settings UI
 * writes to it, engine systems subscribe to it.
 */
export type QualityPreset = 'low' | 'medium' | 'high';
export type ShadowQuality = 'off' | 'low' | 'medium' | 'high';
export type FrameLimit = 'display' | '60' | '30';

export interface GameSettings {
  /** Fraction of native device pixels rendered (0.4 – 1.0). */
  resolutionScale: number;
  quality: QualityPreset;
  shadows: ShadowQuality;
  /** Metres. Chunk meshes beyond this are not drawn. */
  renderDistance: number;
  /** Vertical field of view in degrees. */
  fov: number;
  mouseSensitivity: number;
  /** Master volume 0 – 1. */
  volume: number;
  /** Frame pacing. Browsers always sync to the display; this caps the simulation/render rate. */
  frameLimit: FrameLimit;
  /** Let the performance manager lower quality automatically under load. */
  adaptiveQuality: boolean;
  /** Extended-session mode for fanless machines: 30 FPS cap, reduced resolution and effects. */
  lowPower: boolean;
  showPerf: boolean;
  /** Sandbox only. */
  unlimitedAmmo: boolean;
  bloom: boolean;
  cameraShake: number;
}

export const DEFAULT_SETTINGS: GameSettings = {
  // the renderer caps total pixels per quality preset, so full scale is safe on Retina displays
  resolutionScale: 1,
  quality: 'medium',
  shadows: 'medium',
  renderDistance: 110,
  fov: 78,
  mouseSensitivity: 1,
  volume: 0.8,
  frameLimit: 'display',
  adaptiveQuality: true,
  lowPower: false,
  showPerf: false,
  unlimitedAmmo: true,
  bloom: true,
  cameraShake: 1,
};

export const SETTING_LIMITS = {
  resolutionScale: { min: 0.4, max: 1, step: 0.05 },
  renderDistance: { min: 40, max: 140, step: 5 },
  fov: { min: 60, max: 105, step: 1 },
  mouseSensitivity: { min: 0.2, max: 3, step: 0.05 },
  volume: { min: 0, max: 1, step: 0.01 },
  cameraShake: { min: 0, max: 1.5, step: 0.05 },
} as const;

const KEY = 'breakpoint.settings.v1';
type Listener = (s: GameSettings, changed: keyof GameSettings | null) => void;

class SettingsStore {
  readonly values: GameSettings = { ...DEFAULT_SETTINGS };
  private listeners = new Set<Listener>();

  constructor() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<GameSettings>;
        for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof GameSettings)[]) {
          if (k in parsed && typeof parsed[k] === typeof DEFAULT_SETTINGS[k]) {
            (this.values as unknown as Record<string, unknown>)[k] = parsed[k];
          }
        }
      }
    } catch {
      /* corrupted settings: fall back to defaults */
    }
  }

  get<K extends keyof GameSettings>(key: K): GameSettings[K] {
    return this.values[key];
  }

  set<K extends keyof GameSettings>(key: K, value: GameSettings[K]): void {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.persist();
    for (const l of this.listeners) l(this.values, key);
  }

  reset(): void {
    Object.assign(this.values, DEFAULT_SETTINGS);
    this.persist();
    for (const l of this.listeners) l(this.values, null);
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.values));
    } catch {
      /* storage unavailable */
    }
  }
}

export const settings = new SettingsStore();
