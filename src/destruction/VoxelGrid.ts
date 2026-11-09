/**
 * Dense voxel storage for the whole district.
 *
 * One byte per voxel: low 5 bits = material id, high 3 bits = transient flags used by
 * the structural solver and the fire system. Keeping the flags in the same byte avoids a
 * second world-sized array. Chunks exist only as a dirty-tracking / meshing subdivision.
 */
import { INV_VOXEL, MAT_COLLIDE, VOXEL } from '../world/Materials';

export const CHUNK = 32;
export const CHUNK_SHIFT = 5;
export const MAT_MASK = 31;
export const FLAG_VISIT = 32;
export const FLAG_GROUNDED = 64;
export const FLAG_BURN = 128;
/** Index of the first voxel layer above the terrain. Everything below is "ground". */
export const GROUND_Y = 8;

export interface VoxelHooks {
  removed(x: number, y: number, z: number): void;
  added(x: number, y: number, z: number): void;
}

export interface VoxelRayHit {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  /** Metres along the ray. */
  dist: number;
  mat: number;
  index: number;
}

export const makeRayHit = (): VoxelRayHit => ({ x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, dist: 0, mat: 0, index: -1 });

export class VoxelGrid {
  readonly data: Uint8Array;
  readonly strideZ: number;
  readonly strideY: number;
  readonly cnx: number;
  readonly cny: number;
  readonly cnz: number;
  /** Accumulated damage (hit points lost) of voxels that are cracked but not destroyed. */
  readonly damage = new Map<number, number>();
  readonly chunkDirty: Uint8Array;
  readonly dirtyChunks: number[] = [];
  hooks: VoxelHooks | null = null;
  /** Bumped on every voxel change. */
  version = 0;
  /** Total voxels removed since the last reset. */
  removedTotal = 0;

  constructor(readonly nx: number, readonly ny: number, readonly nz: number, data?: Uint8Array) {
    this.strideZ = nx;
    this.strideY = nx * nz;
    this.data = data ?? new Uint8Array(nx * ny * nz);
    this.cnx = Math.ceil(nx / CHUNK);
    this.cny = Math.ceil(ny / CHUNK);
    this.cnz = Math.ceil(nz / CHUNK);
    this.chunkDirty = new Uint8Array(this.cnx * this.cny * this.cnz);
  }

  index(x: number, y: number, z: number): number {
    return x + this.strideZ * z + this.strideY * y;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz;
  }

  /** Material id at voxel coordinates (0 outside the world). */
  mat(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return 0;
    return this.data[x + this.strideZ * z + this.strideY * y] & MAT_MASK;
  }

  /** Generator-time write: no hooks, no dirty tracking. */
  setRaw(x: number, y: number, z: number, m: number): void {
    if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return;
    this.data[x + this.strideZ * z + this.strideY * y] = m;
  }

