/**
 * Greedy voxel mesher with baked ambient occlusion, plus the helpers that turn voxel
 * volumes into physics shapes (box decomposition, connected-component labelling).
 *
 * Works on a padded copy of the volume (one voxel of border on every side) so the same
 * code meshes world chunks and free-flying debris bodies. No Three.js dependency: this
 * module also runs inside the world-generation worker.
 */
import { MAT_COLLIDE, MAT_FLAGS, MAT_OPAQUE, F_TRANSPARENT, M, MAT_COUNT } from '../world/Materials';
import { CHUNK, MAT_MASK, type VoxelGrid } from './VoxelGrid';

export interface MeshData {
  /** Voxel-unit vertex positions, 3 bytes per vertex. */
  positions: Uint8Array;
  /** Axis normals (±127), 3 bytes per vertex. */
  normals: Int8Array;
  /** Per vertex: material id, ambient occlusion (0..255), damage level (0..255), unused. */
  data: Uint8Array;
  indices: Uint16Array | Uint32Array;
}

export interface VolumeMesh {
  opaque: MeshData | null;
  glass: MeshData | null;
}

const TRANSPARENT = new Uint8Array(MAT_COUNT);
for (let i = 0; i < MAT_COUNT; i++) TRANSPARENT[i] = MAT_FLAGS[i] & F_TRANSPARENT ? 1 : 0;

class Builder {
  pos = new Uint8Array(4096 * 12);
  nor = new Int8Array(4096 * 12);
  dat = new Uint8Array(4096 * 16);
  idx = new Uint32Array(4096 * 6);
  quads = 0;

  reset(): void {
    this.quads = 0;
  }

  private grow(): void {
    const cap = (this.pos.length / 12) * 2;
    const pos = new Uint8Array(cap * 12);
    pos.set(this.pos);
    this.pos = pos;
    const nor = new Int8Array(cap * 12);
    nor.set(this.nor);
    this.nor = nor;
    const dat = new Uint8Array(cap * 16);
    dat.set(this.dat);
    this.dat = dat;
    const idx = new Uint32Array(cap * 6);
    idx.set(this.idx);
    this.idx = idx;
  }

  /** Append one quad. c = 4 corner positions (x,y,z each), ao = 4 corner AO values 0..3. */
  quad(c: Int32Array, axis: number, sign: number, mat: number, ao0: number, ao1: number, ao2: number, ao3: number, dmg: number): void {
    if ((this.quads + 1) * 12 > this.pos.length) this.grow();
    const q = this.quads++;
    const p = q * 12;
    const d = q * 16;
    const { pos, nor, dat, idx } = this;
    for (let k = 0; k < 12; k++) pos[p + k] = c[k];
    const nv = sign > 0 ? 127 : -127;
    for (let k = 0; k < 4; k++) {
      nor[p + k * 3] = axis === 0 ? nv : 0;
      nor[p + k * 3 + 1] = axis === 1 ? nv : 0;
      nor[p + k * 3 + 2] = axis === 2 ? nv : 0;
      dat[d + k * 4] = mat;
      dat[d + k * 4 + 2] = dmg * 85;
      dat[d + k * 4 + 3] = 0;
    }
    dat[d + 1] = ao0 * 85;
    dat[d + 5] = ao1 * 85;
    dat[d + 9] = ao2 * 85;
    dat[d + 13] = ao3 * 85;
    const v = q * 4;
    const i = q * 6;
    // pick the diagonal that keeps the AO gradient symmetric
    if (ao0 + ao3 > ao1 + ao2) {
      if (sign > 0) {
        idx[i] = v; idx[i + 1] = v + 1; idx[i + 2] = v + 3; idx[i + 3] = v; idx[i + 4] = v + 3; idx[i + 5] = v + 2;
      } else {
        idx[i] = v; idx[i + 1] = v + 3; idx[i + 2] = v + 1; idx[i + 3] = v; idx[i + 4] = v + 2; idx[i + 5] = v + 3;
      }
    } else if (sign > 0) {
      idx[i] = v; idx[i + 1] = v + 1; idx[i + 2] = v + 2; idx[i + 3] = v + 1; idx[i + 4] = v + 3; idx[i + 5] = v + 2;
    } else {
      idx[i] = v; idx[i + 1] = v + 2; idx[i + 2] = v + 1; idx[i + 3] = v + 1; idx[i + 4] = v + 2; idx[i + 5] = v + 3;
    }
  }

  finish(): MeshData | null {
    const q = this.quads;
    if (q === 0) return null;
    const nv = q * 4;
    return {
      positions: this.pos.slice(0, q * 12),
      normals: this.nor.slice(0, q * 12),
      data: this.dat.slice(0, q * 16),
      indices: nv > 65535 ? this.idx.slice(0, q * 6) : new Uint16Array(this.idx.subarray(0, q * 6)),
    };
  }
}

