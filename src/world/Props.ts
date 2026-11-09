/**
 * Voxel models for movable physical objects. Pure data (no Three.js / Rapier) so the
 * world-generation worker can import sizes for placement.
 */
import { M } from './Materials';

export interface VoxelModel {
  sx: number;
  sy: number;
  sz: number;
  /** Material ids, index = x + sx * (z + sz * y). */
  vox: Uint8Array;
}

export class ModelBuilder implements VoxelModel {
  readonly vox: Uint8Array;
  constructor(readonly sx: number, readonly sy: number, readonly sz: number) {
    this.vox = new Uint8Array(sx * sy * sz);
  }
  set(x: number, y: number, z: number, m: number): this {
    if (x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz) this.vox[x + this.sx * (z + this.sz * y)] = m;
    return this;
  }
  get(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return 0;
    return this.vox[x + this.sx * (z + this.sz * y)];
  }
  /** Inclusive box fill. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number): this {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, m);
    return this;
  }
  /** Hollow box: walls of thickness 1. */
  shell(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number): this {
    this.box(x0, y0, z0, x1, y1, z1, m);
    if (x1 - x0 > 1 && y1 - y0 > 1 && z1 - z0 > 1) this.box(x0 + 1, y0 + 1, z0 + 1, x1 - 1, y1 - 1, z1 - 1, 0);
    return this;
  }
}

/** Rotate a model by quarter turns about the vertical axis. */
export function rotateModelY(m: VoxelModel, turns: number): VoxelModel {
  turns = ((turns % 4) + 4) % 4;
  if (turns === 0) return m;
  const odd = turns % 2 === 1;
  const out = new ModelBuilder(odd ? m.sz : m.sx, m.sy, odd ? m.sx : m.sz);
  for (let y = 0; y < m.sy; y++)
    for (let z = 0; z < m.sz; z++)
      for (let x = 0; x < m.sx; x++) {
        const v = m.vox[x + m.sx * (z + m.sz * y)];
        if (!v) continue;
        if (turns === 1) out.set(m.sz - 1 - z, y, x, v);
        else if (turns === 2) out.set(m.sx - 1 - x, y, m.sz - 1 - z, v);
        else out.set(z, y, m.sx - 1 - x, v);
      }
  return out;
}

export type PropType =
  | 'crate'
  | 'crateSmall'
  | 'barrel'
  | 'barrelExplosive'
  | 'pallet'
  | 'concreteBlock'
  | 'chair'
  | 'table'
  | 'plank'
  | 'steelBeam'
  | 'tire'
  | 'cone'
  | 'bin'
  | 'propane'
  | 'toolbox'
  | 'bricks'
  | 'car'
  | 'van'
  | 'excavator';

export interface ExplosiveSpec {
  /** 0..1+ blast scale (see ExplosionSystem presets). */
  power: number;
  /** Damage the object absorbs before it detonates. */
  hp: number;
}

export interface PropDef {
  name: string;
  build(variant: number): VoxelModel;
  /** Multiplier on the summed voxel mass (voxel walls are far thicker than real sheet/board). */
  massScale: number;
  explosive?: ExplosiveSpec;
  vehicle?: boolean;
}

function crate(size: number): VoxelModel {
  const b = new ModelBuilder(size, size, size);
  const e = size - 1;
  b.shell(0, 0, 0, e, e, e, M.Wood);
  for (let i = 0; i <= e; i++) {
    for (const [p, q] of [[0, 0], [0, e], [e, 0], [e, e]] as const) {
      b.set(i, p, q, M.WoodDark).set(p, i, q, M.WoodDark).set(p, q, i, M.WoodDark);
    }
  }
  return b;
}

function barrel(body: number, band: number): VoxelModel {
  const b = new ModelBuilder(5, 7, 5);
  for (let y = 0; y < 7; y++) {
    const m = y === 1 || y === 5 ? band : body;
    for (let z = 0; z < 5; z++)
      for (let x = 0; x < 5; x++) {
        const corner = (x === 0 || x === 4) && (z === 0 || z === 4);
        if (corner) continue;
        const edge = x === 0 || x === 4 || z === 0 || z === 4 || y === 0 || y === 6;
        if (edge) b.set(x, y, z, m);
      }
  }
  return b;
}

function pallet(): VoxelModel {
  const b = new ModelBuilder(6, 2, 5);
  for (let x = 0; x < 6; x += 1) if (x !== 2 && x !== 3) b.box(x, 1, 0, x, 1, 4, M.Wood);
  b.box(2, 1, 0, 3, 1, 4, M.Wood);
  b.box(0, 0, 0, 5, 0, 0, M.WoodDark).box(0, 0, 2, 5, 0, 2, M.WoodDark).box(0, 0, 4, 5, 0, 4, M.WoodDark);
  return b;
}

