/**
 * Lightweight fragments: one InstancedMesh, a ring-buffer pool and a hand-written
 * ballistic integrator that collides against the voxel grid directly. No Rapier bodies,
 * so a thousand splinters cost one draw call and a few typed-array loops.
 */
import * as THREE from 'three';
import { Frag, MAT_COLOR, MAT_FRAG, VOXEL } from '../world/Materials';
import { GRAVITY, LIMITS } from '../world/config';
import type { VoxelGrid } from './VoxelGrid';

const FLYING = 1;
const RESTING = 2;

export class LightDebris {
  readonly capacity = LIMITS.maxLightDebris;
  readonly mesh: THREE.InstancedMesh;
  /** Instances currently alive. */
  active = 0;
  /** Upper bound enforced by the performance manager (≤ capacity). */
  limit: number = LIMITS.maxLightDebris;
  /** Called on a hard bounce: (material, x, y, z, speed). */
  onBounce: ((mat: number, x: number, y: number, z: number, speed: number) => void) | null = null;
  private cursor = 0;
  private frame = 0;
  private readonly state = new Uint8Array(this.capacity);
  private readonly mat = new Uint8Array(this.capacity);
  private readonly p = new Float32Array(this.capacity * 3);
  private readonly v = new Float32Array(this.capacity * 3);
  private readonly q = new Float32Array(this.capacity * 4);
  private readonly w = new Float32Array(this.capacity * 3);
  private readonly s = new Float32Array(this.capacity * 3);
  private readonly life = new Float32Array(this.capacity);
  private readonly drag = new Float32Array(this.capacity);
  private readonly matrices: Float32Array;

  constructor(scene: THREE.Scene, private readonly grid: () => VoxelGrid) {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, this.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.matrices = this.mesh.instanceMatrix.array as Float32Array;
    this.matrices.fill(0);
    const c = new THREE.Color(1, 1, 1);
    for (let i = 0; i < this.capacity; i++) this.mesh.setColorAt(i, c);
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  /** Spawn a fragment of the given material. Recycles the oldest instance when full. */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, mat: number, scale = 1): void {
    if (this.active >= this.limit && Math.random() < 0.5) return;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (!this.state[i]) this.active++;
    if (this.mesh.count < this.capacity && i >= this.mesh.count) this.mesh.count = i + 1;
    const style = MAT_FRAG[mat];
    let sx = VOXEL * (0.45 + Math.random() * 0.5);
    let sy = VOXEL * (0.4 + Math.random() * 0.45);
    let sz = VOXEL * (0.45 + Math.random() * 0.5);
    let drag = 0.15;
    let life = 14 + Math.random() * 12;
    if (style === Frag.Splinter) {
      sx = VOXEL * (0.9 + Math.random() * 1.6);
      sy = VOXEL * (0.12 + Math.random() * 0.14);
      sz = VOXEL * (0.14 + Math.random() * 0.2);
    } else if (style === Frag.Shard) {
      sx = VOXEL * (0.3 + Math.random() * 0.7);
      sy = VOXEL * 0.08;
      sz = VOXEL * (0.25 + Math.random() * 0.6);
      life = 9 + Math.random() * 8;
    } else if (style === Frag.Sheet) {
      sx = VOXEL * (0.5 + Math.random() * 0.8);
      sy = VOXEL * 0.1;
      sz = VOXEL * (0.4 + Math.random() * 0.7);
    } else if (style === Frag.Leaf) {
      sx = VOXEL * (0.25 + Math.random() * 0.3);
      sy = VOXEL * 0.05;
      sz = VOXEL * (0.25 + Math.random() * 0.3);
      drag = 3.2;
      life = 4 + Math.random() * 4;
    } else if (style === Frag.Dust) {
      sx *= 0.6;
      sy *= 0.6;
      sz *= 0.6;
      life = 6 + Math.random() * 5;
    }
    const o = i * 3;
    this.p[o] = x; this.p[o + 1] = y; this.p[o + 2] = z;
    this.v[o] = vx; this.v[o + 1] = vy; this.v[o + 2] = vz;
    this.s[o] = sx * scale; this.s[o + 1] = sy * scale; this.s[o + 2] = sz * scale;
    this.w[o] = (Math.random() - 0.5) * 16; this.w[o + 1] = (Math.random() - 0.5) * 16; this.w[o + 2] = (Math.random() - 0.5) * 16;
    // random unit quaternion
    const u1 = Math.random(), u2 = Math.random() * Math.PI * 2, u3 = Math.random() * Math.PI * 2;
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    const qo = i * 4;
    this.q[qo] = a * Math.sin(u2); this.q[qo + 1] = a * Math.cos(u2); this.q[qo + 2] = b * Math.sin(u3); this.q[qo + 3] = b * Math.cos(u3);
    this.state[i] = FLYING;
    this.mat[i] = mat;
    this.life[i] = life;
    this.drag[i] = drag;
    const shade = 0.78 + Math.random() * 0.34;
    const c = this.mesh.instanceColor!.array as Float32Array;
    c[o] = MAT_COLOR[mat * 3] * shade; c[o + 1] = MAT_COLOR[mat * 3 + 1] * shade; c[o + 2] = MAT_COLOR[mat * 3 + 2] * shade;
    this.mesh.instanceColor!.needsUpdate = true;
  }

