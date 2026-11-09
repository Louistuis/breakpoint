/**
 * Schedules structural load checks after significant damage and stages the resulting
 * failures: a stressed structure groans first, then the overloaded section gives way and
 * the connectivity solver drops everything it was holding. Re-checks afterwards, so a
 * building comes down progressively rather than in one frame.
 */
import type { GameContext } from '../engine/Context';
import { clamp } from '../utils/math';
import { INV_VOXEL, VOXEL } from '../world/Materials';
import type { LoadFailure, LoadReport } from './StructuralIntegrity';
import { GROUND_Y, MAT_MASK } from './VoxelGrid';

interface Request {
  x: number;
  y: number;
  z: number;
  radius: number;
  delay: number;
}

interface Pending {
  failure: LoadFailure;
  timer: number;
  x: number;
  y: number;
  z: number;
}

const p = { x: 0, y: 0, z: 0 };

export class CollapseDirector {
  private requests: Request[] = [];
  private pending: Pending[] = [];
  /** Structural failures triggered since the last reset. */
  failures = 0;
  lastReport: LoadReport | null = null;

  constructor(private readonly ctx: GameContext) {}

  /** Ask for the structures around a world-space point to be re-evaluated shortly. */
  request(wx: number, wy: number, wz: number, radius: number, delay: number): void {
    for (const r of this.requests) {
      if (Math.abs(r.x - wx) + Math.abs(r.y - wy) + Math.abs(r.z - wz) < 2) {
        r.radius = Math.max(r.radius, radius);
        r.delay = Math.max(r.delay, delay * 0.5);
        return;
      }
    }
    if (this.requests.length < 12) this.requests.push({ x: wx, y: wy, z: wz, radius, delay });
  }

  clear(): void {
    this.requests.length = 0;
    this.pending.length = 0;
    this.failures = 0;
  }

  /** Solid voxels near a point that belong to (up to two) structures worth analysing. */
  private findSeeds(r: Request): number[] {
    const { grid } = this.ctx;
    const cx = Math.floor(r.x * INV_VOXEL), cy = Math.floor(r.y * INV_VOXEL), cz = Math.floor(r.z * INV_VOXEL);
    const rad = Math.ceil(r.radius * INV_VOXEL);
    let above = -1, aboveD = Infinity, any = -1, anyD = Infinity;
    for (let dy = -rad; dy <= rad; dy += 2) {
      const y = cy + dy;
      if (y < GROUND_Y + 1 || y >= grid.ny) continue;
      for (let dz = -rad; dz <= rad; dz += 2)
        for (let dx = -rad; dx <= rad; dx += 2) {
          const x = cx + dx, z = cz + dz;
          if (x < 0 || z < 0 || x >= grid.nx || z >= grid.nz) continue;
          const i = grid.index(x, y, z);
          if (!(grid.data[i] & MAT_MASK)) continue;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < anyD) (anyD = d), (any = i);
          if (dy > 0 && d < aboveD) (aboveD = d), (above = i);
        }
    }
    const out: number[] = [];
    if (above >= 0) out.push(above);
    if (any >= 0 && any !== above) out.push(any);
    return out;
  }

  update(dt: number): void {
    const { integrity, audio, damage, camera } = this.ctx;
    // 1) staged failures
    for (let k = this.pending.length - 1; k >= 0; k--) {
      const c = this.pending[k];
      c.timer -= dt;
      if (c.timer > 0) continue;
      this.pending.splice(k, 1);
      const removed = damage.crush(c.failure.indices);
      if (removed > 0) {
        this.failures++;
        p.x = c.x;
        p.y = c.y;
        p.z = c.z;
        camera.shakeFrom(p, 0.35, 45);
        // what is left may now be overloaded too
        this.request(c.x, c.y + 1, c.z, 4, 0.7);
      }
    }
    // 2) at most one analysis per frame, and only once the connectivity queue has drained
    if (this.requests.length === 0 || integrity.pending > 0) return;
    for (const r of this.requests) r.delay -= dt;
    const idx = this.requests.findIndex((r) => r.delay <= 0);
    if (idx < 0) return;
    const req = this.requests.splice(idx, 1)[0];
    let lastMass = -1;
    for (const seed of this.findSeeds(req)) {
      const report = integrity.analyze(seed);
      if (!report || report.mass === lastMass) continue;
      lastMass = report.mass;
      this.lastReport = report;
      const f = report.failure;
      if (!f) continue;
      if (this.pending.some((c) => c.failure.level === f.level && Math.abs(c.x - f.cx * VOXEL) < 3 && Math.abs(c.z - f.cz * VOXEL) < 3)) continue;
      const x = f.cx * VOXEL, y = (f.level + 0.5) * VOXEL, z = f.cz * VOXEL;
      p.x = x;
      p.y = y;
      p.z = z;
      const big = clamp(Math.log10(Math.max(100, f.massAbove)) / 5, 0.3, 1);
      audio.creak(p, big);
      camera.shakeFrom(p, 0.12 * big, 40);
      this.pending.push({ failure: f, timer: 0.35 + Math.random() * 0.45 + big * 0.3, x, y, z });
    }
  }
}
