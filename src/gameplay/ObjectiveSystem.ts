/**
 * Destruction Challenge rules: measures how much of the target structure is still
 * standing, runs the clock, and scores the run (destruction, time, explosive
 * efficiency, collateral structural damage).
 */
import type { GameContext } from '../engine/Context';
import { clamp } from '../utils/math';
import { GROUND_Y, MAT_MASK } from '../destruction/VoxelGrid';
import type { StructureRegion } from '../world/WorldGenerator';
import type { ChallengeDef, ChallengeResult } from './challenges';

/** Voxels lower than this above the ground count as rubble, not as standing structure. */
const RUBBLE_HEIGHT = 4;
const SETTLE_SECONDS = 3.5;

const bestKey = (id: string): string => `breakpoint.best.${id}`;

export function readBest(id: string): number {
  try {
    return Number(localStorage.getItem(bestKey(id))) || 0;
  } catch {
    return 0;
  }
}

export class ObjectiveSystem {
  challenge: ChallengeDef | null = null;
  private region: StructureRegion | null = null;
  private initial = 1;
  private standing = 1;
  private elapsed = 0;
  private recount = 0;
  private countedVersion = -1;
  /** Counts down once the required fraction has been reached. */
  private settle = -1;
  private hudKey = '';
  finished = false;
  onFinish: ((result: ChallengeResult) => void) | null = null;

  constructor(private readonly ctx: GameContext) {}

  /** 0..1 of the target destroyed. */
  get destroyed(): number {
    return clamp(1 - this.standing / this.initial, 0, 1);
  }

  get timeLeft(): number {
    return this.challenge ? Math.max(0, this.challenge.timeLimit - this.elapsed) : 0;
  }

  /** Begin a run (null = sandbox, no objective). Call after the world has been (re)built. */
  start(challenge: ChallengeDef | null): void {
    this.challenge = challenge;
    this.finished = false;
    this.elapsed = 0;
    this.settle = -1;
    this.recount = 0;
    this.hudKey = '';
    this.region = challenge ? (this.ctx.world.meta.regions.find((r) => r.key === challenge.targetKey) ?? null) : null;
    if (!challenge || !this.region) {
      this.ctx.hud.setObjective(null);
      return;
    }
    this.initial = Math.max(1, this.count());
    this.standing = this.initial;
    this.countedVersion = this.ctx.grid.version;
    this.pushHud();
  }

  /** Solid voxels of the target that are still above rubble height. */
  private count(): number {
    const r = this.region;
    if (!r) return 0;
    const { grid } = this.ctx;
    const { data, strideZ, strideY } = grid;
    const y0 = Math.max(r.min[1], GROUND_Y + RUBBLE_HEIGHT), y1 = Math.min(r.max[1], grid.ny - 1);
    const x0 = Math.max(0, r.min[0]), x1 = Math.min(grid.nx - 1, r.max[0]);
    const z0 = Math.max(0, r.min[2]), z1 = Math.min(grid.nz - 1, r.max[2]);
    let n = 0;
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) {
        const row = strideZ * z + strideY * y;
        for (let x = x0; x <= x1; x++) if (data[row + x] & MAT_MASK) n++;
      }
    return n;
  }

  private liveScore(): number {
    return Math.round(this.destroyed * 6000 + Math.min(1000, this.ctx.grid.removedTotal / 40));
  }

  private pushHud(): void {
    const c = this.challenge;
    if (!c) return;
    const used = this.ctx.weapons.explosivesUsed;
    const key = `${Math.round(this.destroyed * 1000)}|${Math.ceil(this.timeLeft * 10)}|${used}`;
    if (key === this.hudKey) return;
    this.hudKey = key;
    this.ctx.hud.setObjective({ code: c.code, title: c.title, targetName: c.targetName, progress: this.destroyed, required: c.targetFraction, timeLeft: this.timeLeft, score: this.liveScore(), explosivesUsed: used });
  }

  update(dt: number): void {
    const c = this.challenge;
    if (!c || !this.region || this.finished) return;
    const { grid, hud } = this.ctx;
    this.elapsed += dt;
    this.recount -= dt;
    if (this.recount <= 0 && grid.version !== this.countedVersion) {
      this.recount = 0.35;
      this.countedVersion = grid.version;
      this.standing = this.count();
    }
    if (this.settle < 0 && this.destroyed >= c.targetFraction) {
      this.settle = SETTLE_SECONDS;
      hud.toast('Target fraction reached — letting it settle', 'success');
    }
    if (this.settle >= 0) {
      this.settle -= dt;
      if (this.settle <= 0) {
        this.finish(true);
        return;
      }
    } else if (this.elapsed >= c.timeLimit) {
      this.finish(false);
      return;
    }
    this.pushHud();
  }

  private finish(passed: boolean): void {
    const c = this.challenge;
    if (!c) return;
    this.finished = true;
    this.standing = this.count();
    const destroyed = this.destroyed;
    const time = Math.min(this.elapsed, c.timeLimit);
    const used = this.ctx.weapons.explosivesUsed;
    const issued = (c.loadout.charges ?? 12) + (c.loadout.rockets ?? 8);
    const damage = this.ctx.grid.removedTotal;
    const destroyedVoxels = Math.round(destroyed * this.initial);
    const efficiency = used > 0 ? destroyedVoxels / used : 0;

    const pDestroy = Math.round(destroyed * 6000);
    const pTime = passed ? Math.round((1 - time / c.timeLimit) * 2500) : 0;
    const pEff = passed ? Math.round(1500 * clamp(1.25 - used / Math.max(1, issued), 0, 1)) : 0;
    const pDamage = Math.round(Math.min(1000, damage / 40));
    const pDone = passed ? 1000 : 0;
    const score = pDestroy + pTime + pEff + pDamage + pDone;
    const grade: ChallengeResult['grade'] = !passed ? 'D' : score >= 9500 ? 'S' : score >= 8000 ? 'A' : score >= 6500 ? 'B' : 'C';
    const best = readBest(c.id);
    if (score > best) {
      try {
        localStorage.setItem(bestKey(c.id), String(score));
      } catch {
        // storage unavailable (private mode): the run still counts for this session
      }
    }
    const mm = Math.floor(time / 60), ss = Math.floor(time % 60);
    const result: ChallengeResult = {
      challenge: c,
      passed,
      destroyed,
      time,
      explosivesUsed: used,
      efficiency,
      structuralDamage: damage,
      score,
      grade,
      breakdown: [
        { label: 'Target destroyed', value: `${Math.round(destroyed * 100)} %`, points: pDestroy },
        { label: 'Time', value: `${mm}:${String(ss).padStart(2, '0')}`, points: pTime },
        { label: 'Explosive efficiency', value: used > 0 ? `${used} used · ${Math.round(efficiency).toLocaleString('en-US')} vox each` : 'none used', points: pEff },
        { label: 'Structural damage', value: `${damage.toLocaleString('en-US')} voxels`, points: pDamage },
        { label: 'Contract complete', value: passed ? 'yes' : 'no', points: pDone },
      ],
      best,
    };
    this.pushHud();
    this.onFinish?.(result);
  }
}