  /** Radial kick from an explosion; wakes resting fragments. */
  impulse(x: number, y: number, z: number, radius: number, strength: number): void {
    const r2 = radius * radius;
    for (let i = 0; i < this.mesh.count; i++) {
      if (!this.state[i]) continue;
      const o = i * 3;
      const dx = this.p[o] - x, dy = this.p[o + 1] - y, dz = this.p[o + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) + 0.2;
      const k = (strength * (1 - d / (radius + 0.2))) / d;
      this.v[o] += dx * k; this.v[o + 1] += dy * k + strength * 0.25; this.v[o + 2] += dz * k;
      this.state[i] = FLYING;
      if (this.life[i] < 4) this.life[i] = 4;
    }
  }

  update(dt: number, viewer: THREE.Vector3): void {
    const grid = this.grid();
    const { p, v, q, w, s, state, life, matrices } = this;
    const n = this.mesh.count;
    this.frame++;
    let dirty = false;
    let alive = 0;
    for (let i = 0; i < n; i++) {
      const st = state[i];
      if (!st) continue;
      const o = i * 3;
      life[i] -= dt;
      if (life[i] <= 0) {
        state[i] = 0;
        matrices.fill(0, i * 16, i * 16 + 16);
        dirty = true;
        continue;
      }
      alive++;
      let write = false;
      if (st === FLYING) {
        const dx = p[o] - viewer.x, dz = p[o + 2] - viewer.z;
        if (dx * dx + dz * dz > 70 * 70) {
          // too far to matter: no simulation for distant decorative debris
          state[i] = 0;
          matrices.fill(0, i * 16, i * 16 + 16);
          dirty = true;
          alive--;
          continue;
        }
        const k = Math.max(0, 1 - this.drag[i] * dt);
        v[o] *= k; v[o + 2] *= k;
        v[o + 1] = v[o + 1] * k - GRAVITY * dt;
        if (this.drag[i] > 1 && v[o + 1] < -1.4) v[o + 1] = -1.4;
        const ox = p[o], oy = p[o + 1], oz = p[o + 2];
        let nx = ox + v[o] * dt, ny = oy + v[o + 1] * dt, nz = oz + v[o + 2] * dt;
        const half = s[o + 1] * 0.5 + 0.02;
        if (grid.solidAt(nx, ny - half, nz)) {
          const speed = Math.hypot(v[o], v[o + 1], v[o + 2]);
          let hitFloor = false;
          if (grid.solidAt(ox, ny - half, oz)) {
            hitFloor = v[o + 1] < 0;
            v[o + 1] *= -0.28;
            ny = oy;
            v[o] *= 0.62; v[o + 2] *= 0.62;
          }
          if (grid.solidAt(nx, ny - half, oz)) { v[o] *= -0.35; nx = ox; }
          if (grid.solidAt(nx, ny - half, nz)) { v[o + 2] *= -0.35; nz = oz; }
          w[o] *= 0.5; w[o + 1] *= 0.5; w[o + 2] *= 0.5;
          if (speed > 3.5 && this.onBounce && Math.random() < 0.25) this.onBounce(this.mat[i], nx, ny, nz, speed);
          if (hitFloor && speed < 1.6) {
            state[i] = RESTING;
            v[o] = v[o + 1] = v[o + 2] = 0;
            if (life[i] > 16) life[i] = 10 + Math.random() * 6;
          }
        }
        p[o] = nx; p[o + 1] = ny; p[o + 2] = nz;
        // integrate orientation
        const qo = i * 4;
        const qx = q[qo], qy = q[qo + 1], qz = q[qo + 2], qw = q[qo + 3];
        const hx = w[o] * dt * 0.5, hy = w[o + 1] * dt * 0.5, hz = w[o + 2] * dt * 0.5;
        let rx = qx + hx * qw + hy * qz - hz * qy;
        let ry = qy - hx * qz + hy * qw + hz * qx;
        let rz = qz + hx * qy - hy * qx + hz * qw;
        let rw = qw - hx * qx - hy * qy - hz * qz;
        const il = 1 / Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
        rx *= il; ry *= il; rz *= il; rw *= il;
        q[qo] = rx; q[qo + 1] = ry; q[qo + 2] = rz; q[qo + 3] = rw;
        write = true;
      } else if (((i + this.frame) & 31) === 0) {
        // resting: occasionally check that the support is still there
        if (!grid.solidAt(p[o], p[o + 1] - s[o + 1] * 0.5 - 0.08, p[o + 2])) state[i] = FLYING;
      }
      if (write || life[i] < 0.6) {
        const fade = life[i] < 0.6 ? life[i] / 0.6 : 1;
        const qo = i * 4;
        const x = q[qo], y = q[qo + 1], z = q[qo + 2], ww = q[qo + 3];
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = ww * x2, wy = ww * y2, wz = ww * z2;
        const sx = s[o] * fade, sy = s[o + 1] * fade, sz = s[o + 2] * fade;
        const m = i * 16;
        matrices[m] = (1 - (yy + zz)) * sx; matrices[m + 1] = (xy + wz) * sx; matrices[m + 2] = (xz - wy) * sx; matrices[m + 3] = 0;
        matrices[m + 4] = (xy - wz) * sy; matrices[m + 5] = (1 - (xx + zz)) * sy; matrices[m + 6] = (yz + wx) * sy; matrices[m + 7] = 0;
        matrices[m + 8] = (xz + wy) * sz; matrices[m + 9] = (yz - wx) * sz; matrices[m + 10] = (1 - (xx + yy)) * sz; matrices[m + 11] = 0;
        matrices[m + 12] = p[o]; matrices[m + 13] = p[o + 1]; matrices[m + 14] = p[o + 2]; matrices[m + 15] = 1;
        dirty = true;
      }
    }
    this.active = alive;
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.state.fill(0);
    this.matrices.fill(0);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = 0;
    this.cursor = 0;
    this.active = 0;
  }
}
