/**
 * Deterministic generator for the Kestrel Yard industrial district.
 * Runs inside the world-generation worker: writes voxels straight into the grid and
 * returns metadata (spawn point, movable props, challenge regions, explosive zones).
 */
import { GROUND_Y, type VoxelGrid } from '../destruction/VoxelGrid';
import { mulberry32 } from '../utils/math';
import { M, VOXEL } from './Materials';
import { PROPS, rotateModelY, type PropType } from './Props';
import { buildConstructionSite, buildGasStation, buildResidential, buildWarehouse } from './Buildings';

export interface PropSpawn {
  type: PropType;
  /** Voxel coordinates of the model's minimum corner. */
  x: number;
  y: number;
  z: number;
  /** Quarter turns about the vertical axis. */
  rot: number;
  variant: number;
}

export interface StructureRegion {
  key: 'residential' | 'gasstation' | 'construction' | 'warehouse';
  name: string;
  /** Inclusive voxel bounds. */
  min: [number, number, number];
  max: [number, number, number];
}

export interface ExplosiveZone {
  name: string;
  min: [number, number, number];
  max: [number, number, number];
  /** Blast scale (see ExplosionSystem). */
  power: number;
}

export interface DoorSpawn {
  /** Voxel coordinates of the door leaf's minimum corner. */
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  /** Axis the closed door lies along. */
  axis: 'x' | 'z';
  /** Hinge at the low (0) or high (1) end of that axis. */
  hinge: 0 | 1;
  mat: number;
}

export interface WorldMeta {
  spawn: { x: number; y: number; z: number; yaw: number };
  props: PropSpawn[];
  regions: StructureRegion[];
  zones: ExplosiveZone[];
  doors: DoorSpawn[];
}

/** First free layer above the terrain. */
export const G = GROUND_Y;

/** Voxel drawing helper shared by all building generators. */
export class Builder {
  readonly rnd: () => number;
  readonly meta: WorldMeta = { spawn: { x: 0, y: 0, z: 0, yaw: 0 }, props: [], regions: [], zones: [], doors: [] };

  constructor(readonly g: VoxelGrid, seed: number) {
    this.rnd = mulberry32(seed);
  }

