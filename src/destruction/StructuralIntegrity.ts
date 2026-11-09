/**
 * Structural solver.
 *
 * 1. Connectivity: after voxels are removed, every neighbouring voxel is a "seed". A
 *    depth-first search (biased downwards, early-exit) checks whether the seed still
 *    reaches the ground through face-connected voxels. Components that do not are
 *    returned for conversion into rigid bodies.
 * 2. Load: for heavy events the whole connected structure is traversed once and reduced
 *    to horizontal slices. A slice fails when the mass above exceeds what its remaining
 *    cross-section can carry (crushing), or when the centre of mass above it lies
 *    outside what the section can balance (toppling). Failed slices are crushed, which
 *    lets connectivity drop everything above them.
 *
 * Pure TypeScript on typed arrays: also used by the world-generation worker.
 */
import { MAT_MASS, MAT_STRENGTH } from '../world/Materials';
import { FLAG_GROUNDED, FLAG_VISIT, GROUND_Y, MAT_MASK, type VoxelGrid } from './VoxelGrid';

export interface DetachedComponent {
  /** Grid indices of the component's voxels (still present in the grid). */
  indices: Int32Array;
  min: [number, number, number];
  max: [number, number, number];
  /** kg */
  mass: number;
}

export interface LoadFailure {
  kind: 'crush' | 'topple';
  /** Voxel layer that gives way. */
  level: number;
  /** >1 means failure; how far past the limit the slice is. */
  severity: number;
  /** Indices of the structure's voxels in the failing layer(s). */
  indices: Int32Array;
  /** Mass above the failing layer in kg. */
  massAbove: number;
  /** Centre of the failing section in voxel coordinates. */
  cx: number;
  cz: number;
}

export interface LoadReport {
  voxels: number;
  mass: number;
  worst: number;
  worstLevel: number;
  kind: 'crush' | 'topple';
  failure: LoadFailure | null;
}

/** How much eccentricity a section tolerates per unit of spare capacity. */
const BEND = 0.2;
const MAX_COMPONENT = 600_000;

export class StructuralIntegrity {
  private stack = new Int32Array(1 << 18);
  private visited = new Int32Array(1 << 18);
  private visitedCount = 0;
  private seeds = new Int32Array(1 << 16);
  private seedHead = 0;
  private seedTail = 0;
  // per-layer accumulators for the load analysis
  private readonly lMass: Float64Array;
  private readonly lCap: Float64Array;
  private readonly lMx: Float64Array;
  private readonly lMz: Float64Array;
  private readonly lMinX: Int32Array;
  private readonly lMaxX: Int32Array;
  private readonly lMinZ: Int32Array;
  private readonly lMaxZ: Int32Array;
  private readonly lCount: Int32Array;
  /** Statistics of the last solve() call. */
  lastVisited = 0;

  constructor(private readonly grid: VoxelGrid) {
    const n = grid.ny;
    this.lMass = new Float64Array(n);
    this.lCap = new Float64Array(n);
    this.lMx = new Float64Array(n);
    this.lMz = new Float64Array(n);
    this.lMinX = new Int32Array(n);
    this.lMaxX = new Int32Array(n);
    this.lMinZ = new Int32Array(n);
    this.lMaxZ = new Int32Array(n);
    this.lCount = new Int32Array(n);
  }

  get pending(): number {
    return (this.seedTail - this.seedHead + this.seeds.length) % this.seeds.length;
  }

  private pushSeed(i: number): void {
    const next = (this.seedTail + 1) % this.seeds.length;
    if (next === this.seedHead) {
      // grow the ring buffer
      const n = this.pending;
      const bigger = new Int32Array(this.seeds.length * 2);
      for (let k = 0; k < n; k++) bigger[k] = this.seeds[(this.seedHead + k) % this.seeds.length];
      this.seeds = bigger;
      this.seedHead = 0;
      this.seedTail = n;
    }
    this.seeds[this.seedTail] = i;
    this.seedTail = (this.seedTail + 1) % this.seeds.length;
  }

