/**
 * Everything that moves: converts detached structure into rigid bodies, fractures them
 * on impact, damages and splits them, spawns props/doors, enforces the rigid-body
 * budget and merges settled rubble back into the static voxel world.
 */
import * as THREE from 'three';
import type { GameContext } from '../engine/Context';
import { FIXED_DT, GROUPS_BODY, GROUPS_BODY_ONLY, GROUPS_PROBE, RAPIER } from '../engine/Physics';
import { geometryFromMesh } from '../engine/VoxelMaterial';
import { clamp } from '../utils/math';
import { F_BRITTLE_PANE, INV_VOXEL, M, MAT_BRITTLE, MAT_COLLIDE, MAT_COLOR, MAT_COUNT, MAT_FLAGS, MAT_HP, MAT_MASS, MAT_MIN, MAT_SURFACE, TEX_PERIOD, VOXEL } from '../world/Materials';
import { LIMITS } from '../world/config';
import { PROPS, rotateModelY } from '../world/Props';
import type { DoorSpawn, PropSpawn } from '../world/WorldGenerator';
import { LightDebris } from './LightDebris';
import type { DetachedComponent } from './StructuralIntegrity';
import { VoxelBody, type BodyKind } from './VoxelBody';
import { GROUND_Y, MAT_MASK } from './VoxelGrid';
import { decomposeBoxes, labelComponents, meshVolume, padVolume } from './VoxelMesher';

export interface BodyOptions {
  kind?: BodyKind;
  name?: string;
  massScale?: number;
  generation?: number;
  texOff?: [number, number, number];
  sleeping?: boolean;
  worldCollide?: boolean;
  lv?: { x: number; y: number; z: number };
  av?: { x: number; y: number; z: number };
}

interface Piece {
  vox: Uint8Array;
  sx: number;
  sy: number;
  sz: number;
  ox: number;
  oy: number;
  oz: number;
  count: number;
}

const MIN_BODY_VOXELS = 4;
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const contact = { x: 0, y: 0, z: 0 };
const hist = new Float32Array(MAT_COUNT);
const mod = (v: number) => ((v % TEX_PERIOD) + TEX_PERIOD) % TEX_PERIOD;

/** Split a local grid into its 6-connected components, each cropped to its own bounds. */
function piecesFromGrid(vox: Uint8Array, sx: number, sy: number, sz: number, ox: number, oy: number, oz: number): Piece[] {
  const { labels, counts } = labelComponents(vox, sx, sy, sz);
  const n = counts.length - 1;
  if (n <= 0) return [];
  const bb = new Int32Array((n + 1) * 6);
  for (let l = 1; l <= n; l++) {
    bb[l * 6] = sx;
    bb[l * 6 + 1] = sy;
    bb[l * 6 + 2] = sz;
    bb[l * 6 + 3] = bb[l * 6 + 4] = bb[l * 6 + 5] = -1;
  }
  let i = 0;
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++, i++) {
        const l = labels[i];
        if (!l) continue;
        const o = l * 6;
        if (x < bb[o]) bb[o] = x;
        if (y < bb[o + 1]) bb[o + 1] = y;
        if (z < bb[o + 2]) bb[o + 2] = z;
        if (x > bb[o + 3]) bb[o + 3] = x;
        if (y > bb[o + 4]) bb[o + 4] = y;
        if (z > bb[o + 5]) bb[o + 5] = z;
      }
  const out: Piece[] = [];
  for (let l = 1; l <= n; l++) {
    const o = l * 6;
    const px = bb[o + 3] - bb[o] + 1;
    const py = bb[o + 4] - bb[o + 1] + 1;
    const pz = bb[o + 5] - bb[o + 2] + 1;
    const pv = new Uint8Array(px * py * pz);
    for (let y = 0; y < py; y++)
      for (let z = 0; z < pz; z++) {
        const src = bb[o] + sx * (bb[o + 2] + z + sz * (bb[o + 1] + y));
        const dst = px * (z + pz * y);
        for (let x = 0; x < px; x++) if (labels[src + x] === l) pv[dst + x] = vox[src + x];
      }
    out.push({ vox: pv, sx: px, sy: py, sz: pz, ox: ox + bb[o], oy: oy + bb[o + 1], oz: oz + bb[o + 2], count: counts[l] });
  }
  return out;
}

/**
 * Partition a voxel list into `cells` Voronoi regions and return the connected pieces of
 * each region. Seeds are taken evenly along the list, which for a DFS-ordered component
 * spreads them through the structure.
 */
function buildPieces(xs: Int32Array, ys: Int32Array, zs: Int32Array, mats: Uint8Array, n: number, cells: number): Piece[] {
  cells = Math.max(1, Math.min(cells, n));
  const label = new Uint8Array(n);
  if (cells > 1) {
    const sx = new Float32Array(cells), sy = new Float32Array(cells), sz = new Float32Array(cells);
    for (let c = 0; c < cells; c++) {
      const k = Math.min(n - 1, Math.floor(((c + 0.2 + Math.random() * 0.6) * n) / cells));
      sx[c] = xs[k];
      sy[c] = ys[k];
      sz[c] = zs[k];
    }
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < cells; c++) {
        const dx = xs[i] - sx[c], dy = ys[i] - sy[c], dz = zs[i] - sz[c];
        const d = dx * dx + dy * dy * 1.6 + dz * dz;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      label[i] = best;
    }
  }
  const out: Piece[] = [];
  const bb = new Int32Array(cells * 6);
  for (let c = 0; c < cells; c++) {
    bb[c * 6] = bb[c * 6 + 1] = bb[c * 6 + 2] = 1e9;
    bb[c * 6 + 3] = bb[c * 6 + 4] = bb[c * 6 + 5] = -1e9;
  }
  for (let i = 0; i < n; i++) {
    const o = label[i] * 6;
    if (xs[i] < bb[o]) bb[o] = xs[i];
    if (ys[i] < bb[o + 1]) bb[o + 1] = ys[i];
    if (zs[i] < bb[o + 2]) bb[o + 2] = zs[i];
    if (xs[i] > bb[o + 3]) bb[o + 3] = xs[i];
    if (ys[i] > bb[o + 4]) bb[o + 4] = ys[i];
    if (zs[i] > bb[o + 5]) bb[o + 5] = zs[i];
  }
  const grids: (Uint8Array | null)[] = [];
  for (let c = 0; c < cells; c++) {
    const o = c * 6;
    grids.push(bb[o + 3] < bb[o] ? null : new Uint8Array((bb[o + 3] - bb[o] + 1) * (bb[o + 4] - bb[o + 1] + 1) * (bb[o + 5] - bb[o + 2] + 1)));
  }
  for (let i = 0; i < n; i++) {
    const c = label[i];
    const o = c * 6;
    const gx = bb[o + 3] - bb[o] + 1;
    const gz = bb[o + 5] - bb[o + 2] + 1;
    grids[c]![xs[i] - bb[o] + gx * (zs[i] - bb[o + 2] + gz * (ys[i] - bb[o + 1]))] = mats[i];
  }
  for (let c = 0; c < cells; c++) {
    const g = grids[c];
    if (!g) continue;
    const o = c * 6;
    for (const p of piecesFromGrid(g, bb[o + 3] - bb[o] + 1, bb[o + 4] - bb[o + 1] + 1, bb[o + 5] - bb[o + 2] + 1, bb[o], bb[o + 1], bb[o + 2])) out.push(p);
  }
  return out;
}

