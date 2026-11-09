/**
 * Applies damage to the static voxel world. Every weapon, explosion, falling slab and
 * flame ends up here: material rules decide whether a voxel shrugs the hit off, cracks
 * (visible damage that accumulates) or is removed, and removed voxels feed the
 * structural solver.
 */
import type { GameContext } from '../engine/Context';
import { clamp, hash3 } from '../utils/math';
import { F_BRITTLE_PANE, F_FLAMMABLE, F_INDESTRUCTIBLE, Frag, INV_VOXEL, M, MAT_COLOR, MAT_FLAGS, MAT_FRAG, MAT_HP, MAT_MIN, MAT_SURFACE, VOXEL } from '../world/Materials';
import { GROUND_Y, MAT_MASK } from './VoxelGrid';

export type DamageCause = 'bullet' | 'melee' | 'explosion' | 'impact' | 'torch' | 'crush' | 'fire';

/** Fraction of the torch's power that reaches each material class. */
const torchFactor = (m: number): number => {
  const s = MAT_SURFACE[m];
  if (s === 'metal') return 1;
  if (s === 'glass') return 2;
  if (MAT_FLAGS[m] & F_FLAMMABLE) return 0.5;
  return 0.07;
};

const pos = { x: 0, y: 0, z: 0 };
const c3 = [0, 0, 0];

export class DamageSystem {
  /** Voxels removed by the last sphere() call, by material id. */
  readonly lastByMat = new Uint32Array(32);
  /** Material that lost the most voxels in the last call (0 = nothing removed). */
  lastMat = 0;
  /** Removed since a structural load check was last requested. */
  private sinceLoadCheck = 0;
  private glassQueue: number[] = [];
  private bitBudget = 0;

  constructor(private readonly ctx: GameContext) {}