const opaqueBuilder = new Builder();
const glassBuilder = new Builder();
let mask = new Int32Array(CHUNK * CHUNK);
const corner = new Int32Array(12);

/**
 * Mesh a padded volume.
 * @param pad  material ids, dimensions (sx+2)(sy+2)(sz+2), index = (x+1) + (sx+2)*((z+1) + (sz+2)*(y+1))
 * @param dpad optional damage levels (0..3) with the same layout
 * @param ox   offset added to every emitted position (keeps textures continuous on debris)
 */
export function meshVolume(pad: Uint8Array, dpad: Uint8Array | null, sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0): VolumeMesh {
  const px = sx + 2;
  const pz = sz + 2;
  const dims = [sx, sy, sz];
  const strides = [1, px * pz, px];
  const base = 1 + px + px * pz;
  const off = [ox, oy, oz];
  opaqueBuilder.reset();
  glassBuilder.reset();
  const maxDim = Math.max(sx, sy, sz);
  if (mask.length < maxDim * maxDim) mask = new Int32Array(maxDim * maxDim);

  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3;
    const v = (a + 2) % 3;
    const sa = strides[a];
    const su = strides[u];
    const sv = strides[v];
    const da = dims[a];
    const du = dims[u];
    const dv = dims[v];
    for (let sign = 1; sign >= -1; sign -= 2) {
      const nOff = sign * sa;
      for (let k = 0; k < da; k++) {
        let any = false;
        // --- build the face mask for this slice
        for (let j = 0; j < dv; j++) {
          let p = base + k * sa + j * sv;
          let mi = j * du;
          for (let i = 0; i < du; i++, p += su, mi++) {
            const m = pad[p];
            if (m === 0) {
              mask[mi] = 0;
              continue;
            }
            const nb = pad[p + nOff];
            if (MAT_OPAQUE[m]) {
              if (MAT_OPAQUE[nb]) {
                mask[mi] = 0;
                continue;
              }
              const q = p + nOff;
              const s1 = MAT_OPAQUE[pad[q - su]];
              const s2 = MAT_OPAQUE[pad[q + su]];
              const s3 = MAT_OPAQUE[pad[q - sv]];
              const s4 = MAT_OPAQUE[pad[q + sv]];
              const a00 = s1 && s3 ? 0 : 3 - (s1 + s3 + MAT_OPAQUE[pad[q - su - sv]]);
              const a10 = s2 && s3 ? 0 : 3 - (s2 + s3 + MAT_OPAQUE[pad[q + su - sv]]);
              const a01 = s1 && s4 ? 0 : 3 - (s1 + s4 + MAT_OPAQUE[pad[q - su + sv]]);
              const a11 = s2 && s4 ? 0 : 3 - (s2 + s4 + MAT_OPAQUE[pad[q + su + sv]]);
              const dl = dpad ? dpad[p] : 0;
              mask[mi] = m | ((a00 | (a10 << 2) | (a01 << 4) | (a11 << 6)) << 5) | (dl << 13);
              any = true;
            } else if (TRANSPARENT[m]) {
              if (nb !== 0) {
                mask[mi] = 0;
                continue;
              }
              mask[mi] = m | (255 << 5) | (1 << 15);
              any = true;
            } else {
              mask[mi] = 0;
            }
          }
        }
        if (!any) continue;
        // --- greedy merge
        const plane = k + (sign > 0 ? 1 : 0);
        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du; ) {
            const key = mask[j * du + i];
            if (key === 0) {
              i++;
              continue;
            }
            let w = 1;
            while (i + w < du && mask[j * du + i + w] === key) w++;
            let h = 1;
            outer: while (j + h < dv) {
              const row = (j + h) * du + i;
              for (let t = 0; t < w; t++) if (mask[row + t] !== key) break outer;
              h++;
            }
            for (let hh = 0; hh < h; hh++) {
              const row = (j + hh) * du + i;
              for (let t = 0; t < w; t++) mask[row + t] = 0;
            }
            // corners: v0=(i,j) v1=(i+w,j) v2=(i,j+h) v3=(i+w,j+h)
            for (let c = 0; c < 4; c++) {
              const o = c * 3;
              corner[o + a] = plane + off[a];
              corner[o + u] = i + (c & 1 ? w : 0) + off[u];
              corner[o + v] = j + (c & 2 ? h : 0) + off[v];
            }
            const ao = (key >> 5) & 255;
            const b = key & (1 << 15) ? glassBuilder : opaqueBuilder;
            b.quad(corner, a, sign, key & MAT_MASK, ao & 3, (ao >> 2) & 3, (ao >> 4) & 3, (ao >> 6) & 3, (key >> 13) & 3);
            i += w;
          }
        }
      }
    }
  }
  return { opaque: opaqueBuilder.finish(), glass: glassBuilder.finish() };
}