  /** Generator-time inclusive box fill. */
  fillRaw(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number): void {
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    if (z0 > z1) [z0, z1] = [z1, z0];
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    z0 = Math.max(0, z0);
    x1 = Math.min(this.nx - 1, x1);
    y1 = Math.min(this.ny - 1, y1);
    z1 = Math.min(this.nz - 1, z1);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        const row = this.strideZ * z + this.strideY * y;
        this.data.fill(m, row + x0, row + x1 + 1);
      }
    }
  }

  coords(i: number, out: Int32Array | number[]): void {
    const y = (i / this.strideY) | 0;
    const rem = i - y * this.strideY;
    const z = (rem / this.strideZ) | 0;
    out[0] = rem - z * this.strideZ;
    out[1] = y;
    out[2] = z;
  }

  /** Runtime removal. Returns the material that was removed (0 if already empty). */
  remove(i: number): number {
    const old = this.data[i] & MAT_MASK;
    if (old === 0) return 0;
    this.data[i] = 0;
    if (this.damage.size) this.damage.delete(i);
    const y = (i / this.strideY) | 0;
    const rem = i - y * this.strideY;
    const z = (rem / this.strideZ) | 0;
    const x = rem - z * this.strideZ;
    this.markDirty(x, y, z);
    this.removedTotal++;
    this.version++;
    if (this.hooks) this.hooks.removed(x, y, z);
    return old;
  }

  /** Runtime placement into an empty cell (used when settled rubble is merged back into the world). */
  place(x: number, y: number, z: number, m: number): boolean {
    if (x < 0 || y < 1 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return false;
    const i = x + this.strideZ * z + this.strideY * y;
    if (this.data[i] & MAT_MASK) return false;
    this.data[i] = m;
    this.markDirty(x, y, z);
    this.version++;
    if (this.hooks) this.hooks.added(x, y, z);
    return true;
  }

  /** Replace the material of an existing voxel without changing solidity (e.g. wood → char). */
  retype(i: number, m: number): void {
    this.data[i] = (this.data[i] & ~MAT_MASK) | m;
    const y = (i / this.strideY) | 0;
    const rem = i - y * this.strideY;
    const z = (rem / this.strideZ) | 0;
    this.markDirty(rem - z * this.strideZ, y, z);
    this.version++;
  }

  chunkIndex(cx: number, cy: number, cz: number): number {
    return cx + this.cnx * (cz + this.cnz * cy);
  }

  /** Flag the chunk containing a voxel (and neighbours sharing its border, for AO) for re-meshing. */
  markDirty(x: number, y: number, z: number): void {
    const lx = x & 31;
    const ly = y & 31;
    const lz = z & 31;
    if (lx > 0 && lx < 31 && ly > 0 && ly < 31 && lz > 0 && lz < 31) {
      const c = (x >> 5) + this.cnx * ((z >> 5) + this.cnz * (y >> 5));
      if (!this.chunkDirty[c]) {
        this.chunkDirty[c] = 1;
        this.dirtyChunks.push(c);
      }
      return;
    }
    const cx0 = Math.max(0, (x - 1) >> 5);
    const cx1 = Math.min(this.cnx - 1, (x + 1) >> 5);
    const cy0 = Math.max(0, (y - 1) >> 5);
    const cy1 = Math.min(this.cny - 1, (y + 1) >> 5);
    const cz0 = Math.max(0, (z - 1) >> 5);
    const cz1 = Math.min(this.cnz - 1, (z + 1) >> 5);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cx + this.cnx * (cz + this.cnz * cy);
          if (!this.chunkDirty[c]) {
            this.chunkDirty[c] = 1;
            this.dirtyChunks.push(c);
          }
        }
  }

  /** True when the voxel containing a world-space point blocks movement. */
  solidAt(wx: number, wy: number, wz: number): boolean {
    const x = Math.floor(wx * INV_VOXEL);
    const y = Math.floor(wy * INV_VOXEL);
    const z = Math.floor(wz * INV_VOXEL);
    if (y < 0) return true;
    if (x < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return false;
    return MAT_COLLIDE[this.data[x + this.strideZ * z + this.strideY * y] & MAT_MASK] === 1;
  }

  matAtWorld(wx: number, wy: number, wz: number): number {
    return this.mat(Math.floor(wx * INV_VOXEL), Math.floor(wy * INV_VOXEL), Math.floor(wz * INV_VOXEL));
  }

  /**
   * World-space AABB vs solid voxels. The horizontal world border and everything below
   * y = 0 count as solid so nothing can leave the map.
   */
  boxCollides(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    const x0 = Math.floor(minX * INV_VOXEL);
    const y0 = Math.floor(minY * INV_VOXEL);
    const z0 = Math.floor(minZ * INV_VOXEL);
    const x1 = Math.floor(maxX * INV_VOXEL);
    const y1 = Math.min(this.ny - 1, Math.floor(maxY * INV_VOXEL));
    const z1 = Math.floor(maxZ * INV_VOXEL);
    if (x0 < 0 || z0 < 0 || x1 >= this.nx || z1 >= this.nz || y0 < 0) return true;
    const d = this.data;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        const row = this.strideZ * z + this.strideY * y;
        for (let x = x0; x <= x1; x++) {
          if (MAT_COLLIDE[d[row + x] & MAT_MASK]) return true;
        }
      }
    }
    return false;
  }

  /**
   * Amanatides–Woo traversal. Origin/direction in metres (direction normalised).
   * `skipMask` has bit m set for material ids the ray should pass through.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, skipMask: number, out: VoxelRayHit): boolean {
    const px = ox * INV_VOXEL;
    const py = oy * INV_VOXEL;
    const pz = oz * INV_VOXEL;
    let x = Math.floor(px);
    let y = Math.floor(py);
    let z = Math.floor(pz);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMX = dx !== 0 ? (dx > 0 ? x + 1 - px : px - x) * tDX : Infinity;
    let tMY = dy !== 0 ? (dy > 0 ? y + 1 - py : py - y) * tDY : Infinity;
    let tMZ = dz !== 0 ? (dz > 0 ? z + 1 - pz : pz - z) * tDZ : Infinity;
    const maxT = maxDist * INV_VOXEL;
    const { nx, ny, nz, data, strideZ, strideY } = this;
    let t = 0;
    let fx = 0;
    let fy = 0;
    let fz = 0;
    for (let guard = 0; guard < 4096; guard++) {
      if (x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz) {
        const i = x + strideZ * z + strideY * y;
        const m = data[i] & MAT_MASK;
        if (m !== 0 && ((skipMask >>> m) & 1) === 0) {
          out.x = x;
          out.y = y;
          out.z = z;
          out.nx = fx;
          out.ny = fy;
          out.nz = fz;
          out.dist = t * VOXEL;
          out.mat = m;
          out.index = i;
          if (fx === 0 && fy === 0 && fz === 0) {
            // started inside a voxel: report the face opposite to the dominant ray axis
            const ax = Math.abs(dx);
            const ay = Math.abs(dy);
            const az = Math.abs(dz);
            if (ax >= ay && ax >= az) out.nx = -stepX;
            else if (ay >= az) out.ny = -stepY;
            else out.nz = -stepZ;
          }
          return true;
        }
      } else if ((x < 0 && stepX < 0) || (y < 0 && stepY < 0) || (z < 0 && stepZ < 0) || (x >= nx && stepX > 0) || (y >= ny && stepY > 0) || (z >= nz && stepZ > 0)) {
        return false;
      }
      if (tMX < tMY && tMX < tMZ) {
        t = tMX;
        tMX += tDX;
        x += stepX;
        fx = -stepX;
        fy = 0;
        fz = 0;
      } else if (tMY < tMZ) {
        t = tMY;
        tMY += tDY;
        y += stepY;
        fx = 0;
        fy = -stepY;
        fz = 0;
      } else {
        t = tMZ;
        tMZ += tDZ;
        z += stepZ;
        fx = 0;
        fy = 0;
        fz = -stepZ;
      }
      if (t > maxT) return false;
    }
    return false;
  }

  /**
   * Coordinates of every collidable voxel that has at least one non-collidable neighbour.
   * Only these need to exist in the physics collider; interior voxels are added lazily as
   * they become exposed.
   */
  collectSurface(): Int32Array {
    const { nx, ny, nz, data, strideZ, strideY } = this;
    let cap = 1 << 20;
    let out = new Int32Array(cap);
    let n = 0;
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        const row = strideZ * z + strideY * y;
        for (let x = 0; x < nx; x++) {
          const i = row + x;
          if (!MAT_COLLIDE[data[i] & MAT_MASK]) continue;
          const exposed =
            x === 0 ||
            x === nx - 1 ||
            z === 0 ||
            z === nz - 1 ||
            y === ny - 1 ||
            !MAT_COLLIDE[data[i - 1] & MAT_MASK] ||
            !MAT_COLLIDE[data[i + 1] & MAT_MASK] ||
            !MAT_COLLIDE[data[i - strideZ] & MAT_MASK] ||
            !MAT_COLLIDE[data[i + strideZ] & MAT_MASK] ||
            !MAT_COLLIDE[data[i + strideY] & MAT_MASK] ||
            (y > 0 && !MAT_COLLIDE[data[i - strideY] & MAT_MASK]) ||
            // floors and ground get a three-voxel crust so fast, heavy debris cannot punch through a thin shell
            (y + 2 < ny && !MAT_COLLIDE[data[i + 2 * strideY] & MAT_MASK]) ||
            (y + 3 < ny && !MAT_COLLIDE[data[i + 3 * strideY] & MAT_MASK]);
          if (!exposed) continue;
          if (n + 3 > cap) {
            cap *= 2;
            const grown = new Int32Array(cap);
            grown.set(out);
            out = grown;
          }
          out[n++] = x;
          out[n++] = y;
          out[n++] = z;
        }
      }
    }
    return out.slice(0, n);
  }

  /** Coordinates (x,y,z triples) of every voxel that blocks movement. */
  collectSolid(): Int32Array {
    const { nx, ny, nz, data, strideZ, strideY } = this;
    let count = 0;
    for (let i = 0; i < data.length; i++) if (MAT_COLLIDE[data[i] & MAT_MASK]) count++;
    const out = new Int32Array(count * 3);
    let n = 0;
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++) {
        const row = strideZ * z + strideY * y;
        for (let x = 0; x < nx; x++) {
          if (!MAT_COLLIDE[data[row + x] & MAT_MASK]) continue;
          out[n++] = x;
          out[n++] = y;
          out[n++] = z;
        }
      }
    return out;
  }
}