  /**
   * Damage every voxel inside a sphere. Power falls off towards the edge; the returned
   * value is the number of voxels destroyed.
   * @param dir optional unit direction that fragments are thrown along (bullet / swing)
   */
  sphere(wx: number, wy: number, wz: number, radius: number, power: number, cause: DamageCause, dir?: { x: number; y: number; z: number }): number {
    const { grid, integrity, physics, particles, collapse } = this.ctx;
    const { data, strideZ, strideY, damage } = grid;
    const cx = wx * INV_VOXEL, cy = wy * INV_VOXEL, cz = wz * INV_VOXEL;
    const r = radius * INV_VOXEL;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(grid.nx - 1, Math.floor(cx + r));
    const y0 = Math.max(1, Math.floor(cy - r)), y1 = Math.min(grid.ny - 1, Math.floor(cy + r));
    const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(grid.nz - 1, Math.floor(cz + r));
    const explosion = cause === 'explosion';
    const torch = cause === 'torch';
    const noise = explosion ? 0.4 : 0.55;
    const r2 = r * r;
    this.lastByMat.fill(0);
    this.bitBudget = explosion ? 110 : cause === 'bullet' ? 9 : 22;
    let removed = 0;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let z = z0; z <= z1; z++) {
        const dz = z + 0.5 - cz;
        const row = strideZ * z + strideY * y;
        for (let x = x0; x <= x1; x++) {
          const i = row + x;
          const m = data[i] & MAT_MASK;
          if (m === 0) continue;
          const dx = x + 0.5 - cx;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          const flags = MAT_FLAGS[m];
          if (flags & F_INDESTRUCTIBLE) continue;
          const d = Math.sqrt(d2) / r;
          let p = power * (explosion ? (1 - d) * (1 - d) : 1 - d * d);
          p *= 1 + (hash3(x, y, z) - 0.5) * noise;
          // the ground itself is far more massive than anything built on it: blasts crater it, but shallowly
          if (explosion && y < GROUND_Y) p *= 0.45;
          if (torch) p *= torchFactor(m);
          else if (p < MAT_MIN[m]) continue;
          const hp = MAT_HP[m];
          // structural steel and machinery shrug off blunt hits entirely: cut or blast them
          if (cause === 'melee' && hp >= 400) continue;
          const prev = damage.size ? (damage.get(i) ?? 0) : 0;
          if (p + prev >= hp) {
            removed++;
            this.lastByMat[m]++;
            this.destroy(i, m, x, y, z, dx, dy, dz, explosion ? 5 + power * 0.004 : 2.2, dir);
          } else if (p > hp * 0.04) {
            const next = prev + p * 0.75;
            damage.set(i, next);
            if (Math.floor((next / hp) * 3) !== Math.floor((prev / hp) * 3) || prev === 0) grid.markDirty(x, y, z);
          }
        }
      }
    }
    this.lastMat = 0;
    if (removed > 0) {
      let best = 0;
      for (let m = 1; m < 32; m++) if (this.lastByMat[m] > best) (best = this.lastByMat[m]), (this.lastMat = m);
      this.flushGlass();
      const m = this.lastMat;
      if (!explosion) particles.dust(wx, wy, wz, MAT_COLOR[m * 3], MAT_COLOR[m * 3 + 1], MAT_COLOR[m * 3 + 2], Math.min(9, 1 + removed / 5), radius, 1.3, 0.3 + radius * 0.6);
      const pad = radius + 0.5;
      physics.wakeRegion(wx - pad, wy - pad, wz - pad, wx + pad, wy + pad + 1.5, wz + pad);
      this.ctx.renderer.requestShadowUpdate();
      // enough cumulative chipping eventually warrants a load check, not just explosions
      this.sinceLoadCheck += removed;
      if (explosion || this.sinceLoadCheck >= 50) {
        this.sinceLoadCheck = 0;
        collapse.request(wx, wy, wz, radius + 1.6, explosion ? 0.3 : 0.15);
      }
    } else if (grid.dirtyChunks.length) {
      this.ctx.renderer.requestShadowUpdate();
    }
    void integrity;
    return removed;
  }

  /** Remove one voxel with fragments, seeds for the solver and material side effects. */
  private destroy(i: number, m: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, speed: number, dir?: { x: number; y: number; z: number }): void {
    const { grid, integrity, debris, explosions } = this.ctx;
    grid.remove(i);
    integrity.voxelRemoved(i);
    const flags = MAT_FLAGS[m];
    if (flags & F_BRITTLE_PANE) this.glassQueue.push(i);
    if (m === M.Explosive) explosions.zoneVoxelDestroyed(x, y, z);
    if (this.bitBudget > 0 && MAT_FRAG[m] !== Frag.Dust && Math.random() < 0.55) {
      this.bitBudget--;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.3;
      const k = speed / len;
      let vx = dx * k, vy = dy * k + 1.2, vz = dz * k;
      if (dir) {
        // bullets and swings carry fragments through; a share sprays back out of the hole
        const through = Math.random() < 0.65 ? 1 : -0.5;
        vx += dir.x * 4 * through;
        vy += dir.y * 4 * through;
        vz += dir.z * 4 * through;
      }
      debris.bits(m, (x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL, vx, vy, vz, speed * 0.6);
    }
  }

  /** A broken pane takes the rest of the connected glass with it. */
  private flushGlass(): void {
    const q = this.glassQueue;
    if (q.length === 0) return;
    const { grid, integrity, debris, audio, particles } = this.ctx;
    const { data, strideZ, strideY } = grid;
    const offsets = [1, -1, strideZ, -strideZ, strideY, -strideY];
    let broken = 0;
    let sx = 0, sy = 0, sz = 0;
    let head = 0;
    while (head < q.length && broken < 900) {
      const i = q[head++];
      for (const o of offsets) {
        const n = i + o;
        if (n < 0 || n >= data.length) continue;
        const m = data[n] & MAT_MASK;
        if (!m || !(MAT_FLAGS[m] & F_BRITTLE_PANE)) continue;
        grid.coords(n, c3);
        grid.remove(n);
        integrity.voxelRemoved(n);
        q.push(n);
        broken++;
        sx += c3[0];
        sy += c3[1];
        sz += c3[2];
        if (broken < 70 || Math.random() < 0.08) {
          debris.bits(m, (c3[0] + 0.5) * VOXEL, (c3[1] + 0.5) * VOXEL, (c3[2] + 0.5) * VOXEL, 0, 0.4, 0, 2.4);
        }
      }
    }
    q.length = 0;
    if (broken > 0) {
      pos.x = (sx / broken + 0.5) * VOXEL;
      pos.y = (sy / broken + 0.5) * VOXEL;
      pos.z = (sz / broken + 0.5) * VOXEL;
      audio.shatter(pos, clamp(broken / 70, 0.15, 1));
      particles.sparks(pos.x, pos.y, pos.z, 0, 0, 0, Math.min(10, broken / 6), 2.5);
    }
  }

  /** Structural failure: the listed voxels give way all at once. */
  crush(indices: Int32Array): number {
    const { grid, integrity, debris, particles, physics } = this.ctx;
    let removed = 0;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const stride = Math.max(1, Math.floor(indices.length / 60));
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const m = grid.data[i] & MAT_MASK;
      if (!m || MAT_FLAGS[m] & F_INDESTRUCTIBLE) continue;
      grid.coords(i, c3);
      grid.remove(i);
      integrity.voxelRemoved(i);
      removed++;
      if (c3[0] < x0) x0 = c3[0];
      if (c3[0] > x1) x1 = c3[0];
      if (c3[1] < y0) y0 = c3[1];
      if (c3[1] > y1) y1 = c3[1];
      if (c3[2] < z0) z0 = c3[2];
      if (c3[2] > z1) z1 = c3[2];
      if (k % stride === 0) {
        const wx = (c3[0] + 0.5) * VOXEL, wy = (c3[1] + 0.5) * VOXEL, wz = (c3[2] + 0.5) * VOXEL;
        debris.bits(m, wx, wy, wz, 0, 0.5, 0, 3);
        particles.dust(wx, wy, wz, MAT_COLOR[m * 3], MAT_COLOR[m * 3 + 1], MAT_COLOR[m * 3 + 2], 1.5, 0.3, 1.2, 0.7);
      }
    }
    this.flushGlass();
    if (removed) {
      this.ctx.renderer.requestShadowUpdate();
      physics.wakeRegion(x0 * VOXEL - 0.5, y0 * VOXEL - 0.5, z0 * VOXEL - 0.5, (x1 + 1) * VOXEL + 0.5, (y1 + 1) * VOXEL + 2, (z1 + 1) * VOXEL + 0.5);
    }
    return removed;
  }

  /** Remove a single voxel by index (fire burn-through). */
  destroyVoxel(i: number): void {
    const { grid } = this.ctx;
    const m = grid.data[i] & MAT_MASK;
    if (!m || MAT_FLAGS[m] & F_INDESTRUCTIBLE) return;
    grid.coords(i, c3);
    this.bitBudget = 0;
    this.destroy(i, m, c3[0], c3[1], c3[2], 0, 1, 0, 1);
    this.flushGlass();
    this.sinceLoadCheck++;
  }
}