  /** Queue the solid neighbours of a voxel that has just been removed. */
  voxelRemoved(i: number): void {
    const g = this.grid;
    const { data, strideZ, strideY, nx, nz, ny } = g;
    const y = (i / strideY) | 0;
    const rem = i - y * strideY;
    const z = (rem / strideZ) | 0;
    const x = rem - z * strideZ;
    if (y + 1 < ny && data[i + strideY] & MAT_MASK) this.pushSeed(i + strideY);
    if (x > 0 && data[i - 1] & MAT_MASK) this.pushSeed(i - 1);
    if (x < nx - 1 && data[i + 1] & MAT_MASK) this.pushSeed(i + 1);
    if (z > 0 && data[i - strideZ] & MAT_MASK) this.pushSeed(i - strideZ);
    if (z < nz - 1 && data[i + strideZ] & MAT_MASK) this.pushSeed(i + strideZ);
    if (y > GROUND_Y && data[i - strideY] & MAT_MASK) this.pushSeed(i - strideY);
  }

  /** Queue a voxel itself (used after rubble is merged back into the grid). */
  voxelAdded(i: number): void {
    this.pushSeed(i);
  }

  clear(): void {
    this.seedHead = this.seedTail = 0;
  }

  private ensure(n: number): void {
    if (this.stack.length < n) {
      const s = new Int32Array(Math.max(n, this.stack.length * 2));
      s.set(this.stack);
      this.stack = s;
    }
    if (this.visited.length < n) {
      const v = new Int32Array(Math.max(n, this.visited.length * 2));
      v.set(this.visited);
      this.visited = v;
    }
  }