function chair(): VoxelModel {
  const b = new ModelBuilder(3, 6, 3);
  b.box(0, 2, 0, 2, 2, 2, M.Wood);
  for (const [x, z] of [[0, 0], [2, 0], [0, 2], [2, 2]] as const) b.box(x, 0, z, x, 1, z, M.WoodDark);
  b.box(0, 3, 0, 0, 5, 0, M.WoodDark).box(2, 3, 0, 2, 5, 0, M.WoodDark).box(0, 4, 0, 2, 5, 0, M.Wood);
  return b;
}

function table(): VoxelModel {
  const b = new ModelBuilder(8, 4, 5);
  b.box(0, 3, 0, 7, 3, 4, M.Wood);
  for (const [x, z] of [[0, 0], [7, 0], [0, 4], [7, 4]] as const) b.box(x, 0, z, x, 2, z, M.WoodDark);
  return b;
}

function tire(): VoxelModel {
  const b = new ModelBuilder(4, 2, 4);
  b.box(0, 0, 0, 3, 1, 3, M.Rubber).box(1, 0, 1, 2, 1, 2, 0);
  return b;
}

function cone(): VoxelModel {
  const b = new ModelBuilder(3, 4, 3);
  b.box(0, 0, 0, 2, 0, 2, M.Rubber).box(1, 1, 1, 1, 3, 1, M.Neon).set(1, 2, 1, M.PaintWhite);
  return b;
}

function bin(): VoxelModel {
  const b = new ModelBuilder(3, 5, 3);
  b.shell(0, 0, 0, 2, 4, 2, M.MetalDark).set(1, 4, 1, 0);
  return b;
}

function propane(): VoxelModel {
  const b = new ModelBuilder(3, 6, 3);
  b.box(0, 0, 0, 2, 4, 2, M.PaintWhite).box(1, 1, 1, 1, 3, 1, M.Explosive).set(1, 5, 1, M.MetalDark);
  for (const [x, z] of [[0, 0], [2, 0], [0, 2], [2, 2]] as const) b.box(x, 0, z, x, 4, z, 0);
  b.box(0, 0, 1, 0, 4, 1, M.PaintWhite).box(2, 0, 1, 2, 4, 1, M.PaintWhite).box(1, 0, 0, 1, 4, 0, M.PaintWhite).box(1, 0, 2, 1, 4, 2, M.PaintWhite);
  return b;
}

function bricks(): VoxelModel {
  const b = new ModelBuilder(6, 5, 5);
  b.box(0, 0, 0, 5, 0, 4, M.Wood).box(0, 1, 0, 5, 4, 4, M.Brick);
  return b;
}

function car(variant: number, van: boolean): VoxelModel {
  const paint = [M.PaintWhite, M.PaintRed, M.PaintBlue, M.PaintYellow][variant % 4];
  const L = van ? 24 : 22;
  const H = van ? 9 : 7;
  const W = 9;
  const b = new ModelBuilder(L, H, W);
  const top = H - 1;
  const belt = 3; // top of the lower body
  // chassis + lower body shell
  b.box(0, 1, 1, L - 1, 1, W - 2, M.MetalDark);
  b.shell(0, 1, 0, L - 1, belt, W - 1, paint);
  b.box(1, 1, 1, L - 2, 1, W - 2, M.MetalDark);
  // cabin
  const c0 = van ? 5 : 6;
  const c1 = van ? L - 1 : L - 6;
  b.box(c0, belt + 1, 0, c1, top, W - 1, paint);
  b.box(c0 + 1, belt, 1, c1 - 1, top - 1, W - 2, 0);
  // glazing
  const g0 = belt + 1;
  const g1 = top - 1;
  b.box(c0, g0, 1, c0, g1, W - 2, M.Glass);
  if (!van) b.box(c1, g0, 1, c1, g1, W - 2, M.Glass);
  const sideEnd = van ? c0 + 6 : c1 - 1;
  b.box(c0 + 1, g0, 0, sideEnd, g1, 0, M.Glass).box(c0 + 1, g0, W - 1, sideEnd, g1, W - 1, M.Glass);
  if (!van) {
    const mid = Math.floor((c0 + c1) / 2);
    b.box(mid, g0, 0, mid, g1, 0, paint).box(mid, g0, W - 1, mid, g1, W - 1, paint);
  }
  // wheels (flush with the body sides)
  for (const wx of [3, L - 6]) {
    for (const wz of [0, W - 1]) {
      b.box(wx, 0, wz, wx + 2, 2, wz, M.Rubber);
      b.set(wx + 1, 1, wz, M.MetalDark);
    }
  }
  // lights, bumpers, engine block, seats
  b.set(0, 2, 1, M.Lamp).set(0, 2, W - 2, M.Lamp).set(L - 1, 2, 1, M.Neon).set(L - 1, 2, W - 2, M.Neon);
  b.box(0, 1, 0, 0, 1, W - 1, M.MetalDark).box(L - 1, 1, 0, L - 1, 1, W - 1, M.MetalDark);
  b.box(1, 2, 2, 4, 2, W - 3, M.MetalDark);
  b.box(c0 + 3, 2, 2, c0 + 4, 3, 3, M.Fabric).box(c0 + 3, 2, W - 4, c0 + 4, 3, W - 3, M.Fabric);
  return b;
}