// ---------------------------------------------------------------------------
// Chunk padding
// ---------------------------------------------------------------------------
const PAD = CHUNK + 2;
export const chunkPad = new Uint8Array(PAD * PAD * PAD);
export const chunkDamagePad = new Uint8Array(PAD * PAD * PAD);

/**
 * Copy a chunk plus its one-voxel border into `chunkPad`. Returns the number of solid
 * voxels inside the chunk proper (0 → nothing to mesh). Fills `chunkDamagePad` and
 * returns hasDamage=true when cracked voxels are present.
 */
export function fillChunkPad(grid: VoxelGrid, cx: number, cy: number, cz: number, hpTable: Float32Array): { solid: number; hasDamage: boolean } {
  const { nx, ny, nz, data, strideZ, strideY } = grid;
  const x0 = cx * CHUNK - 1;
  const y0 = cy * CHUNK - 1;
  const z0 = cz * CHUNK - 1;
  let solid = 0;
  let p = 0;
  for (let y = 0; y < PAD; y++) {
    const wy = y0 + y;
    for (let z = 0; z < PAD; z++) {
      const wz = z0 + z;
      if (wy < 0) {
        // below the world: opaque, so the underside of the terrain is never meshed
        chunkPad.fill(M.Bedrock, p, p + PAD);
        p += PAD;
        continue;
      }
      if (wy >= ny || wz < 0 || wz >= nz) {
        chunkPad.fill(0, p, p + PAD);
        p += PAD;
        continue;
      }
      const row = strideZ * wz + strideY * wy;
      const inner = y > 0 && y < PAD - 1 && z > 0 && z < PAD - 1;
      for (let x = 0; x < PAD; x++, p++) {
        const wx = x0 + x;
        if (wx < 0 || wx >= nx) {
          chunkPad[p] = 0;
          continue;
        }
        const m = data[row + wx] & MAT_MASK;
        chunkPad[p] = m;
        if (m !== 0 && inner && x > 0 && x < PAD - 1) solid++;
      }
    }
  }
  let hasDamage = false;
  if (solid > 0 && grid.damage.size > 0) {
    // sparse pass over the damage map is cheaper than probing every voxel
    const cx0 = cx * CHUNK;
    const cy0 = cy * CHUNK;
    const cz0 = cz * CHUNK;
    for (const [i, dmg] of grid.damage) {
      const y = (i / strideY) | 0;
      if (y < cy0 || y >= cy0 + CHUNK) continue;
      const rem = i - y * strideY;
      const z = (rem / strideZ) | 0;
      if (z < cz0 || z >= cz0 + CHUNK) continue;
      const x = rem - z * strideZ;
      if (x < cx0 || x >= cx0 + CHUNK) continue;
      if (!hasDamage) {
        chunkDamagePad.fill(0);
        hasDamage = true;
      }
      const m = data[i] & MAT_MASK;
      const level = Math.min(3, 1 + Math.floor((dmg / hpTable[m]) * 3));
      chunkDamagePad[x - cx0 + 1 + PAD * (z - cz0 + 1 + PAD * (y - cy0 + 1))] = level;
    }
  }
  return { solid, hasDamage };
}

/** Pad an arbitrary local volume (index = x + sx*(z + sz*y)) for meshing. */
export function padVolume(vox: Uint8Array, sx: number, sy: number, sz: number): Uint8Array {
  const px = sx + 2;
  const pz = sz + 2;
  const pad = new Uint8Array(px * pz * (sy + 2));
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++) {
      const src = sx * (z + sz * y);
      pad.set(vox.subarray(src, src + sx), 1 + px * (z + 1 + pz * (y + 1)));
    }
  return pad;
}

// ---------------------------------------------------------------------------
// Physics shape helpers
// ---------------------------------------------------------------------------
/** Axis-aligned box in voxel units, max exclusive. */
export type VBox = [number, number, number, number, number, number];

function greedyBoxes(occ: Uint8Array, sx: number, sy: number, sz: number, limit: number): VBox[] | null {
  const used = new Uint8Array(occ.length);
  const boxes: VBox[] = [];
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const i = x + sx * (z + sz * y);
        if (!occ[i] || used[i]) continue;
        let x1 = x + 1;
        while (x1 < sx && occ[i + x1 - x] && !used[i + x1 - x]) x1++;
        let z1 = z + 1;
        growZ: while (z1 < sz) {
          const r = sx * (z1 + sz * y);
          for (let xx = x; xx < x1; xx++) if (!occ[r + xx] || used[r + xx]) break growZ;
          z1++;
        }
        let y1 = y + 1;
        growY: while (y1 < sy) {
          for (let zz = z; zz < z1; zz++) {
            const r = sx * (zz + sz * y1);
            for (let xx = x; xx < x1; xx++) if (!occ[r + xx] || used[r + xx]) break growY;
          }
          y1++;
        }
        for (let yy = y; yy < y1; yy++)
          for (let zz = z; zz < z1; zz++) {
            const r = sx * (zz + sz * yy);
            used.fill(1, r + x, r + x1);
          }
        boxes.push([x, y, z, x1, y1, z1]);
        if (boxes.length > limit) return null;
      }
  return boxes;
}