  set(x: number, y: number, z: number, m: number): void {
    this.g.setRaw(x, y, z, m);
  }
  get(x: number, y: number, z: number): number {
    return this.g.mat(x, y, z);
  }
  /** Inclusive box. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number): void {
    this.g.fillRaw(x0, y0, z0, x1, y1, z1, m);
  }
  clear(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.g.fillRaw(x0, y0, z0, x1, y1, z1, 0);
  }
  /** Four walls of thickness t around an inclusive footprint (no floor/roof). */
  walls(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number, t = 1): void {
    this.box(x0, y0, z0, x1, y1, z0 + t - 1, m);
    this.box(x0, y0, z1 - t + 1, x1, y1, z1, m);
    this.box(x0, y0, z0, x0 + t - 1, y1, z1, m);
    this.box(x1 - t + 1, y0, z0, x1, y1, z1, m);
  }
  /** Replace only empty cells. */
  fillAir(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number): void {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (!this.g.mat(x, y, z)) this.g.setRaw(x, y, z, m);
  }
  /** Repaint the terrain surface (two layers deep) inside a rectangle. */
  surface(x0: number, z0: number, x1: number, z1: number, m: number): void {
    this.box(x0, G - 2, z0, x1, G - 1, z1, m);
  }
  /** 6-connected voxel line between two points (every voxel shares a face with the next, so it holds together structurally). */
  line(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
    let cx = x0;
    let cy = y0;
    let cz = z0;
    this.set(cx, cy, cz, m);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const tx = Math.round(x0 + (x1 - x0) * t);
      const ty = Math.round(y0 + (y1 - y0) * t);
      const tz = Math.round(z0 + (z1 - z0) * t);
      while (cx !== tx) this.set((cx += Math.sign(tx - cx)), cy, cz, m);
      while (cy !== ty) this.set(cx, (cy += Math.sign(ty - cy)), cz, m);
      while (cz !== tz) this.set(cx, cy, (cz += Math.sign(tz - cz)), m);
    }
  }
  /** Glazed opening through a wall of thickness t lying on a constant-z plane. Glass sits in the outer layer. */
  windowZ(x0: number, y0: number, x1: number, y1: number, zOuter: number, zInner: number): void {
    this.clear(x0, y0, Math.min(zOuter, zInner), x1, y1, Math.max(zOuter, zInner));
    this.box(x0, y0, zOuter, x1, y1, zOuter, M.Glass);
  }
  windowX(z0: number, y0: number, z1: number, y1: number, xOuter: number, xInner: number): void {
    this.clear(Math.min(xOuter, xInner), y0, z0, Math.max(xOuter, xInner), y1, z1);
    this.box(xOuter, y0, z0, xOuter, y1, z1, M.Glass);
  }
  prop(type: PropType, x: number, y: number, z: number, rot = 0, variant = 0): void {
    this.meta.props.push({ type, x, y, z, rot, variant });
  }
  /** Stamp a prop model into the static world (furniture that is part of the building). */
  stamp(type: PropType, x: number, y: number, z: number, rot = 0, variant = 0): void {
    const m = rotateModelY(PROPS[type].build(variant), rot);
    for (let yy = 0; yy < m.sy; yy++)
      for (let zz = 0; zz < m.sz; zz++)
        for (let xx = 0; xx < m.sx; xx++) {
          const v = m.vox[xx + m.sx * (zz + m.sz * yy)];
          if (v) this.set(x + xx, y + yy, z + zz, v);
        }
  }
  /** Deciduous tree: bark trunk with a noisy leaf crown. */
  tree(x: number, z: number, height: number, radius: number, base = G): void {
    this.box(x, base, z, x + 1, base + height, z + 1, M.Bark);
    const cy = base + height + Math.floor(radius * 0.5);
    for (let dy = -radius; dy <= radius; dy++)
      for (let dz = -radius; dz <= radius; dz++)
        for (let dx = -radius; dx <= radius; dx++) {
          const d = Math.sqrt(dx * dx + dy * dy * 1.5 + dz * dz) + (this.rnd() - 0.5) * 1.8;
          if (d < radius && !this.get(x + dx, cy + dy, z + dz)) this.set(x + dx, cy + dy, z + dz, M.Leaves);
        }
    // a few branches so the crown is structurally attached
    this.line(x, base + height - 2, z, x - 3, base + height + 2, z - 1, M.Bark);
    this.line(x + 1, base + height - 3, z + 1, x + 4, base + height + 1, z + 2, M.Bark);
  }
  /** Street light: steel pole on the pavement with an arm reaching over the road. */
  streetLight(x: number, z: number, dx: number, dz: number, base = G + 1): void {
    this.box(x, base, z, x, base + 26, z, M.Steel);
    this.box(x - (dz ? 1 : 0), base, z - (dx ? 1 : 0), x + (dz ? 1 : 0), base + 1, z + (dx ? 1 : 0), M.MetalDark);
    for (let i = 1; i <= 7; i++) this.set(x + dx * i, base + 26, z + dz * i, M.Steel);
    this.box(x + dx * 5, base + 25, z + dz * 5, x + dx * 7, base + 25, z + dz * 7, M.Lamp);
  }
}

export const WORLD_SEED = 20261109;