  /**
   * Process queued seeds for at most `budgetMs`. Returns the components that lost their
   * connection to the ground. Their voxels are still in the grid; the caller removes them.
   */
  solve(budgetMs: number, out: DetachedComponent[] = []): DetachedComponent[] {
    if (this.seedHead === this.seedTail) return out;
    const g = this.grid;
    const { data, strideZ, strideY, nx, nz, ny } = g;
    const start = performance.now();
    const groundedStart = 0;
    this.visitedCount = 0;
    let processed = 0;
    while (this.seedHead !== this.seedTail) {
      const seed = this.seeds[this.seedHead];
      this.seedHead = (this.seedHead + 1) % this.seeds.length;
      const sv = data[seed];
      if ((sv & MAT_MASK) === 0 || sv & (FLAG_GROUNDED | FLAG_VISIT)) continue;
      const sy = (seed / strideY) | 0;
      if (sy < GROUND_Y) continue;

      const first = this.visitedCount;
      let sp = 0;
      this.ensure(first + 8);
      this.stack[sp++] = seed;
      data[seed] |= FLAG_VISIT;
      this.visited[this.visitedCount++] = seed;
      let grounded = false;
      let aborted = false;
      while (sp > 0) {
        const i = this.stack[--sp];
        const y = (i / strideY) | 0;
        const rem = i - y * strideY;
        const z = (rem / strideZ) | 0;
        const x = rem - z * strideZ;
        if (y === GROUND_Y && data[i - strideY] & MAT_MASK) {
          grounded = true;
          break;
        }
        if (this.visitedCount + 8 > this.visited.length || sp + 8 > this.stack.length) this.ensure(this.visited.length * 2);
        if (this.visitedCount - first > MAX_COMPONENT) {
          aborted = true;
          break;
        }
        let n: number;
        let v: number;
        // order matters: the downward neighbour is pushed last so it is explored first
        if (y + 1 < ny) {
          n = i + strideY;
          v = data[n];
          if (v & MAT_MASK) {
            if (v & FLAG_GROUNDED) { grounded = true; break; }
            if (!(v & FLAG_VISIT)) { data[n] = v | FLAG_VISIT; this.visited[this.visitedCount++] = n; this.stack[sp++] = n; }
          }
        }
        if (x > 0) {
          n = i - 1;
          v = data[n];
          if (v & MAT_MASK) {
            if (v & FLAG_GROUNDED) { grounded = true; break; }
            if (!(v & FLAG_VISIT)) { data[n] = v | FLAG_VISIT; this.visited[this.visitedCount++] = n; this.stack[sp++] = n; }
          }
        }
        if (x < nx - 1) {
          n = i + 1;
          v = data[n];
          if (v & MAT_MASK) {
            if (v & FLAG_GROUNDED) { grounded = true; break; }
            if (!(v & FLAG_VISIT)) { data[n] = v | FLAG_VISIT; this.visited[this.visitedCount++] = n; this.stack[sp++] = n; }
          }
        }
        if (z > 0) {
          n = i - strideZ;
          v = data[n];
          if (v & MAT_MASK) {
            if (v & FLAG_GROUNDED) { grounded = true; break; }
            if (!(v & FLAG_VISIT)) { data[n] = v | FLAG_VISIT; this.visited[this.visitedCount++] = n; this.stack[sp++] = n; }
          }
        }
        if (z < nz - 1) {
          n = i + strideZ;
          v = data[n];
          if (v & MAT_MASK) {
            if (v & FLAG_GROUNDED) { grounded = true; break; }
            if (!(v & FLAG_VISIT)) { data[n] = v | FLAG_VISIT; this.visited[this.visitedCount++] = n; this.stack[sp++] = n; }
          }
        }
        if (y > GROUND_Y) {
          n = i - strideY;
          v = data[n];
          if (v & MAT_MASK) {
            if (v & FLAG_GROUNDED) { grounded = true; break; }
            if (!(v & FLAG_VISIT)) { data[n] = v | FLAG_VISIT; this.visited[this.visitedCount++] = n; this.stack[sp++] = n; }
          }
        }
      }

      if (grounded || aborted) {
        // everything reached in this search is connected to the ground
        for (let k = first; k < this.visitedCount; k++) data[this.visited[k]] = (data[this.visited[k]] & ~FLAG_VISIT) | FLAG_GROUNDED;
      } else {
        const count = this.visitedCount - first;
        const indices = this.visited.slice(first, this.visitedCount);
        let minX = nx, minY = ny, minZ = nz, maxX = 0, maxY = 0, maxZ = 0, mass = 0;
        for (let k = 0; k < count; k++) {
          const i = indices[k];
          mass += MAT_MASS[data[i] & MAT_MASK];
          data[i] &= ~FLAG_VISIT;
          const y = (i / strideY) | 0;
          const rem = i - y * strideY;
          const z = (rem / strideZ) | 0;
          const x = rem - z * strideZ;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
        // mark as grounded for the rest of this pass so later seeds skip it (the caller removes the voxels)
        for (let k = 0; k < count; k++) data[indices[k]] |= FLAG_GROUNDED;
        out.push({ indices, min: [minX, minY, minZ], max: [maxX, maxY, maxZ], mass });
        // keep them in `visited` so the flag is cleared below
      }
      if ((++processed & 15) === 0 && performance.now() - start > budgetMs) break;
    }
    for (let k = groundedStart; k < this.visitedCount; k++) data[this.visited[k]] &= ~(FLAG_GROUNDED | FLAG_VISIT);
    this.lastVisited = this.visitedCount;
    this.visitedCount = 0;
    return out;
  }

  /**
   * Traverse the whole structure containing `seed` and evaluate every horizontal slice.
   * Returns null when the seed is empty, below ground, or not attached to the ground.
   */
  analyze(seed: number): LoadReport | null {
    const g = this.grid;
    const { data, strideZ, strideY, nx, nz, ny } = g;
    if ((data[seed] & MAT_MASK) === 0) return null;
    if (((seed / strideY) | 0) < GROUND_Y) return null;
    const { lMass, lCap, lMx, lMz, lMinX, lMaxX, lMinZ, lMaxZ, lCount } = this;
    lMass.fill(0);
    lCap.fill(0);
    lMx.fill(0);
    lMz.fill(0);
    lCount.fill(0);
    lMinX.fill(nx);
    lMinZ.fill(nz);
    lMaxX.fill(-1);
    lMaxZ.fill(-1);
    this.visitedCount = 0;
    let sp = 0;
    this.stack[sp++] = seed;
    data[seed] |= FLAG_VISIT;
    this.visited[this.visitedCount++] = seed;
    let anchored = false;
    let total = 0;
    let top = 0;
    let aborted = false;
    while (sp > 0) {
      const i = this.stack[--sp];
      const y = (i / strideY) | 0;
      const rem = i - y * strideY;
      const z = (rem / strideZ) | 0;
      const x = rem - z * strideZ;
      const m = data[i] & MAT_MASK;
      const mass = MAT_MASS[m];
      total += mass;
      lMass[y] += mass;
      lCap[y] += MAT_STRENGTH[m];
      lMx[y] += mass * x;
      lMz[y] += mass * z;
      lCount[y]++;
      if (x < lMinX[y]) lMinX[y] = x;
      if (x > lMaxX[y]) lMaxX[y] = x;
      if (z < lMinZ[y]) lMinZ[y] = z;
      if (z > lMaxZ[y]) lMaxZ[y] = z;
      if (y > top) top = y;
      if (this.visitedCount + 8 > this.visited.length || sp + 8 > this.stack.length) this.ensure(this.visited.length * 2);
      if (this.visitedCount > MAX_COMPONENT) {
        aborted = true;
        break;
      }
      const onGround = y === GROUND_Y && (data[i - strideY] & MAT_MASK) !== 0;
      if (onGround) anchored = true;
      let n: number;
      if (y + 1 < ny) {
        n = i + strideY;
        if (data[n] & MAT_MASK && !(data[n] & FLAG_VISIT)) { data[n] |= FLAG_VISIT; this.visited[this.visitedCount++] = n; this.stack[sp++] = n; }
      }
      // A voxel resting on the terrain is a foundation: do not spread sideways through
      // it, otherwise pavements would merge every structure in the district into one.
      if (onGround) continue;
      if (x > 0) {
        n = i - 1;
        if (data[n] & MAT_MASK && !(data[n] & FLAG_VISIT)) { data[n] |= FLAG_VISIT; this.visited[this.visitedCount++] = n; this.stack[sp++] = n; }
      }
      if (x < nx - 1) {
        n = i + 1;
        if (data[n] & MAT_MASK && !(data[n] & FLAG_VISIT)) { data[n] |= FLAG_VISIT; this.visited[this.visitedCount++] = n; this.stack[sp++] = n; }
      }
      if (z > 0) {
        n = i - strideZ;
        if (data[n] & MAT_MASK && !(data[n] & FLAG_VISIT)) { data[n] |= FLAG_VISIT; this.visited[this.visitedCount++] = n; this.stack[sp++] = n; }
      }
      if (z < nz - 1) {
        n = i + strideZ;
        if (data[n] & MAT_MASK && !(data[n] & FLAG_VISIT)) { data[n] |= FLAG_VISIT; this.visited[this.visitedCount++] = n; this.stack[sp++] = n; }
      }
      if (y > GROUND_Y) {
        n = i - strideY;
        if (data[n] & MAT_MASK && !(data[n] & FLAG_VISIT)) { data[n] |= FLAG_VISIT; this.visited[this.visitedCount++] = n; this.stack[sp++] = n; }
      }
    }
    const count = this.visitedCount;
    let report: LoadReport | null = null;
    if (anchored && !aborted) {
      let M = 0;
      let Mx = 0;
      let Mz = 0;
      let worst = 0;
      let worstLevel = -1;
      let worstKind: 'crush' | 'topple' = 'crush';
      let worstMass = 0;
      for (let y = top; y >= GROUND_Y; y--) {
        if (lCount[y] > 0 && M > 0) {
          const cap = lCap[y];
          const crush = M / cap;
          const cx = (lMinX[y] + lMaxX[y] + 1) / 2;
          const cz = (lMinZ[y] + lMaxZ[y] + 1) / 2;
          const hx = (lMaxX[y] - lMinX[y] + 1) / 2;
          const hz = (lMaxZ[y] - lMinZ[y] + 1) / 2;
          const spare = BEND * (cap / M);
          const ox = Math.abs(Mx / M + 0.5 - cx) / (hx * (1 + spare) + 1);
          const oz = Math.abs(Mz / M + 0.5 - cz) / (hz * (1 + spare) + 1);
          const topple = Math.max(ox, oz);
          const s = Math.max(crush, topple);
          if (s > worst) {
            worst = s;
            worstLevel = y;
            worstKind = crush >= topple ? 'crush' : 'topple';
            worstMass = M;
          }
        }
        M += lMass[y];
        Mx += lMx[y];
        Mz += lMz[y];
      }
      let failure: LoadFailure | null = null;
      if (worst > 1 && worstLevel >= 0) {
        const lo = worstLevel * strideY;
        const hi = lo + strideY;
        let n = 0;
        for (let k = 0; k < count; k++) {
          const i = this.visited[k];
          if (i >= lo && i < hi) n++;
        }
        const indices = new Int32Array(n);
        n = 0;
        for (let k = 0; k < count; k++) {
          const i = this.visited[k];
          if (i >= lo && i < hi) indices[n++] = i;
        }
        failure = {
          kind: worstKind,
          level: worstLevel,
          severity: worst,
          indices,
          massAbove: worstMass,
          cx: (lMinX[worstLevel] + lMaxX[worstLevel] + 1) / 2,
          cz: (lMinZ[worstLevel] + lMaxZ[worstLevel] + 1) / 2,
        };
      }
      report = { voxels: count, mass: total, worst, worstLevel, kind: worstKind, failure };
    }
    for (let k = 0; k < count; k++) data[this.visited[k]] &= ~FLAG_VISIT;
    this.visitedCount = 0;
    return report;
  }

  /**
   * Generation-time cleanup: delete everything that is not connected to the ground so the
   * first shot never dislodges geometry that was floating from the start. Returns the
   * number of voxels removed.
   */
  removeFloating(): number {
    const g = this.grid;
    const { data, strideZ, strideY, nx, nz, ny } = g;
    // flood from every foundation voxel
    let sp = 0;
    this.ensure(1 << 20);
    const push = (n: number) => {
      if (sp + 2 > this.stack.length) this.ensure(this.stack.length * 2);
      data[n] |= FLAG_GROUNDED;
      this.stack[sp++] = n;
    };
    const base = GROUND_Y * strideY;
    for (let k = 0; k < strideY; k++) {
      const i = base + k;
      if (data[i] & MAT_MASK && data[i - strideY] & MAT_MASK) push(i);
    }
    while (sp > 0) {
      const i = this.stack[--sp];
      const y = (i / strideY) | 0;
      const rem = i - y * strideY;
      const z = (rem / strideZ) | 0;
      const x = rem - z * strideZ;
      let n: number;
      if (y + 1 < ny && data[(n = i + strideY)] & MAT_MASK && !(data[n] & FLAG_GROUNDED)) push(n);
      if (y > GROUND_Y && data[(n = i - strideY)] & MAT_MASK && !(data[n] & FLAG_GROUNDED)) push(n);
      if (x > 0 && data[(n = i - 1)] & MAT_MASK && !(data[n] & FLAG_GROUNDED)) push(n);
      if (x < nx - 1 && data[(n = i + 1)] & MAT_MASK && !(data[n] & FLAG_GROUNDED)) push(n);
      if (z > 0 && data[(n = i - strideZ)] & MAT_MASK && !(data[n] & FLAG_GROUNDED)) push(n);
      if (z < nz - 1 && data[(n = i + strideZ)] & MAT_MASK && !(data[n] & FLAG_GROUNDED)) push(n);
    }
    let removed = 0;
    for (let i = base; i < data.length; i++) {
      const v = data[i];
      if ((v & MAT_MASK) === 0) continue;
      if (v & FLAG_GROUNDED) data[i] = v & ~FLAG_GROUNDED;
      else {
        data[i] = 0;
        removed++;
      }
    }
    return removed;
  }
}