/**
 * Approximate the collidable voxels of a volume with at most `maxBoxes` boxes.
 * Tries an exact decomposition first, then progressively coarser occupancy grids whose
 * boxes are shrunk back to the real voxel extents (so thin walls stay thin).
 */
export function decomposeBoxes(vox: Uint8Array, sx: number, sy: number, sz: number, maxBoxes: number): VBox[] {
  const occ = new Uint8Array(vox.length);
  let count = 0;
  for (let i = 0; i < vox.length; i++) if (MAT_COLLIDE[vox[i] & MAT_MASK]) (occ[i] = 1), count++;
  if (count === 0) return [];
  const exact = greedyBoxes(occ, sx, sy, sz, maxBoxes);
  if (exact) return exact;
  for (let f = 2; f <= 64; f = f < 8 ? f + 1 : f * 2) {
    const cx = Math.ceil(sx / f);
    const cy = Math.ceil(sy / f);
    const cz = Math.ceil(sz / f);
    const coarse = new Uint8Array(cx * cy * cz);
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++) if (occ[x + sx * (z + sz * y)]) coarse[((x / f) | 0) + cx * (((z / f) | 0) + cz * ((y / f) | 0))] = 1;
    const cb = greedyBoxes(coarse, cx, cy, cz, maxBoxes);
    if (!cb) continue;
    const out: VBox[] = [];
    for (const b of cb) {
      let x0 = sx, y0 = sy, z0 = sz, x1 = -1, y1 = -1, z1 = -1;
      const ex = Math.min(sx, b[3] * f), ey = Math.min(sy, b[4] * f), ez = Math.min(sz, b[5] * f);
      for (let y = b[1] * f; y < ey; y++)
        for (let z = b[2] * f; z < ez; z++)
          for (let x = b[0] * f; x < ex; x++)
            if (occ[x + sx * (z + sz * y)]) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
              if (z < z0) z0 = z;
              if (z > z1) z1 = z;
            }
      if (x1 >= 0) out.push([x0, y0, z0, x1 + 1, y1 + 1, z1 + 1]);
    }
    return out;
  }
  return [[0, 0, 0, sx, sy, sz]];
}

/**
 * 6-connected component labelling of a local volume. Returns labels (0 = empty,
 * 1..n) and the voxel count of each component.
 */
export function labelComponents(vox: Uint8Array, sx: number, sy: number, sz: number): { labels: Uint16Array; counts: number[] } {
  const labels = new Uint16Array(vox.length);
  const counts: number[] = [0];
  const stack = new Int32Array(vox.length);
  const sxz = sx * sz;
  let next = 0;
  for (let start = 0; start < vox.length; start++) {
    if (!(vox[start] & MAT_MASK) || labels[start]) continue;
    const id = ++next;
    let sp = 0;
    let n = 0;
    stack[sp++] = start;
    labels[start] = id;
    while (sp > 0) {
      const i = stack[--sp];
      n++;
      const y = (i / sxz) | 0;
      const rem = i - y * sxz;
      const z = (rem / sx) | 0;
      const x = rem - z * sx;
      if (x > 0 && vox[i - 1] & MAT_MASK && !labels[i - 1]) (labels[i - 1] = id), (stack[sp++] = i - 1);
      if (x < sx - 1 && vox[i + 1] & MAT_MASK && !labels[i + 1]) (labels[i + 1] = id), (stack[sp++] = i + 1);
      if (z > 0 && vox[i - sx] & MAT_MASK && !labels[i - sx]) (labels[i - sx] = id), (stack[sp++] = i - sx);
      if (z < sz - 1 && vox[i + sx] & MAT_MASK && !labels[i + sx]) (labels[i + sx] = id), (stack[sp++] = i + sx);
      if (y > 0 && vox[i - sxz] & MAT_MASK && !labels[i - sxz]) (labels[i - sxz] = id), (stack[sp++] = i - sxz);
      if (y < sy - 1 && vox[i + sxz] & MAT_MASK && !labels[i + sxz]) (labels[i + sxz] = id), (stack[sp++] = i + sxz);
    }
    counts.push(n);
    if (next >= 65535) break;
  }
  return { labels, counts };
}