function excavator(): VoxelModel {
  const b = new ModelBuilder(30, 17, 11);
  // tracks
  b.box(2, 0, 0, 15, 2, 2, M.MetalDark).box(2, 0, 8, 15, 2, 10, M.MetalDark);
  b.box(3, 1, 1, 14, 1, 1, M.Rubber).box(3, 1, 9, 14, 1, 9, M.Rubber);
  // turntable + house
  b.box(4, 3, 2, 13, 3, 8, M.MetalDark);
  b.shell(5, 4, 1, 16, 9, 9, M.PaintYellow);
  b.box(6, 5, 2, 15, 8, 8, M.MetalDark).box(11, 5, 2, 15, 8, 5, 0);
  // cab with glass
  b.shell(11, 4, 1, 16, 11, 5, M.PaintYellow);
  b.box(16, 6, 2, 16, 10, 4, M.Glass).box(12, 7, 1, 15, 10, 1, M.Glass);
  // boom, stick, bucket
  for (let i = 0; i < 9; i++) b.box(16 + i, 8 + Math.floor(i * 0.9), 6, 17 + i, 9 + Math.floor(i * 0.9), 7, M.PaintYellow);
  for (let i = 0; i < 9; i++) b.box(25 + Math.floor(i * 0.4), 15 - i, 6, 26 + Math.floor(i * 0.4), 16 - i, 7, M.PaintYellow);
  b.box(26, 4, 5, 29, 6, 8, M.MetalDark).box(27, 5, 6, 29, 6, 7, 0);
  return b;
}

export const PROPS: Record<PropType, PropDef> = {
  crate: { name: 'crate', build: () => crate(5), massScale: 0.14 },
  crateSmall: { name: 'box', build: () => crate(4), massScale: 0.12 },
  barrel: { name: 'barrel', build: (v) => barrel(v % 2 ? M.PaintBlue : M.MetalDark, M.SheetMetal), massScale: 0.4 },
  barrelExplosive: { name: 'fuel drum', build: () => barrel(M.Explosive, M.PaintYellow), massScale: 0.4, explosive: { power: 0.5, hp: 40 } },
  pallet: { name: 'pallet', build: pallet, massScale: 0.2 },
  concreteBlock: { name: 'concrete block', build: () => new ModelBuilder(5, 2, 2).box(0, 0, 0, 4, 1, 1, M.Concrete), massScale: 0.55 },
  chair: { name: 'chair', build: chair, massScale: 0.12 },
  table: { name: 'table', build: table, massScale: 0.2 },
  plank: { name: 'plank', build: () => new ModelBuilder(10, 1, 2).box(0, 0, 0, 9, 0, 1, M.Wood), massScale: 0.16 },
  steelBeam: { name: 'steel beam', build: () => new ModelBuilder(16, 2, 1).box(0, 0, 0, 15, 1, 0, M.Steel), massScale: 0.3 },
  tire: { name: 'tyre', build: tire, massScale: 0.4 },
  cone: { name: 'cone', build: cone, massScale: 0.2 },
  bin: { name: 'bin', build: bin, massScale: 0.1 },
  propane: { name: 'gas cylinder', build: propane, massScale: 0.35, explosive: { power: 0.42, hp: 30 } },
  toolbox: { name: 'toolbox', build: () => new ModelBuilder(3, 2, 2).box(0, 0, 0, 2, 1, 1, M.PaintRed).set(1, 1, 0, M.MetalDark), massScale: 0.8 },
  bricks: { name: 'brick stack', build: bricks, massScale: 0.25 },
  car: { name: 'car', build: (v) => car(v, false), massScale: 0.62, vehicle: true, explosive: { power: 0.62, hp: 420 } },
  van: { name: 'van', build: (v) => car(v, true), massScale: 0.6, vehicle: true, explosive: { power: 0.66, hp: 480 } },
  excavator: { name: 'excavator', build: excavator, massScale: 0.9 },
};

/** Footprint lookup for the world generator (sx, sy, sz before rotation). */
export function propSize(type: PropType, variant = 0): [number, number, number] {
  const m = PROPS[type].build(variant);
  return [m.sx, m.sy, m.sz];
}
