/**
 * Fire that actually consumes the world: burning voxels spread to flammable neighbours,
 * char, and finally burn through, so timber structures weaken and collapse on their own.
 * The number of simultaneously burning voxels is capped.
 */
import * as THREE from 'three';
import type { LoopHandle } from '../audio/types';
import type { GameContext } from '../engine/Context';
import type { LightHandle } from '../engine/Renderer';
import { F_FLAMMABLE, INV_VOXEL, M, MAT_FLAGS, VOXEL } from '../world/Materials';
import { LIMITS } from '../world/config';
import { FLAG_BURN, MAT_MASK } from './VoxelGrid';

interface Flame {
  index: number;
  x: number;
  y: number;
  z: number;
  /** Seconds of fuel left. */
  fuel: number;
}

const NEIGHBOURS: [number, number, number][] = [];
for (let dy = -1; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) NEIGHBOURS.push([dx, dy, dz]);

const centroid = new THREE.Vector3();

export class FireSystem {
  private flames: Flame[] = [];
  private tick = 0;
  private sound: LoopHandle | null = null;
  private light: LightHandle | null = null;
  /** Lowered by the performance manager. */
  limit: number = LIMITS.maxBurning;

  constructor(private readonly ctx: GameContext) {}

  get burning(): number {
    return this.flames.length;
  }

  igniteAt(wx: number, wy: number, wz: number): boolean {
    const g = this.ctx.grid;
    const x = Math.floor(wx * INV_VOXEL), y = Math.floor(wy * INV_VOXEL), z = Math.floor(wz * INV_VOXEL);
    if (!g.inBounds(x, y, z)) return false;
    return this.ignite(g.index(x, y, z), x, y, z);
  }

  ignite(index: number, x: number, y: number, z: number): boolean {
    const g = this.ctx.grid;
    const v = g.data[index];
    const m = v & MAT_MASK;
    if (!m || !(MAT_FLAGS[m] & F_FLAMMABLE) || v & FLAG_BURN) return false;
    if (this.flames.length >= this.limit) return false;
    g.data[index] = v | FLAG_BURN;
    const fuel = m === M.Leaves || m === M.Fabric ? 1.2 + Math.random() * 1.5 : 3 + Math.random() * 4.5;
    this.flames.push({ index, x, y, z, fuel });
    return true;
  }

  clear(): void {
    this.flames.length = 0;
    this.sound?.stop(0.1);
    this.sound = null;
    this.light?.release();
    this.light = null;
  }

  update(dt: number): void {
    const { grid, particles, damage, audio, renderer, player } = this.ctx;
    const flames = this.flames;
    if (flames.length === 0) {
      if (this.sound) {
        this.sound.stop(0.6);
        this.sound = null;
      }
      if (this.light) {
        this.light.release();
        this.light = null;
      }
      return;
    }
    this.tick += dt;
    const step = this.tick >= 0.1;
    if (step) this.tick = 0;
    centroid.set(0, 0, 0);
    let near = 0;
    const eye = player.eye;
    // flame particles: a fixed emission budget shared by all burning voxels
    const emit = Math.min(flames.length, 10) * particles.density;
    for (let k = 0; k < emit; k++) {
      const f = flames[(Math.random() * flames.length) | 0];
      const wx = (f.x + 0.5) * VOXEL, wy = (f.y + 0.9) * VOXEL, wz = (f.z + 0.5) * VOXEL;
      particles.flame(wx + (Math.random() - 0.5) * 0.2, wy, wz + (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.4, 1.1 + Math.random() * 1.3, (Math.random() - 0.5) * 0.4, 0.3 + Math.random() * 0.3, 0.35 + Math.random() * 0.35, 0.8);
      if (Math.random() < 0.12) particles.smoke(wx, wy + 0.4, wz, (Math.random() - 0.5) * 0.4, 1.4, (Math.random() - 0.5) * 0.4, 0.7, 2.2 + Math.random() * 1.5, 0.12, 0.3);
    }
    for (let i = flames.length - 1; i >= 0; i--) {
      const f = flames[i];
      const v = grid.data[f.index];
      const m = v & MAT_MASK;
      if (!m || !(v & FLAG_BURN)) {
        // the voxel was destroyed by something else
        flames[i] = flames[flames.length - 1];
        flames.pop();
        continue;
      }
      const wx = (f.x + 0.5) * VOXEL, wy = (f.y + 0.5) * VOXEL, wz = (f.z + 0.5) * VOXEL;
      const d2 = (wx - eye.x) ** 2 + (wy - eye.y) ** 2 + (wz - eye.z) ** 2;
      if (d2 < 30 * 30) {
        centroid.x += wx;
        centroid.y += wy;
        centroid.z += wz;
        near++;
      }
      if (!step) continue;
      f.fuel -= 0.1;
      if (Math.random() < 0.3) {
        const n = NEIGHBOURS[(Math.random() * NEIGHBOURS.length) | 0];
        const nx = f.x + n[0], ny = f.y + n[1], nz = f.z + n[2];
        if (grid.inBounds(nx, ny, nz)) this.ignite(grid.index(nx, ny, nz), nx, ny, nz);
      }
      if (f.fuel <= 0) {
        flames[i] = flames[flames.length - 1];
        flames.pop();
        grid.data[f.index] &= ~FLAG_BURN;
        if ((m === M.Wood || m === M.WoodDark || m === M.Bark) && Math.random() < 0.55) grid.retype(f.index, M.Char);
        else damage.destroyVoxel(f.index);
      }
    }
    if (near > 0) {
      centroid.multiplyScalar(1 / near);
      if (!this.sound) this.sound = audio.loop('fire', { pos: centroid, gain: 0 });
      this.sound.setPos(centroid);
      this.sound.setGain(Math.min(1, 0.25 + Math.sqrt(near) * 0.09), 0.3);
      if (!this.light) this.light = renderer.holdLight(0xff7a2a, 16);
      if (this.light) {
        centroid.y += 0.6;
        this.light.set(centroid, (6 + Math.sqrt(near) * 2.2) * (0.8 + Math.random() * 0.4));
      }
    } else if (this.sound) {
      this.sound.setGain(0, 0.5);
    }
  }
}