/** Most probes one body may carry. */
const MAX_PROBES = 48;

/**
 * Probes for a large body, in voxel units (x, y, z, half-size quadruples). The body is
 * cut into blocks of `block`³ voxels; every block that has an open side gets small cubes
 * that are flush with the solid on that side, so the body rests where its real surface is.
 * Blocks buried inside the body get none.
 */
function collectProbes(vox: Uint8Array, sx: number, sy: number, sz: number, block: number): number[] {
  const nbx = Math.ceil(sx / block), nby = Math.ceil(sy / block), nbz = Math.ceil(sz / block);
  // solid bounds per block: x0, x1, y0, y1, z0, z1 (x1 < x0 = empty)
  const bounds = new Int16Array(nbx * nby * nbz * 6);
  for (let b = 0; b < bounds.length; b += 6) {
    bounds[b] = bounds[b + 2] = bounds[b + 4] = 32767;
    bounds[b + 1] = bounds[b + 3] = bounds[b + 5] = -1;
  }
  let i = 0;
  for (let y = 0; y < sy; y++) {
    const by = (y / block) | 0;
    for (let z = 0; z < sz; z++) {
      const row = (((z / block) | 0) + nbz * by) * nbx;
      for (let x = 0; x < sx; x++, i++) {
        if (!MAT_COLLIDE[vox[i]]) continue;
        const b = (row + ((x / block) | 0)) * 6;
        if (x < bounds[b]) bounds[b] = x;
        if (x > bounds[b + 1]) bounds[b + 1] = x;
        if (y < bounds[b + 2]) bounds[b + 2] = y;
        if (y > bounds[b + 3]) bounds[b + 3] = y;
        if (z < bounds[b + 4]) bounds[b + 4] = z;
        if (z > bounds[b + 5]) bounds[b + 5] = z;
      }
    }
  }
  const occupied = (bx: number, by: number, bz: number): boolean =>
    bx >= 0 && by >= 0 && bz >= 0 && bx < nbx && by < nby && bz < nbz && bounds[(bx + nbx * (bz + nbz * by)) * 6 + 1] >= 0;
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  /** Probe centres along one axis for solid extent [lo, hi) with radius r. */
  const place = (lo: number, hi: number, r: number, openLo: boolean, openHi: boolean, into: number[]): void => {
    into.length = 0;
    if (hi - lo <= 2 * r + 0.01) into.push((lo + hi) / 2);
    else if (openLo && openHi) into.push(lo + r, hi - r);
    else if (openLo) into.push(lo + r);
    else if (openHi) into.push(hi - r);
    else into.push((lo + hi) / 2);
  };
  const out: number[] = [];
  for (let by = 0; by < nby; by++)
    for (let bz = 0; bz < nbz; bz++)
      for (let bx = 0; bx < nbx; bx++) {
        const b = (bx + nbx * (bz + nbz * by)) * 6;
        if (bounds[b + 1] < 0) continue;
        const ox0 = !occupied(bx - 1, by, bz), ox1 = !occupied(bx + 1, by, bz);
        const oy0 = !occupied(bx, by - 1, bz), oy1 = !occupied(bx, by + 1, bz);
        const oz0 = !occupied(bx, by, bz - 1), oz1 = !occupied(bx, by, bz + 1);
        if (!(ox0 || ox1 || oy0 || oy1 || oz0 || oz1)) continue;
        const x0 = bounds[b], x1 = bounds[b + 1] + 1, y0 = bounds[b + 2], y1 = bounds[b + 3] + 1, z0 = bounds[b + 4], z1 = bounds[b + 5] + 1;
        const r = clamp(Math.min(x1 - x0, y1 - y0, z1 - z0) / 2, 0.5, 1.5);
        place(x0, x1, r, ox0, ox1, xs);
        place(y0, y1, r, oy0, oy1, ys);
        place(z0, z1, r, oz0, oz1, zs);
        for (const y of ys) for (const z of zs) for (const x of xs) out.push(x, y, z, r);
      }
  return out;
}

export class DebrisManager {
  readonly bodies: VoxelBody[] = [];
  readonly light: LightDebris;
  /** Budgets; lowered by the performance manager under load. */
  maxBodies: number = LIMITS.maxBodies;
  softDebris: number = LIMITS.softDebrisBodies;
  awake = 0;
  /** Hook for systems that react to new bodies (explosions push fresh debris). */
  onBodyCreated: ((b: VoxelBody) => void) | null = null;
  /** kg of structure detached since the last reset (statistics). */
  detachedMass = 0;
  collapses = 0;
  private frame = 0;
  private impactSoundBudget = 0;

  constructor(private readonly ctx: GameContext) {
    this.light = new LightDebris(ctx.renderer.scene, () => ctx.grid);
    this.light.onBounce = (mat, x, y, z, speed) => {
      tmpV.set(x, y, z);
      ctx.audio.impact(MAT_SURFACE[mat], clamp(speed / 40, 0.03, 0.3), { pos: tmpV });
    };
  }

  // -------------------------------------------------------------------------
  // creation / destruction
  // -------------------------------------------------------------------------
  createBody(vox: Uint8Array, sx: number, sy: number, sz: number, px: number, py: number, pz: number, rot: { x: number; y: number; z: number; w: number } | null, o: BodyOptions = {}): VoxelBody | null {
    if (this.bodies.length >= this.maxBodies && !this.evict()) return null;
    const body = new VoxelBody(vox, sx, sy, sz);
    body.kind = o.kind ?? 'debris';
    body.name = o.name ?? 'debris';
    body.massScale = o.massScale ?? 1;
    body.generation = o.generation ?? 0;
    body.worldCollide = o.worldCollide ?? true;
    if (o.texOff) body.texOff = o.texOff;
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(px, py, pz).setCanSleep(true).setLinearDamping(0.04).setAngularDamping(0.35);
    if (rot) desc.setRotation(rot);
    if (o.lv) desc.setLinvel(o.lv.x, o.lv.y, o.lv.z);
    if (o.av) desc.setAngvel(o.av);
    if (o.sleeping) desc.setSleeping(true);
    body.rb = this.ctx.physics.world.createRigidBody(desc);
    body.rb.userData = body;
    if (!this.buildShape(body)) {
      this.ctx.physics.world.removeRigidBody(body.rb);
      return null;
    }
    if (body.count < 40) body.rb.enableCcd(true);
    if (o.sleeping) body.rb.sleep();
    this.buildMesh(body);
    body.group.scale.setScalar(VOXEL);
    body.group.position.set(px, py, pz);
    if (rot) body.group.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    this.ctx.renderer.scene.add(body.group);
    this.bodies.push(body);
    if (this.onBodyCreated) this.onBodyCreated(body);
    return body;
  }

