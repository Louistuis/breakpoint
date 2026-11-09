/**
 * Watches frame pacing and resource counts and trades visual detail for stability:
 * lowers particle density, debris budgets, shadow update rate, bloom and render
 * resolution step by step when frames run long, and restores them once the load passes.
 * Large destruction events also request a short, temporary reduction up front.
 */
import type { PerfHud } from '../ui/types';
import { settings } from '../utils/settings';
import { clamp } from '../utils/math';
import { LIMITS } from '../world/config';
import type { GameContext } from './Context';

interface MemoryInfo {
  usedJSHeapSize: number;
}

const LEVELS = [
  { scale: 1.0, particles: 1.0, light: 1.0, soft: 1.0, bodies: 1.0, shadowEvery: 1, bloom: true, fire: 1.0 },
  { scale: 1.0, particles: 0.7, light: 0.75, soft: 0.9, bodies: 1.0, shadowEvery: 2, bloom: true, fire: 0.9 },
  { scale: 0.86, particles: 0.5, light: 0.6, soft: 0.72, bodies: 0.9, shadowEvery: 2, bloom: true, fire: 0.7 },
  { scale: 0.73, particles: 0.36, light: 0.5, soft: 0.55, bodies: 0.75, shadowEvery: 3, bloom: true, fire: 0.55 },
  { scale: 0.6, particles: 0.25, light: 0.4, soft: 0.4, bodies: 0.6, shadowEvery: 4, bloom: false, fire: 0.4 },
] as const;

export class PerformanceManager {
  /** 0 = full quality … 4 = most reduced. */
  level = 0;
  fps = 60;
  frameMs = 16.7;
  worstMs = 16.7;
  /** Main-thread time spent inside one game frame. */
  cpuMs = 0;
  /** 0..1, decays: how intense recent destruction was. */
  heat = 0;
  private windowTime = 0;
  private windowFrames = 0;
  private windowWorst = 0;
  private windowCpu = 0;
  private bad = 0;
  private good = 0;
  private goodNeeded = 8;
  private sinceRecover = 99;
  private applied = -1;
  private appliedHeat = false;
  private hudTimer = 0;

  constructor(private readonly ctx: GameContext) {
    settings.subscribe((_s, key) => {
      if (key === null || key === 'adaptiveQuality' || key === 'lowPower' || key === 'resolutionScale') {
        if (!settings.get('adaptiveQuality')) this.level = 0;
        this.applied = -1;
      }
    });
  }

  /** Target frame interval in milliseconds for the current frame-limit setting. */
  get targetMs(): number {
    return settings.get('lowPower') || settings.get('frameLimit') === '30' ? 1000 / 30 : 1000 / 60;
  }

  /** Destruction systems call this so quality drops before a spike, not after. */
  noteDestruction(intensity: number): void {
    this.heat = Math.min(1, this.heat + intensity * 0.7);
  }

  reset(): void {
    this.heat = 0;
    this.bad = this.good = 0;
  }

  update(dt: number, frameMs: number, cpuMs: number): void {
    // a hidden or throttled tab says nothing about how fast the game can run
    if (frameMs > 250 || document.hidden) {
      this.windowTime = 0;
      this.windowFrames = 0;
      this.windowWorst = 0;
      this.windowCpu = 0;
      return;
    }
    this.windowTime += frameMs;
    this.windowFrames++;
    this.windowCpu += cpuMs;
    if (frameMs > this.windowWorst) this.windowWorst = frameMs;
    this.heat = Math.max(0, this.heat - dt * 0.4);
    this.sinceRecover += dt;
    if (this.windowTime >= 500) {
      const avg = this.windowTime / this.windowFrames;
      this.frameMs = avg;
      this.fps = 1000 / avg;
      this.worstMs = this.windowWorst;
      this.cpuMs = this.windowCpu / this.windowFrames;
      const target = this.targetMs;
      if (settings.get('adaptiveQuality')) {
        if (avg > target * 1.22) {
          this.good = 0;
          if (++this.bad >= 2 && this.level < LEVELS.length - 1) {
            this.level++;
            this.bad = 0;
            // if we degrade soon after recovering, wait longer before trying again
            if (this.sinceRecover < 8) this.goodNeeded = Math.min(60, this.goodNeeded * 2);
          }
        } else {
          this.bad = 0;
          if (avg < target * 1.07 && this.cpuMs < target * 0.62 && this.heat < 0.2) {
            if (++this.good >= this.goodNeeded && this.level > 0) {
              this.level--;
              this.good = 0;
              this.sinceRecover = 0;
            }
          } else this.good = 0;
        }
      }
      this.windowTime = 0;
      this.windowFrames = 0;
      this.windowWorst = 0;
      this.windowCpu = 0;
    }
    const hot = this.heat > 0.45;
    if (this.level !== this.applied || hot !== this.appliedHeat) this.apply(hot);
  }

  private apply(hot: boolean): void {
    const { renderer, particles, debris, fire } = this.ctx;
    const L = LEVELS[this.level];
    const low = settings.get('lowPower');
    this.applied = this.level;
    this.appliedHeat = hot;
    particles.density = clamp(L.particles * (low ? 0.7 : 1) * (hot ? 0.75 : 1), 0.15, 1);
    debris.light.limit = Math.round(LIMITS.maxLightDebris * L.light);
    debris.softDebris = Math.round(LIMITS.softDebrisBodies * L.soft * (low ? 0.8 : 1));
    debris.maxBodies = Math.round(LIMITS.maxBodies * L.bodies);
    fire.limit = Math.round(LIMITS.maxBurning * L.fire);
    renderer.shadowInterval = Math.max(L.shadowEvery, low || hot ? 2 : 1);
    renderer.setBloomAllowed(L.bloom);
    renderer.fxAllowed = this.level < 3;
    renderer.setRenderScale(settings.get('resolutionScale'), L.scale);
  }

  /** Data for the optional on-screen overlay (rate-limited by the caller). */
  hud(dt: number): PerfHud | null {
    this.hudTimer -= dt;
    if (this.hudTimer > 0) return null;
    this.hudTimer = 0.25;
    const { renderer, physics, debris, particles, world, audio } = this.ctx;
    const info = renderer.gl.info;
    const mem = (performance as unknown as { memory?: MemoryInfo }).memory;
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      worstMs: this.worstMs,
      physicsMs: physics.stepMs,
      bodies: debris.bodies.length,
      awakeBodies: debris.awake,
      debris: debris.light.active,
      particles: particles.count,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      chunks: world.chunkCount,
      memoryMb: mem ? mem.usedJSHeapSize / 1048576 : null,
      renderScale: renderer.getRenderScale(),
      qualityLevel: this.level,
      voices: audio.activeVoices(),
    };
  }
}
