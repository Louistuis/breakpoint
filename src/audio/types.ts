/** Public contract of the audio system. The game only talks to audio through IAudio. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Acoustic class of a surface or fragment. */
export type SurfaceKind = 'concrete' | 'brick' | 'wood' | 'metal' | 'glass' | 'dirt' | 'foliage' | 'plaster' | 'rubber';

export type WeaponSound =
  | 'hammer_swing'
  | 'hammer_hit'
  | 'pistol'
  | 'shotgun'
  | 'shotgun_pump'
  | 'rocket_launch'
  | 'charge_place'
  | 'charge_beep'
  | 'detonator'
  | 'reload'
  | 'empty'
  | 'switch'
  | 'torch_ignite'
  | 'grab'
  | 'throw';

export type UiSound = 'hover' | 'click' | 'back' | 'start' | 'success' | 'fail' | 'tick';

export type LoopKind = 'torch' | 'rocket' | 'fire' | 'engine';

export interface PlayOpts {
  /** World position. Omit for a non-spatial (2D, at the listener) sound. */
  pos?: Vec3Like;
  /** Linear gain multiplier, default 1. */
  gain?: number;
  /** Playback-rate / pitch multiplier, default 1. */
  pitch?: number;
  /** Extra start delay in seconds. */
  delay?: number;
}

export interface LoopHandle {
  setGain(gain: number, rampSeconds?: number): void;
  setPitch(pitch: number): void;
  setPos(pos: Vec3Like): void;
  stop(fadeSeconds?: number): void;
}

export interface IAudio {
  /** Create/resume the AudioContext. Must be called from a user gesture; safe to call repeatedly. */
  unlock(): Promise<void>;
  setMasterVolume(v: number): void;
  /** Duck everything except UI sounds while the game is paused or in a menu. */
  setPaused(paused: boolean): void;
  setListener(pos: Vec3Like, forward: Vec3Like, up: Vec3Like): void;
  /** Called once per rendered frame with the frame delta in seconds. */
  update(dt: number): void;

  weapon(kind: WeaponSound, opts?: PlayOpts): void;
  /** Bullet / hammer / debris impact. intensity 0..1 (values above 1 are allowed for very heavy hits). */
  impact(surface: SurfaceKind, intensity: number, opts?: PlayOpts): void;
  /** Glass pane shattering. size 0..1 ≈ how much glass broke. */
  shatter(pos: Vec3Like, size: number): void;
  /** Layered explosion. power 0..1+ (0.4 barrel, 0.7 charge, 1 rocket/tank). Far explosions are delayed by distance. */
  explosion(pos: Vec3Like, power: number): void;
  /** Structural collapse rumble. massKg is the detached mass (≈50 … 200000). */
  collapse(pos: Vec3Like, massKg: number): void;
  /** Stressed structure groaning before a collapse. intensity 0..1. */
  creak(pos: Vec3Like, intensity: number): void;
  footstep(surface: SurfaceKind, intensity: number): void;
  land(surface: SurfaceKind, intensity: number): void;
  ui(kind: UiSound): void;

  /** Start a sustained sound. Caller must stop() it. */
  loop(kind: LoopKind, opts?: PlayOpts): LoopHandle;
  startAmbience(): void;
  stopAmbience(): void;
  /** Number of currently sounding voices (for the performance overlay). */
  activeVoices(): number;
}