  /** (Re)build colliders and mass from the body's voxels. Returns false when nothing collidable remains. */
  private buildShape(body: VoxelBody): boolean {
    const { vox, sx, sy, sz, rb } = body;
    const world = this.ctx.physics.world;
    hist.fill(0);
    let count = 0, coll = 0, mass = 0;
    let x0 = sx, y0 = sy, z0 = sz, x1 = -1, y1 = -1, z1 = -1;
    let i = 0;
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++, i++) {
          const m = vox[i];
          if (!m) continue;
          count++;
          mass += MAT_MASS[m];
          hist[m] += MAT_MASS[m] + 0.01;
          if (!MAT_COLLIDE[m]) continue;
          coll++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (z < z0) z0 = z;
          if (z > z1) z1 = z;
        }
    body.count = count;
    body.mass = Math.max(0.4, mass * body.massScale);
    let dom = 0;
    for (let m = 1; m < MAT_COUNT; m++) if (hist[m] > hist[dom]) dom = m;
    body.dominant = dom;
    body.radius = 0.5 * VOXEL * Math.hypot(sx, sy, sz);
    for (let c = rb.numColliders() - 1; c >= 0; c--) world.removeCollider(rb.collider(c), false);
    if (coll === 0) return false;

    const surface = MAT_SURFACE[dom];
    // a driven vehicle rolls: its tyres must not scrub like a dragged crate
    const friction = body.driven ? 0.02 : surface === 'metal' ? 0.55 : surface === 'rubber' ? 1.0 : surface === 'wood' ? 0.65 : 0.8;
    const restitution = surface === 'rubber' ? 0.35 : surface === 'metal' ? 0.12 : 0.04;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, bd = z1 - z0 + 1;
    // Large pieces touch thousands of world voxels at once (a tilted slab's bounding box
    // even more), and every one of those is a separate contact test. They collide with the
    // world through a handful of small cube probes instead; their real shape still collides with
    // other bodies and the player.
    const big = body.worldCollide === true && body.kind !== 'vehicle' && Math.max(bw * bd, bw * bh, bh * bd) > 160;
    const groups = body.worldCollide && !big ? GROUPS_BODY : GROUPS_BODY_ONLY;
    const events = body.mass >= 20;
    const done = (): boolean => {
      if (big) this.addProbes(body, friction, restitution, events);
      return true;
    };
    const add = (desc: RAPIER.ColliderDesc) => {
      desc.setCollisionGroups(groups).setFriction(friction).setRestitution(restitution);
      if (body.driven) desc.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
      if (events) desc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(body.mass * 130);
      world.createCollider(desc, rb);
    };
    const compact = coll / (bw * bh * bd);
    const shrink = 0.008;
    if (coll <= 6 || compact > 0.92) {
      add(
        RAPIER.ColliderDesc.cuboid(Math.max(0.02, (bw * VOXEL) / 2 - shrink), Math.max(0.02, (bh * VOXEL) / 2 - shrink), Math.max(0.02, (bd * VOXEL) / 2 - shrink))
          .setTranslation((x0 + bw / 2) * VOXEL, (y0 + bh / 2) * VOXEL, (z0 + bd / 2) * VOXEL)
          .setMass(body.mass),
      );
      return done();
    }
    if (coll <= 180 && compact >= 0.42 && Math.max(bw, bh, bd) <= 14) {
      // chunky fragment: a convex hull tumbles far more naturally than a box
      const pts = new Float32Array(coll * 24);
      let p = 0;
      i = 0;
      const sxz = sx * sz;
      for (let y = 0; y < sy; y++)
        for (let z = 0; z < sz; z++)
          for (let x = 0; x < sx; x++, i++) {
            if (!MAT_COLLIDE[vox[i]]) continue;
            const buried =
              x > 0 && x < sx - 1 && y > 0 && y < sy - 1 && z > 0 && z < sz - 1 &&
              MAT_COLLIDE[vox[i - 1]] && MAT_COLLIDE[vox[i + 1]] && MAT_COLLIDE[vox[i - sx]] && MAT_COLLIDE[vox[i + sx]] && MAT_COLLIDE[vox[i - sxz]] && MAT_COLLIDE[vox[i + sxz]];
            if (buried) continue;
            for (let c = 0; c < 8; c++) {
              pts[p++] = (x + (c & 1)) * VOXEL;
              pts[p++] = (y + ((c >> 1) & 1)) * VOXEL;
              pts[p++] = (z + ((c >> 2) & 1)) * VOXEL;
            }
          }
      const hull = RAPIER.ColliderDesc.convexHull(pts.subarray(0, p));
      if (hull) {
        add(hull.setMass(body.mass));
        return done();
      }
    }
    const boxes = decomposeBoxes(vox, sx, sy, sz, coll > 4000 ? 28 : coll > 700 ? 20 : 12);
    let volume = 0;
    for (const b of boxes) volume += (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]);
    const density = body.mass / Math.max(1e-4, volume * VOXEL * VOXEL * VOXEL);
    for (const b of boxes) {
      const hx = ((b[3] - b[0]) * VOXEL) / 2, hy = ((b[4] - b[1]) * VOXEL) / 2, hz = ((b[5] - b[2]) * VOXEL) / 2;
      add(
        RAPIER.ColliderDesc.cuboid(Math.max(0.02, hx - shrink), Math.max(0.02, hy - shrink), Math.max(0.02, hz - shrink))
          .setTranslation(b[0] * VOXEL + hx, b[1] * VOXEL + hy, b[2] * VOXEL + hz)
          .setDensity(density),
      );
    }
    return done();
  }

  /** Small cube probes that stand in for a large body's shape against the static world. */
  private addProbes(body: VoxelBody, friction: number, restitution: number, events: boolean): void {
    const { vox, sx, sy, sz, rb } = body;
    const world = this.ctx.physics.world;
    let block = clamp(Math.ceil(Math.max(sx, sy, sz) / 7), 3, 8);
    let probes = collectProbes(vox, sx, sy, sz, block);
    for (let tries = 0; probes.length > MAX_PROBES * 4 && tries < 12; tries++) {
      block++;
      probes = collectProbes(vox, sx, sy, sz, block);
    }
    for (let k = 0; k < probes.length; k += 4) {
      // Cubes, not balls: a ball that leaves the voxel domain (anything knocked under the
      // map) panics the solver's ball-voxel contact code, and cubes rest flat.
      const h = probes[k + 3] * VOXEL - 0.008;
      const desc = RAPIER.ColliderDesc.cuboid(h, h, h)
        .setTranslation(probes[k] * VOXEL, probes[k + 1] * VOXEL, probes[k + 2] * VOXEL)
        .setDensity(0)
        .setCollisionGroups(GROUPS_PROBE)
        .setFriction(friction)
        .setRestitution(restitution);
      if (body.driven) desc.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
      if (events) desc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(body.mass * 130);
      world.createCollider(desc, rb);
    }
  }

  private buildMesh(body: VoxelBody): void {
    const { vox, sx, sy, sz } = body;
    const [ox, oy, oz] = body.texOff;
    const vm = meshVolume(padVolume(vox, sx, sy, sz), null, sx, sy, sz, ox, oy, oz);
    const mats = this.ctx.renderer.materials;
    for (const m of [body.opaque, body.glass]) {
      if (!m) continue;
      body.group.remove(m);
      m.geometry.dispose();
    }
    body.opaque = body.glass = null;
    if (vm.opaque) {
      const mesh = new THREE.Mesh(geometryFromMesh(vm.opaque, sx, sy, sz, ox, oy, oz), mats.opaque);
      mesh.position.set(-ox, -oy, -oz);
      mesh.castShadow = body.count >= 10;
      mesh.receiveShadow = true;
      body.group.add(mesh);
      body.opaque = mesh;
    }
    if (vm.glass) {
      const mesh = new THREE.Mesh(geometryFromMesh(vm.glass, sx, sy, sz, ox, oy, oz), mats.glass);
      mesh.position.set(-ox, -oy, -oz);
      mesh.renderOrder = 2;
      body.group.add(mesh);
      body.glass = mesh;
    }
  }

  removeBody(body: VoxelBody): void {
    if (!body.alive) return;
    body.alive = false;
    this.ctx.renderer.scene.remove(body.group);
    body.opaque?.geometry.dispose();
    body.glass?.geometry.dispose();
    this.ctx.physics.world.removeRigidBody(body.rb);
    const i = this.bodies.indexOf(body);
    if (i >= 0) {
      this.bodies[i] = this.bodies[this.bodies.length - 1];
      this.bodies.pop();
    }
    this.ctx.renderer.requestShadowUpdate();
  }

  /** Remove everything (environment reset). */
  clear(): void {
    for (const b of this.bodies) {
      b.alive = false;
      this.ctx.renderer.scene.remove(b.group);
      b.opaque?.geometry.dispose();
      b.glass?.geometry.dispose();
    }
    this.bodies.length = 0;
    this.ctx.physics.clearBodies((rb) => !(rb.userData instanceof VoxelBody));
    this.light.clear();
    this.detachedMass = 0;
    this.collapses = 0;
  }

  // -------------------------------------------------------------------------
  // transforms
  // -------------------------------------------------------------------------
  /** Body-local voxel coordinates → world metres. */
  toWorld(body: VoxelBody, lx: number, ly: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
    const t = body.rb.translation();
    const r = body.rb.rotation();
    tmpQ.set(r.x, r.y, r.z, r.w);
    return out.set(lx * VOXEL, ly * VOXEL, lz * VOXEL).applyQuaternion(tmpQ).add(tmpV2.set(t.x, t.y, t.z));
  }

  /** World metres → body-local voxel coordinates. */
  toLocal(body: VoxelBody, wx: number, wy: number, wz: number, out: THREE.Vector3): THREE.Vector3 {
    const t = body.rb.translation();
    const r = body.rb.rotation();
    tmpQ.set(-r.x, -r.y, -r.z, r.w);
    return out.set(wx - t.x, wy - t.y, wz - t.z).applyQuaternion(tmpQ).multiplyScalar(INV_VOXEL);
  }

  /** World-space centre of the body's grid. */
  center(body: VoxelBody, out: THREE.Vector3): THREE.Vector3 {
    return this.toWorld(body, body.sx / 2, body.sy / 2, body.sz / 2, out);
  }

  // -------------------------------------------------------------------------
  // light fragments
  // -------------------------------------------------------------------------
  /** Scatter up to `max` fragments for a list of world voxels that have just vanished. */
  bits(mat: number, wx: number, wy: number, wz: number, vx: number, vy: number, vz: number, spread = 2.5): void {
    this.light.spawn(wx, wy, wz, vx + (Math.random() - 0.5) * spread, vy + Math.random() * spread * 0.6, vz + (Math.random() - 0.5) * spread, mat);
  }

  private pieceToBits(p: Piece, wx: number, wy: number, wz: number, rot: THREE.Quaternion | null, vel: { x: number; y: number; z: number } | null, max: number): void {
    const step = Math.max(1, Math.ceil(p.count / max));
    let k = 0;
    let i = 0;
    for (let y = 0; y < p.sy; y++)
      for (let z = 0; z < p.sz; z++)
        for (let x = 0; x < p.sx; x++, i++) {
          const m = p.vox[i];
          if (!m || k++ % step) continue;
          tmpV.set((x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL);
          if (rot) tmpV.applyQuaternion(rot);
          this.bits(m, wx + tmpV.x, wy + tmpV.y, wz + tmpV.z, vel ? vel.x : 0, vel ? vel.y : 0, vel ? vel.z : 0, 1.6);
        }
  }

  // -------------------------------------------------------------------------
  // structure → rigid bodies
  // -------------------------------------------------------------------------
  /** Turn a component that lost its support into rigid bodies and fragments. */
  spawnFromComponent(comp: DetachedComponent): void {
    const { grid, physics, particles, audio } = this.ctx;
    const n = comp.indices.length;
    // anything asleep on top of (or leaning against) this section has to fall with it
    physics.wakeRegion(comp.min[0] * VOXEL - 0.5, comp.min[1] * VOXEL - 0.5, comp.min[2] * VOXEL - 0.5, (comp.max[0] + 1) * VOXEL + 0.5, (comp.max[1] + 1) * VOXEL + 1.5, (comp.max[2] + 1) * VOXEL + 0.5);
    const xs = new Int32Array(n), ys = new Int32Array(n), zs = new Int32Array(n);
    const mats = new Uint8Array(n);
    const c3 = [0, 0, 0];
    let glass = 0;
    let live = 0;
    for (let k = 0; k < n; k++) {
      const i = comp.indices[k];
      const m = grid.data[i] & MAT_MASK;
      if (!m) continue;
      grid.coords(i, c3);
      xs[live] = c3[0];
      ys[live] = c3[1];
      zs[live] = c3[2];
      mats[live] = m;
      if (MAT_FLAGS[m] & F_BRITTLE_PANE) glass++;
      live++;
      grid.remove(i);
    }
    if (live === 0) return;
    const [x0, y0, z0] = comp.min;
    const [x1, y1, z1] = comp.max;
    physics.wakeRegion(x0 * VOXEL - 0.6, y0 * VOXEL - 0.6, z0 * VOXEL - 0.6, (x1 + 1) * VOXEL + 0.6, (y1 + 1) * VOXEL + 2, (z1 + 1) * VOXEL + 0.6);
    this.ctx.renderer.requestShadowUpdate();
    const cx = ((x0 + x1 + 1) / 2) * VOXEL, cy = ((y0 + y1 + 1) / 2) * VOXEL, cz = ((z0 + z1 + 1) / 2) * VOXEL;
    tmpV.set(cx, cy, cz);

    if (live <= 3 || glass === live) {
      // crumbs and loose panes never become rigid bodies
      const step = Math.max(1, Math.ceil(live / 40));
      for (let k = 0; k < live; k += step) this.bits(mats[k], (xs[k] + 0.5) * VOXEL, (ys[k] + 0.5) * VOXEL, (zs[k] + 0.5) * VOXEL, 0, 0, 0, 1.2);
      if (glass === live && live > 3) audio.shatter(tmpV, clamp(live / 60, 0.1, 1));
      return;
    }

    this.detachedMass += comp.mass;
    this.collapses++;
    const maxDim = Math.max(x1 - x0, y1 - y0, z1 - z0) + 1;
    let cells = 1;
    if (live > 1400 || maxDim > 120) {
      cells = clamp(Math.round(live / 1000), 2, 22);
      cells = Math.max(cells, Math.ceil(maxDim / 110));
      const room = Math.max(3, this.maxBodies - this.bodies.length + this.countRetirable());
      cells = Math.min(cells, room);
    }
    const pieces = buildPieces(xs, ys, zs, mats, live, cells);
    pieces.sort((a, b) => b.count - a.count);
    let made = 0;
    for (const p of pieces) {
      const wx = p.ox * VOXEL, wy = p.oy * VOXEL, wz = p.oz * VOXEL;
      let body: VoxelBody | null = null;
      if (p.count >= MIN_BODY_VOXELS && Math.max(p.sx, p.sy, p.sz) <= 230 && (made < 26 || p.count > 60)) {
        body = this.createBody(p.vox, p.sx, p.sy, p.sz, wx, wy, wz, null, {
          texOff: [mod(p.ox), mod(p.oy), mod(p.oz)],
          av: { x: (Math.random() - 0.5) * 0.3, y: (Math.random() - 0.5) * 0.2, z: (Math.random() - 0.5) * 0.3 },
        });
      }
      if (body) made++;
      else this.pieceToBits(p, wx, wy, wz, null, null, 24);
    }
    // dust along the break, sound and shake scaled by how much came loose
    const puffs = Math.min(26, 3 + Math.sqrt(live) * 0.35);
    for (let k = 0; k < puffs; k++) {
      const j = (Math.random() * live) | 0;
      const m = mats[j];
      particles.dust((xs[j] + 0.5) * VOXEL, (ys[j] + 0.5) * VOXEL, (zs[j] + 0.5) * VOXEL, MAT_COLOR[m * 3], MAT_COLOR[m * 3 + 1], MAT_COLOR[m * 3 + 2], 2, 0.6, 1.4, 0.6 + Math.min(1.2, live / 4000));
    }
    if (comp.mass > 120) {
      audio.collapse(tmpV, comp.mass);
      this.ctx.camera.shakeFrom(tmpV, clamp(Math.log10(comp.mass) / 5, 0.1, 1) * 0.6, 40);
      this.ctx.perf.noteDestruction(clamp(live / 3000, 0.05, 1));
    }
  }

  private countRetirable(): number {
    let n = 0;
    for (const b of this.bodies) if (b.kind === 'debris' && !b.held && b.rb.isSleeping()) n++;
    return n;
  }

  /** Break a body into Voronoi pieces around an impact. */
  fracture(body: VoxelBody, wx: number, wy: number, wz: number, severity: number): void {
    if (!body.alive || body.kind === 'vehicle' || body.kind === 'door') return;
    const { vox, sx, sy, sz } = body;
    const lp = this.toLocal(body, wx, wy, wz, tmpV).clone();
    const n = body.count;
    const xs = new Int32Array(n), ys = new Int32Array(n), zs = new Int32Array(n);
    const mats = new Uint8Array(n);
    const t = body.rb.translation();
    const r = body.rb.rotation();
    const rot = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const lv = body.rb.linvel();
    const av = body.rb.angvel();
    const crush = 1.3 + Math.min(1.6, severity * 0.5);
    let live = 0;
    let i = 0;
    const { particles } = this.ctx;
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++, i++) {
          const m = vox[i];
          if (!m) continue;
          const dx = x + 0.5 - lp.x, dy = y + 0.5 - lp.y, dz = z + 0.5 - lp.z;
          if (dx * dx + dy * dy + dz * dz < crush * crush) {
            // pulverised at the point of impact
            if (Math.random() < 0.5) {
              tmpV.set((x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL).applyQuaternion(rot);
              this.bits(m, t.x + tmpV.x, t.y + tmpV.y, t.z + tmpV.z, lv.x * 0.4, lv.y * 0.2 + 1, lv.z * 0.4, 3);
            }
            continue;
          }
          xs[live] = x;
          ys[live] = y;
          zs[live] = z;
          mats[live] = m;
          live++;
        }
    const dom = body.dominant;
    particles.dust(wx, wy, wz, MAT_COLOR[dom * 3], MAT_COLOR[dom * 3 + 1], MAT_COLOR[dom * 3 + 2], 5 + Math.min(10, n / 60), 0.5, 2.2, 0.5 + Math.min(0.9, n / 1500));
    const options = { kind: body.kind === 'prop' ? ('debris' as const) : body.kind, massScale: body.massScale, generation: body.generation + 1 };
    const texOff = body.texOff;
    this.removeBody(body);
    if (live === 0) return;
    const room = Math.max(2, this.maxBodies - this.bodies.length);
    const cells = Math.min(room, clamp(2 + Math.floor(severity) + Math.floor(live / 500), 2, 7));
    const pieces = buildPieces(xs, ys, zs, mats, live, cells);
    pieces.sort((a, b) => b.count - a.count);
    let made = 0;
    for (const p of pieces) {
      tmpV.set(p.ox * VOXEL, p.oy * VOXEL, p.oz * VOXEL).applyQuaternion(rot);
      const px = t.x + tmpV.x, py = t.y + tmpV.y, pz = t.z + tmpV.z;
      // velocity of the parent at the piece plus a small separation kick
      tmpV2.set((p.ox + p.sx / 2 - lp.x) * VOXEL, (p.oy + p.sy / 2 - lp.y) * VOXEL, (p.oz + p.sz / 2 - lp.z) * VOXEL).applyQuaternion(rot);
      const kick = 0.6 + Math.random() * 0.8;
      const d = tmpV2.length() + 0.05;
      const vel = { x: lv.x * 0.85 + (tmpV2.x / d) * kick, y: lv.y * 0.85 + (tmpV2.y / d) * kick + 0.3, z: lv.z * 0.85 + (tmpV2.z / d) * kick };
      let made1: VoxelBody | null = null;
      if (p.count >= MIN_BODY_VOXELS + 2 && made < 8) {
        made1 = this.createBody(p.vox, p.sx, p.sy, p.sz, px, py, pz, rot, {
          ...options,
          texOff: [mod(texOff[0] + p.ox), mod(texOff[1] + p.oy), mod(texOff[2] + p.oz)],
          lv: vel,
          av: { x: av.x + (Math.random() - 0.5) * 2, y: av.y + (Math.random() - 0.5) * 2, z: av.z + (Math.random() - 0.5) * 2 },
        });
      }
      if (made1) {
        made++;
        made1.fractureCooldown = 0.25;
      } else this.pieceToBits(p, px, py, pz, rot, vel, 14);
    }
  }

  // -------------------------------------------------------------------------
  // damage
  // -------------------------------------------------------------------------
  /**
   * Remove voxels of a body inside a world-space sphere. Returns the number removed.
   * The mesh/collider rebuild (and any split) is deferred to the next update.
   */
  damageBody(body: VoxelBody, wx: number, wy: number, wz: number, radius: number, power: number, torch = false): number {
    if (!body.alive) return 0;
    const lp = this.toLocal(body, wx, wy, wz, tmpV);
    const lx = lp.x, ly = lp.y, lz = lp.z;
    const r = radius * INV_VOXEL;
    const { vox, sx, sy, sz } = body;
    const x0 = Math.max(0, Math.floor(lx - r)), x1 = Math.min(sx - 1, Math.floor(lx + r));
    const y0 = Math.max(0, Math.floor(ly - r)), y1 = Math.min(sy - 1, Math.floor(ly + r));
    const z0 = Math.max(0, Math.floor(lz - r)), z1 = Math.min(sz - 1, Math.floor(lz + r));
    let removed = 0;
    const rb = body.rb;
    const rr = rb.rotation();
    const t = rb.translation();
    const rot = tmpQ.set(rr.x, rr.y, rr.z, rr.w).clone();
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const i = x + sx * (z + sz * y);
          const m = vox[i];
          if (!m) continue;
          const dx = x + 0.5 - lx, dy = y + 0.5 - ly, dz = z + 0.5 - lz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / r;
          if (d > 1) continue;
          const p = power * (1 - d * d) * (0.75 + Math.random() * 0.5);
          if (!torch && p < MAT_MIN[m]) continue;
          if (p < MAT_HP[m] * (0.55 + Math.random() * 0.45)) continue;
          vox[i] = 0;
          removed++;
          if (removed <= 10 || Math.random() < 0.15) {
            tmpV2.set((x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL).applyQuaternion(rot);
            this.bits(m, t.x + tmpV2.x, t.y + tmpV2.y, t.z + tmpV2.z, 0, 1, 0, 3);
          }
        }
    if (removed > 0) {
      body.dirty = true;
      body.count -= removed;
      if (rb.isSleeping()) rb.wakeUp();
    }
    if (body.explosive && body.fuse < 0) {
      body.explosiveHp -= power * (removed > 0 ? 1 : 0.35);
      if (body.explosiveHp <= 0) body.fuse = 0.04 + Math.random() * 0.22;
    }
    return removed;
  }

  /** Rebuild a body whose voxels changed; split it if it is no longer one connected piece. */
  private processDirty(body: VoxelBody): void {
    body.dirty = false;
    if (body.count <= 0) {
      this.removeBody(body);
      return;
    }
    const pieces = piecesFromGrid(body.vox, body.sx, body.sy, body.sz, 0, 0, 0);
    if (pieces.length === 0) {
      this.removeBody(body);
      return;
    }
    if (pieces.length === 1) {
      if (!this.buildShape(body)) {
        this.removeBody(body);
        return;
      }
      this.buildMesh(body);
      return;
    }
    // split: the largest piece keeps the body's identity
    pieces.sort((a, b) => b.count - a.count);
    const t = body.rb.translation();
    const r = body.rb.rotation();
    const rot = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const lv = body.rb.linvel();
    const av = body.rb.angvel();
    const base = { massScale: body.massScale, generation: body.generation, lv: { x: lv.x, y: lv.y, z: lv.z }, av: { x: av.x, y: av.y, z: av.z } };
    const { kind, name, explosive, explosiveHp, texOff, frontX, frontZ } = body;
    const keepIdentity = pieces[0].count >= body.count * 0.55;
    this.removeBody(body);
    pieces.forEach((p, k) => {
      tmpV.set(p.ox * VOXEL, p.oy * VOXEL, p.oz * VOXEL).applyQuaternion(rot);
      const px = t.x + tmpV.x, py = t.y + tmpV.y, pz = t.z + tmpV.z;
      if (p.count < MIN_BODY_VOXELS) {
        this.pieceToBits(p, px, py, pz, rot, lv, 6);
        return;
      }
      const first = k === 0 && keepIdentity;
      const nb = this.createBody(p.vox, p.sx, p.sy, p.sz, px, py, pz, rot, {
        ...base,
        kind: first ? kind : kind === 'door' ? 'debris' : kind === 'vehicle' ? 'debris' : kind,
        name: first ? name : 'debris',
        texOff: [mod(texOff[0] + p.ox), mod(texOff[1] + p.oy), mod(texOff[2] + p.oz)],
      });
      if (!nb) this.pieceToBits(p, px, py, pz, rot, lv, 10);
      else if (first) {
        nb.frontX = frontX;
        nb.frontZ = frontZ;
        if (explosive) {
          nb.explosive = explosive;
          nb.explosiveHp = explosiveHp;
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // props and doors
  // -------------------------------------------------------------------------
  spawnProp(s: PropSpawn): VoxelBody | null {
    const def = PROPS[s.type];
    const model = rotateModelY(def.build(s.variant), s.rot);
    // never spawn inside the static world: the solver would fire the prop out like a cannon
    const { grid } = this.ctx;
    const e = 0.03;
    let lift = 0;
    while (lift < 8 && grid.boxCollides(s.x * VOXEL + e, (s.y + lift) * VOXEL + e, s.z * VOXEL + e, (s.x + model.sx) * VOXEL - e, (s.y + lift + model.sy) * VOXEL - e, (s.z + model.sz) * VOXEL - e)) lift++;
    if (lift > 0) console.warn(`[breakpoint] prop "${s.type}" at ${s.x},${s.y},${s.z} overlaps the world (${lift === 8 ? 'skipped' : `lifted ${lift}`})`);
    if (lift === 8) return null;
    const body = this.createBody(model.vox.slice(), model.sx, model.sy, model.sz, s.x * VOXEL, (s.y + lift) * VOXEL, s.z * VOXEL, null, {
      kind: def.vehicle ? 'vehicle' : 'prop',
      name: def.name,
      massScale: def.massScale,
      sleeping: true,
    });
    if (body && def.explosive) {
      body.explosive = def.explosive;
      body.explosiveHp = def.explosive.hp;
    }
    if (body && def.vehicle) {
      // models are built nose-first along -X; quarter turns move the nose with them
      const turns = ((s.rot % 4) + 4) % 4;
      body.frontX = [-1, 0, 1, 0][turns];
      body.frontZ = [0, -1, 0, 1][turns];
    }
    return body;
  }

  /** Switch a vehicle between parked (grippy) and driven (rolling) contact behaviour. */
  setDriven(body: VoxelBody, driven: boolean): void {
    if (body.driven === driven || !body.alive) return;
    if (body.calm) this.setCalm(body, false);
    body.driven = driven;
    this.buildShape(body);
    body.rb.wakeUp();
  }

  spawnDoor(d: DoorSpawn): VoxelBody | null {
    const along = d.axis === 'x';
    const sx = along ? d.width : 1;
    const sz = along ? 1 : d.width;
    const vox = new Uint8Array(sx * d.height * sz).fill(d.mat);
    const handle = d.hinge ? 0 : d.width - 1;
    vox[(along ? handle : 0) + sx * ((along ? 0 : handle) + sz * Math.floor(d.height / 2))] = M.MetalDark;
    const ox = d.x * VOXEL, oy = d.y * VOXEL, oz = d.z * VOXEL;
    const body = this.createBody(vox, sx, d.height, sz, ox, oy, oz, null, { kind: 'door', name: 'door', massScale: 0.3, worldCollide: false });
    if (!body) return null;
    const edge = d.hinge ? d.width * VOXEL : 0;
    const local = along ? { x: edge, y: 0, z: VOXEL / 2 } : { x: VOXEL / 2, y: 0, z: edge };
    const anchor = { x: ox + local.x, y: oy, z: oz + local.z };
    const joint = this.ctx.physics.world.createImpulseJoint(RAPIER.JointData.revolute(anchor, local, { x: 0, y: 1, z: 0 }), this.ctx.physics.staticBody, body.rb, true);
    (joint as RAPIER.RevoluteImpulseJoint).setLimits(-1.9, 1.9);
    body.joint = joint;
    body.rb.setAngularDamping(4);
    body.rb.setLinearDamping(0.5);
    const jx = along ? d.x + (d.hinge ? d.width : -1) : d.x;
    const jz = along ? d.z : d.z + (d.hinge ? d.width : -1);
    body.hingeVoxel = this.ctx.grid.index(jx, d.y + Math.floor(d.height / 2), jz);
    return body;
  }

  /** Let a door fall out of its frame (hinge support destroyed or blown off). */
  releaseDoor(body: VoxelBody): void {
    if (!body.joint) return;
    this.ctx.physics.world.removeImpulseJoint(body.joint as RAPIER.ImpulseJoint, true);
    body.joint = null;
    body.hingeVoxel = -1;
    body.kind = 'debris';
    body.worldCollide = true;
    body.rb.setAngularDamping(0.35);
    body.rb.setLinearDamping(0.04);
    this.buildShape(body);
  }

  // -------------------------------------------------------------------------
  // budget: retire, merge into the world
  // -------------------------------------------------------------------------
  /** Free one rigid-body slot by retiring the least important settled debris. */
  private evict(): boolean {
    let best: VoxelBody | null = null;
    let bestScore = Infinity;
    const p = this.ctx.player.position;
    for (const b of this.bodies) {
      if (b.kind !== 'debris' || b.held) continue;
      const pos = b.group.position;
      const dist = Math.hypot(pos.x - p.x, pos.z - p.z);
      const score = (b.count * (b.rb.isSleeping() ? 1 : 6)) / (1 + dist * 0.15);
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (!best) return false;
    this.retire(best);
    return true;
  }

  private retire(body: VoxelBody): void {
    if (body.count >= 8 && body.rb.isSleeping() && this.bake(body)) return;
    const c = this.center(body, tmpV);
    const m = body.dominant;
    this.ctx.particles.dust(c.x, c.y, c.z, MAT_COLOR[m * 3], MAT_COLOR[m * 3 + 1], MAT_COLOR[m * 3 + 2], Math.min(6, 1 + body.count / 20), body.radius, 0.6, 0.5);
    this.removeBody(body);
  }

  /**
   * Merge a settled body into the static voxel grid ("re-voxelise" it in its resting
   * pose). The rubble stays in the world for good, costs no physics and can be destroyed
   * again. Returns false when the body is not resting on anything static.
   */
  bake(body: VoxelBody): boolean {
    const { grid, integrity } = this.ctx;
    const { vox, sx, sy, sz } = body;
    const t = body.rb.translation();
    const r = body.rb.rotation();
    const rot = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const inv = rot.clone().invert();
    // world-space bounds of the rotated grid
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let c = 0; c < 8; c++) {
      tmpV.set(c & 1 ? sx : 0, c & 2 ? sy : 0, c & 4 ? sz : 0).multiplyScalar(VOXEL).applyQuaternion(rot);
      minX = Math.min(minX, tmpV.x); maxX = Math.max(maxX, tmpV.x);
      minY = Math.min(minY, tmpV.y); maxY = Math.max(maxY, tmpV.y);
      minZ = Math.min(minZ, tmpV.z); maxZ = Math.max(maxZ, tmpV.z);
    }
    const x0 = Math.floor((t.x + minX) * INV_VOXEL), x1 = Math.floor((t.x + maxX) * INV_VOXEL);
    const y0 = Math.max(1, Math.floor((t.y + minY) * INV_VOXEL)), y1 = Math.floor((t.y + maxY) * INV_VOXEL);
    const z0 = Math.floor((t.z + minZ) * INV_VOXEL), z1 = Math.floor((t.z + maxZ) * INV_VOXEL);
    const cells: number[] = [];
    let supported = false;
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          if (!grid.inBounds(x, y, z) || grid.mat(x, y, z)) continue;
          tmpV.set((x + 0.5) * VOXEL - t.x, (y + 0.5) * VOXEL - t.y, (z + 0.5) * VOXEL - t.z).applyQuaternion(inv).multiplyScalar(INV_VOXEL);
          const lx = Math.floor(tmpV.x), ly = Math.floor(tmpV.y), lz = Math.floor(tmpV.z);
          if (lx < 0 || ly < 0 || lz < 0 || lx >= sx || ly >= sy || lz >= sz) continue;
          const m = vox[lx + sx * (lz + sz * ly)];
          if (!m) continue;
          cells.push(x, y, z, m);
          if (!supported && (y < GROUND_Y || MAT_COLLIDE[grid.mat(x, y - 1, z)])) supported = true;
        }
    if (!supported || cells.length === 0) return false;
    this.removeBody(body);
    for (let k = 0; k < cells.length; k += 4) {
      if (grid.place(cells[k], cells[k + 1], cells[k + 2], cells[k + 3])) integrity.voxelAdded(grid.index(cells[k], cells[k + 1], cells[k + 2]));
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // per-frame
  // -------------------------------------------------------------------------
  /**
   * Rapier wakes every body on the step after it is inserted. Props are placed at rest, so
   * run those steps during loading (a few more if something was authored hanging in the
   * air) and then put every body to sleep together.
   */
  freezeSpawned(): void {
    const { physics } = this.ctx;
    for (let step = 0; step < 90; step++) {
      physics.world.step();
      if (step < 1) continue;
      let moving = false;
      for (const b of this.bodies) {
        if (b.joint) continue;
        const v = b.rb.linvel();
        if (v.x * v.x + v.y * v.y + v.z * v.z > 0.04) {
          moving = true;
          break;
        }
      }
      if (!moving) break;
    }
    for (const b of this.bodies) {
      if (b.joint) continue;
      b.rb.setLinvel({ x: 0, y: 0, z: 0 }, false);
      b.rb.setAngvel({ x: 0, y: 0, z: 0 }, false);
      b.rb.sleep();
      const t = b.rb.translation();
      const r = b.rb.rotation();
      b.group.position.set(t.x, t.y, t.z);
      b.group.quaternion.set(r.x, r.y, r.z, r.w);
    }
    physics.impacts.length = 0;
  }

  /** Record pre-step velocities of awake bodies (impact speed, punching through what they break). */
  preStep(): void {
    for (const b of this.bodies) {
      if (b.rb.isSleeping()) {
        b.pvx = b.pvy = b.pvz = 0;
        continue;
      }
      const v = b.rb.linvel();
      // terminal velocity: keeps the fastest pieces within what one step can resolve
      if (v.y < -22) {
        v.y = -22;
        b.rb.setLinvel(v, true);
      }
      b.pvx = v.x;
      b.pvy = v.y;
      b.pvz = v.z;
    }
  }

  /** React to contact-force events gathered by the physics step. */
  handleImpacts(): void {
    const { physics, audio, particles, damage } = this.ctx;
    const list = physics.impacts;
    if (list.length === 0) return;
    list.sort((a, b) => b.force - a.force);
    const n = Math.min(list.length, 10);
    for (let k = 0; k < n; k++) {
      const ev = list[k];
      const a = ev.a instanceof VoxelBody ? ev.a : null;
      const b = ev.b instanceof VoxelBody ? ev.b : null;
      const body = a && b ? (a.mass <= b.mass ? a : b) : (a ?? b);
      if (!body || !body.alive) continue;
      const other = body === a ? b : a;
      // How fast were the two actually closing? Resting loads and force chains through a
      // pile produce large contact forces too, but they are not impacts.
      const closing = other ? Math.hypot(body.pvx - other.pvx, body.pvy - other.pvy, body.pvz - other.pvz) : Math.hypot(body.pvx, body.pvy, body.pvz);
      if (closing < 1) continue;
      const impulse = Math.min(ev.force * FIXED_DT, body.mass * closing * 1.6);
      const dv = impulse / body.mass;
      if (dv < 0.6) continue;
      if (!physics.contactPoint(ev.colliderA, ev.colliderB, contact)) {
        const c = this.center(body, tmpV);
        contact.x = c.x;
        contact.y = c.y - body.radius * 0.5;
        contact.z = c.z;
      }
      const cx = contact.x, cy = contact.y, cz = contact.z;
      tmpV.set(cx, cy, cz);
      if (this.impactSoundBudget > 0 && dv > 1) {
        this.impactSoundBudget--;
        audio.impact(MAT_SURFACE[body.dominant], clamp(impulse / 2500, 0.08, 1.6), { pos: tmpV });
      }
      if (dv > 2.5) {
        const m = body.dominant;
        particles.dust(cx, cy, cz, MAT_COLOR[m * 3], MAT_COLOR[m * 3 + 1], MAT_COLOR[m * 3 + 2], Math.min(8, 2 + impulse / 1500), 0.4, 1.6, 0.45 + Math.min(1, impulse / 12000));
      }
      // heavy things break what they land on, and keep some of their momentum when they do
      if (!other && impulse > 420 && body.kind !== 'door') {
        const power = Math.min(impulse * 0.03, 900);
        const radius = clamp(0.2 + Math.cbrt(body.mass) * 0.03, 0.25, 0.9);
        const removed = damage.sphere(cx, cy - 0.05, cz, radius, power, 'impact');
        if (removed >= 4 && body.alive) {
          body.rb.setLinvel({ x: body.pvx * 0.6, y: body.pvy * 0.6, z: body.pvz * 0.6 }, true);
        }
      } else if (other && other.alive && impulse > 500 && body.mass > 80 && other.kind !== 'vehicle') {
        this.damageBody(other, cx, cy, cz, 0.35, Math.min(impulse * 0.03, 400));
      }
      if (!body.alive) continue;
      if (body.explosive && dv > 9 && body.fuse < 0) body.fuse = 0.05;
      if (body.kind === 'vehicle') {
        if (dv > 3.5) this.damageBody(body, cx, cy, cz, 0.45, dv * 26);
        continue;
      }
      const limit = MAT_BRITTLE[body.dominant] * (1 + body.generation * 0.7);
      if (dv > limit && body.count >= 10 && body.fractureCooldown <= 0 && !body.held && body.kind !== 'door') {
        this.fracture(body, cx, cy, cz, dv / limit);
      }
    }
    list.length = 0;
  }

  update(dt: number, viewer: THREE.Vector3): void {
    const { explosions, grid } = this.ctx;
    this.frame++;
    this.impactSoundBudget = Math.min(4, this.impactSoundBudget + dt * 14);
    let awake = 0;
    let debris = 0;
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      if (!b.alive) continue;
      if (b.dirty) {
        this.processDirty(b);
        if (!b.alive) continue;
      }
      if (b.fuse >= 0) {
        b.fuse -= dt;
        if (b.fuse < 0) {
          explosions.detonateBody(b);
          continue;
        }
      }
      if (b.kind === 'debris') debris++;
      if (b.fractureCooldown > 0) b.fractureCooldown -= dt;
      b.age += dt;
      const rb = b.rb;
      if (rb.isSleeping()) continue;
      awake++;
      const t = rb.translation();
      const r = rb.rotation();
      b.group.position.set(t.x, t.y, t.z);
      b.group.quaternion.set(r.x, r.y, r.z, r.w);
      if (t.y < -15) {
        this.removeBody(b);
        continue;
      }
      // Settle quickly instead of jittering in a pile. Never force rb.sleep() here: a body
      // flagged asleep while a neighbour is awake keeps falling but loses its contacts with
      // the static world, sinks through the ground, and removing it then crashes the solver.
      // Heavy damping gets the same result and leaves the sleeping to the island manager.
      if (b.joint || b.driven) continue;
      if (b.held) {
        if (b.calm) this.setCalm(b, false);
        continue;
      }
      const lv = rb.linvel();
      const av = rb.angvel();
      const arm = Math.min(b.radius, 1.5);
      const speed2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z + (av.x * av.x + av.y * av.y + av.z * av.z) * arm * arm;
      if (speed2 < 0.03) {
        b.still += dt;
        if (b.still > 0.4 && !b.calm) this.setCalm(b, true);
      } else {
        b.still = 0;
        if (b.calm && speed2 > 0.25) this.setCalm(b, false);
      }
    }
    this.awake = awake;

    // hinged doors fall when the jamb they hang from is gone
    if (this.frame % 20 === 0) {
      for (const b of this.bodies) {
        if (b.joint && b.hingeVoxel >= 0 && !(grid.data[b.hingeVoxel] & MAT_MASK)) this.releaseDoor(b);
      }
    }
    // keep the debris population inside its soft budget: merge or drop the least important
    if (debris > this.softDebris || this.bodies.length > this.maxBodies - 12) {
      for (let k = 0; k < 2; k++) if (!this.evict()) break;
    } else if (this.frame % 45 === 0) {
      // slowly clear out insignificant crumbs
      for (const b of this.bodies) {
        if (b.kind === 'debris' && b.count < 7 && b.age > 12 && b.rb.isSleeping()) {
          this.retire(b);
          break;
        }
      }
    }
    this.light.update(dt, viewer);
  }

  private setCalm(body: VoxelBody, calm: boolean): void {
    body.calm = calm;
    body.rb.setLinearDamping(calm ? 5 : 0.04);
    body.rb.setAngularDamping(calm ? 6 : 0.35);
  }

  /** Bodies whose bounding sphere intersects a world-space sphere. */
  forEachNear(x: number, y: number, z: number, radius: number, cb: (b: VoxelBody, dist: number) => void): void {
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      if (!b || !b.alive) continue;
      const c = this.center(b, tmpV);
      const d = Math.hypot(c.x - x, c.y - y, c.z - z);
      if (d - b.radius < radius) cb(b, d);
    }
  }

  get debrisCount(): number {
    let n = 0;
    for (const b of this.bodies) if (b.kind === 'debris') n++;
    return n;
  }
}