export function generateWorld(grid: VoxelGrid, seed = WORLD_SEED): WorldMeta {
  const b = new Builder(grid, seed);
  const { nx, nz } = grid;
  const X1 = nx - 1;
  const Z1 = nz - 1;

  // --- terrain -------------------------------------------------------------
  b.box(0, 0, 0, X1, 0, Z1, M.Bedrock);
  b.box(0, 1, 0, X1, G - 3, Z1, M.Dirt);
  b.box(0, G - 2, 0, X1, G - 1, Z1, M.Pavement);
  b.surface(8, 8, 195, 195, M.Pavement); // NW: warehouse yard
  b.surface(252, 8, 439, 195, M.Asphalt); // NE: fuel station forecourt
  b.surface(8, 252, 195, 439, M.Grass); // SW: residential lot
  b.surface(252, 252, 439, 439, M.Gravel); // SE: construction site
  for (let z = 252; z <= 439; z++)
    for (let x = 8; x <= 195; x++) if (b.rnd() < 0.012) b.set(x, G - 1, z, M.Dirt);
  for (let z = 252; z <= 439; z++)
    for (let x = 252; x <= 439; x++) if (b.rnd() < 0.08) b.set(x, G - 1, z, M.Dirt);

  // --- roads + raised pavements ---------------------------------------------
  b.surface(0, 204, X1, 243, M.Asphalt);
  b.surface(204, 0, 243, Z1, M.Asphalt);
  for (const [a0, a1] of [[196, 203], [244, 251]] as const) {
    b.box(0, G, a0, X1, G, a1, M.Pavement);
    b.box(a0, G, 0, a1, G, Z1, M.Pavement);
  }
  b.clear(204, G, 0, 243, G, Z1);
  b.clear(0, G, 204, X1, G, 243);
  // lane markings
  for (let i = 10; i < nx - 10; i += 14) {
    if (i < 190 || i > 256) {
      b.box(i, G - 1, 223, i + 6, G - 1, 224, M.RoadPaint);
      b.box(223, G - 1, i, 224, G - 1, i + 6, M.RoadPaint);
    }
  }
  // zebra crossings on the four arms of the junction
  for (let i = 206; i <= 239; i += 5) {
    b.box(i, G - 1, 197, i + 2, G - 1, 202, M.RoadPaint);
    b.box(i, G - 1, 245, i + 2, G - 1, 250, M.RoadPaint);
    b.box(197, G - 1, i, 202, G - 1, i + 2, M.RoadPaint);
    b.box(245, G - 1, i, 250, G - 1, i + 2, M.RoadPaint);
  }

  // --- perimeter wall with steel gates at the road ends ----------------------
  b.walls(6, G, 6, X1 - 6, G + 13, Z1 - 6, M.Concrete, 2);
  for (let i = 30; i < nx - 30; i += 24) {
    b.box(i, G, 5, i + 1, G + 15, 8, M.Concrete);
    b.box(i, G, Z1 - 8, i + 1, G + 15, Z1 - 5, M.Concrete);
    b.box(5, G, i, 8, G + 15, i + 1, M.Concrete);
    b.box(X1 - 8, G, i, X1 - 5, G + 15, i + 1, M.Concrete);
  }
  for (const gz of [6, Z1 - 7]) {
    b.clear(204, G, gz, 243, G + 13, gz + 1);
    b.box(204, G, gz, 243, G + 11, gz, M.SheetMetal);
    b.box(204, G + 5, gz, 243, G + 6, gz, M.PaintYellow);
    b.box(203, G, gz - 1, 203, G + 14, gz + 2, M.Steel);
    b.box(244, G, gz - 1, 244, G + 14, gz + 2, M.Steel);
  }
  for (const gx of [6, X1 - 7]) {
    b.clear(gx, G, 204, gx + 1, G + 13, 243);
    b.box(gx, G, 204, gx, G + 11, 243, M.SheetMetal);
    b.box(gx, G + 5, 204, gx, G + 6, 243, M.PaintYellow);
    b.box(gx - 1, G, 203, gx + 2, G + 14, 203, M.Steel);
    b.box(gx - 1, G, 244, gx + 2, G + 14, 244, M.Steel);
  }

  // --- the four lots ---------------------------------------------------------
  buildWarehouse(b);
  buildGasStation(b);
  buildResidential(b);
  buildConstructionSite(b);

  // --- street furniture --------------------------------------------------------
  for (const p of [56, 150, 298, 392]) {
    b.streetLight(p, 198, 0, 1);
    b.streetLight(p + 22, 249, 0, -1);
    b.streetLight(198, p, 1, 0);
    b.streetLight(249, p + 22, -1, 0);
  }
  for (const [tx, tz, h, r] of [[100, 246, 15, 7], [176, 247, 17, 8], [276, 198, 14, 6], [420, 199, 16, 7], [247, 100, 15, 7], [198, 290, 16, 7], [247, 412, 15, 6]] as const) {
    b.tree(tx, tz, h, r, G + 1);
  }
  // bus shelter (steel frame, glass panels, bench) on the north pavement
  b.box(112, G + 1, 197, 112, G + 12, 197, M.Steel);
  b.box(138, G + 1, 197, 138, G + 12, 197, M.Steel);
  b.box(112, G + 1, 201, 112, G + 12, 201, M.Steel);
  b.box(138, G + 1, 201, 138, G + 12, 201, M.Steel);
  b.box(111, G + 13, 196, 139, G + 13, 202, M.SheetMetal);
  b.box(113, G + 2, 197, 137, G + 11, 197, M.Glass);
  b.box(112, G + 2, 198, 112, G + 11, 200, M.Glass);
  b.box(138, G + 2, 198, 138, G + 11, 200, M.Glass);
  b.box(116, G + 3, 198, 134, G + 3, 199, M.WoodDark);
  b.box(117, G + 1, 198, 117, G + 2, 198, M.Steel);
  b.box(133, G + 1, 198, 133, G + 2, 198, M.Steel);
  // hydrant, bins, road cones, scattered tyres
  b.box(260, G + 1, 247, 261, G + 3, 248, M.PaintRed);
  b.set(260, G + 4, 247, M.PaintRed);
  b.prop('bin', 146, G + 1, 199);
  b.prop('bin', 249, G + 1, 262);
  for (const [cx, cz] of [[212, 150], [218, 153], [226, 151], [233, 154]] as const) b.prop('cone', cx, G, cz);

  b.meta.spawn = { x: 229 * VOXEL, y: G * VOXEL, z: 300 * VOXEL, yaw: 0 };
  return b.meta;
}
