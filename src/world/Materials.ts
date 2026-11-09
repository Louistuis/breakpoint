/**
 * Voxel material table: physical properties used by the destruction engine and the
 * procedural texture atlas used by the renderer. Pure data + typed arrays so it can be
 * imported from the world-generation worker as well as the main thread.
 */
import type { SurfaceKind } from '../audio/types';
import { hash2, hash3, valueNoise, clamp } from '../utils/math';

/** Edge length of one voxel in metres. */
export const VOXEL = 0.2;
export const INV_VOXEL = 1 / VOXEL;
export const VOXEL_VOLUME = VOXEL * VOXEL * VOXEL;

export const M = {
  Air: 0,
  Bedrock: 1,
  Dirt: 2,
  Grass: 3,
  Asphalt: 4,
  Pavement: 5,
  Gravel: 6,
  Concrete: 7,
  Brick: 8,
  Wood: 9,
  WoodDark: 10,
  Steel: 11,
  Glass: 12,
  Plaster: 13,
  SheetMetal: 14,
  Leaves: 15,
  Bark: 16,
  RoadPaint: 17,
  PaintRed: 18,
  PaintBlue: 19,
  PaintYellow: 20,
  PaintWhite: 21,
  MetalDark: 22,
  Rubber: 23,
  Lamp: 24,
  Fabric: 25,
  Explosive: 26,
  Tile: 27,
  Neon: 28,
  Char: 29,
  RoofTile: 30,
  Porcelain: 31,
} as const;
export const MAT_COUNT = 32;

/** Fragment style spawned when a voxel of this material breaks. */
export const Frag = { Chunk: 0, Splinter: 1, Shard: 2, Sheet: 3, Dust: 4, Leaf: 5 } as const;

/** Flag bits in MAT_FLAGS. */
export const F_COLLIDE = 1; // participates in physics / blocks the player
export const F_OPAQUE = 2; // hides faces behind it and casts ambient occlusion
export const F_FLAMMABLE = 4;
export const F_TRANSPARENT = 8; // rendered in the glass pass
export const F_EMISSIVE = 16;
export const F_INDESTRUCTIBLE = 32;
export const F_BRITTLE_PANE = 64; // shatters as a whole connected pane

interface MatDef {
  name: string;
  /** Damage needed to destroy one voxel. */
  hp: number;
  /** Hits weaker than this do nothing at all (hardness). */
  min: number;
  /** Mass of one voxel in kg. */
  mass: number;
  /** Load in kg one voxel of cross-section can carry before crushing. */
  strength: number;
  surface: SurfaceKind;
  frag: number;
  flags: number;
  /** Representative linear-ish sRGB colour 0..255 used for particles and fragments. */
  color: [number, number, number];
  rough: number;
  metal: number;
  /** Emissive strength (colour comes from the texture). */
  emissive: number;
  /** Impact speed (m/s) above which a detached piece of this material fractures. */
  brittle: number;
}

const SOLID = F_COLLIDE | F_OPAQUE;
const defs: MatDef[] = [];
const def = (id: number, d: MatDef) => {
  defs[id] = d;
};

def(M.Air, { name: 'air', hp: 0, min: 0, mass: 0, strength: 0, surface: 'dirt', frag: Frag.Dust, flags: 0, color: [0, 0, 0], rough: 1, metal: 0, emissive: 0, brittle: 99 });
def(M.Bedrock, { name: 'bedrock', hp: 1e9, min: 1e9, mass: 25, strength: 1e9, surface: 'concrete', frag: Frag.Chunk, flags: SOLID | F_INDESTRUCTIBLE, color: [38, 38, 42], rough: 0.95, metal: 0, emissive: 0, brittle: 99 });
def(M.Dirt, { name: 'dirt', hp: 70, min: 22, mass: 12, strength: 4000, surface: 'dirt', frag: Frag.Dust, flags: SOLID, color: [92, 70, 50], rough: 1, metal: 0, emissive: 0, brittle: 2 });
def(M.Grass, { name: 'grass', hp: 60, min: 18, mass: 11, strength: 4000, surface: 'dirt', frag: Frag.Dust, flags: SOLID, color: [86, 112, 60], rough: 1, metal: 0, emissive: 0, brittle: 2 });
def(M.Asphalt, { name: 'asphalt', hp: 260, min: 70, mass: 18, strength: 8000, surface: 'concrete', frag: Frag.Chunk, flags: SOLID, color: [52, 53, 56], rough: 0.95, metal: 0, emissive: 0, brittle: 5 });
def(M.Pavement, { name: 'pavement', hp: 220, min: 60, mass: 18, strength: 8000, surface: 'concrete', frag: Frag.Chunk, flags: SOLID, color: [140, 138, 132], rough: 0.92, metal: 0, emissive: 0, brittle: 5 });
def(M.Gravel, { name: 'gravel', hp: 55, min: 14, mass: 13, strength: 4000, surface: 'dirt', frag: Frag.Dust, flags: SOLID, color: [128, 120, 108], rough: 1, metal: 0, emissive: 0, brittle: 2 });
def(M.Concrete, { name: 'concrete', hp: 240, min: 60, mass: 19, strength: 8000, surface: 'concrete', frag: Frag.Chunk, flags: SOLID, color: [150, 150, 146], rough: 0.9, metal: 0, emissive: 0, brittle: 5.5 });
def(M.Brick, { name: 'brick', hp: 90, min: 28, mass: 14, strength: 4000, surface: 'brick', frag: Frag.Chunk, flags: SOLID, color: [142, 78, 60], rough: 0.92, metal: 0, emissive: 0, brittle: 3.6 });
def(M.Wood, { name: 'wood', hp: 40, min: 8, mass: 5, strength: 1500, surface: 'wood', frag: Frag.Splinter, flags: SOLID | F_FLAMMABLE, color: [176, 138, 92], rough: 0.82, metal: 0, emissive: 0, brittle: 6.5 });
def(M.WoodDark, { name: 'timber', hp: 55, min: 10, mass: 6, strength: 2200, surface: 'wood', frag: Frag.Splinter, flags: SOLID | F_FLAMMABLE, color: [98, 68, 44], rough: 0.8, metal: 0, emissive: 0, brittle: 7 });
def(M.Steel, { name: 'steel', hp: 900, min: 250, mass: 30, strength: 150000, surface: 'metal', frag: Frag.Sheet, flags: SOLID, color: [96, 104, 114], rough: 0.42, metal: 0.92, emissive: 0, brittle: 60 });
def(M.Glass, { name: 'glass', hp: 6, min: 1, mass: 5, strength: 150, surface: 'glass', frag: Frag.Shard, flags: F_COLLIDE | F_TRANSPARENT | F_BRITTLE_PANE, color: [170, 214, 220], rough: 0.05, metal: 0, emissive: 0, brittle: 1 });
def(M.Plaster, { name: 'plaster', hp: 28, min: 6, mass: 6, strength: 800, surface: 'plaster', frag: Frag.Chunk, flags: SOLID, color: [214, 208, 196], rough: 0.95, metal: 0, emissive: 0, brittle: 2.8 });
def(M.SheetMetal, { name: 'sheet metal', hp: 150, min: 40, mass: 3, strength: 6000, surface: 'metal', frag: Frag.Sheet, flags: SOLID, color: [136, 146, 152], rough: 0.5, metal: 0.8, emissive: 0, brittle: 30 });
def(M.Leaves, { name: 'leaves', hp: 6, min: 1, mass: 0.4, strength: 20, surface: 'foliage', frag: Frag.Leaf, flags: F_OPAQUE | F_FLAMMABLE, color: [74, 104, 58], rough: 0.85, metal: 0, emissive: 0, brittle: 99 });
def(M.Bark, { name: 'bark', hp: 70, min: 15, mass: 6, strength: 3000, surface: 'wood', frag: Frag.Splinter, flags: SOLID | F_FLAMMABLE, color: [74, 56, 42], rough: 0.95, metal: 0, emissive: 0, brittle: 9 });
def(M.RoadPaint, { name: 'road paint', hp: 260, min: 70, mass: 18, strength: 8000, surface: 'concrete', frag: Frag.Chunk, flags: SOLID, color: [206, 204, 192], rough: 0.85, metal: 0, emissive: 0, brittle: 5 });
def(M.PaintRed, { name: 'painted steel', hp: 170, min: 45, mass: 2.5, strength: 6000, surface: 'metal', frag: Frag.Sheet, flags: SOLID, color: [150, 58, 44], rough: 0.5, metal: 0.35, emissive: 0, brittle: 30 });
def(M.PaintBlue, { name: 'painted steel', hp: 170, min: 45, mass: 2.5, strength: 6000, surface: 'metal', frag: Frag.Sheet, flags: SOLID, color: [50, 84, 108], rough: 0.5, metal: 0.35, emissive: 0, brittle: 30 });
def(M.PaintYellow, { name: 'painted steel', hp: 170, min: 45, mass: 2.5, strength: 6000, surface: 'metal', frag: Frag.Sheet, flags: SOLID, color: [214, 164, 42], rough: 0.45, metal: 0.3, emissive: 0, brittle: 30 });
def(M.PaintWhite, { name: 'painted steel', hp: 170, min: 45, mass: 2.5, strength: 6000, surface: 'metal', frag: Frag.Sheet, flags: SOLID, color: [222, 222, 216], rough: 0.4, metal: 0.3, emissive: 0, brittle: 30 });
def(M.MetalDark, { name: 'machinery', hp: 400, min: 120, mass: 12, strength: 40000, surface: 'metal', frag: Frag.Sheet, flags: SOLID, color: [52, 56, 62], rough: 0.5, metal: 0.85, emissive: 0, brittle: 50 });
def(M.Rubber, { name: 'rubber', hp: 60, min: 15, mass: 4, strength: 800, surface: 'rubber', frag: Frag.Chunk, flags: SOLID | F_FLAMMABLE, color: [26, 26, 28], rough: 0.95, metal: 0, emissive: 0, brittle: 40 });
def(M.Lamp, { name: 'lamp', hp: 10, min: 1, mass: 3, strength: 100, surface: 'glass', frag: Frag.Shard, flags: SOLID | F_EMISSIVE, color: [255, 236, 200], rough: 0.4, metal: 0, emissive: 3.2, brittle: 1 });
def(M.Fabric, { name: 'fabric', hp: 25, min: 5, mass: 2, strength: 100, surface: 'foliage', frag: Frag.Leaf, flags: SOLID | F_FLAMMABLE, color: [84, 104, 116], rough: 1, metal: 0, emissive: 0, brittle: 99 });
def(M.Explosive, { name: 'fuel', hp: 55, min: 10, mass: 3, strength: 2000, surface: 'metal', frag: Frag.Sheet, flags: SOLID, color: [190, 48, 36], rough: 0.5, metal: 0.3, emissive: 0, brittle: 30 });
def(M.Tile, { name: 'tile', hp: 80, min: 25, mass: 10, strength: 3000, surface: 'concrete', frag: Frag.Shard, flags: SOLID, color: [196, 200, 194], rough: 0.3, metal: 0, emissive: 0, brittle: 2.5 });
def(M.Neon, { name: 'sign', hp: 10, min: 1, mass: 3, strength: 100, surface: 'glass', frag: Frag.Shard, flags: SOLID | F_EMISSIVE, color: [255, 120, 40], rough: 0.4, metal: 0, emissive: 2.6, brittle: 1 });
def(M.Char, { name: 'char', hp: 12, min: 2, mass: 2, strength: 100, surface: 'wood', frag: Frag.Dust, flags: SOLID, color: [24, 22, 21], rough: 1, metal: 0, emissive: 0, brittle: 1.5 });
def(M.RoofTile, { name: 'roof tile', hp: 70, min: 20, mass: 8, strength: 1500, surface: 'brick', frag: Frag.Shard, flags: SOLID, color: [72, 78, 88], rough: 0.8, metal: 0, emissive: 0, brittle: 2.5 });
def(M.Porcelain, { name: 'porcelain', hp: 60, min: 18, mass: 8, strength: 1500, surface: 'glass', frag: Frag.Shard, flags: SOLID, color: [232, 232, 228], rough: 0.15, metal: 0, emissive: 0, brittle: 2 });

export const MATERIALS: readonly MatDef[] = defs;
export const MAT_HP = new Float32Array(MAT_COUNT);
export const MAT_MIN = new Float32Array(MAT_COUNT);
export const MAT_MASS = new Float32Array(MAT_COUNT);
export const MAT_STRENGTH = new Float32Array(MAT_COUNT);
export const MAT_FLAGS = new Uint8Array(MAT_COUNT);
export const MAT_FRAG = new Uint8Array(MAT_COUNT);
export const MAT_BRITTLE = new Float32Array(MAT_COUNT);
/** 1 when the material blocks movement / is part of the physics collider. */
export const MAT_COLLIDE = new Uint8Array(MAT_COUNT);
export const MAT_OPAQUE = new Uint8Array(MAT_COUNT);
export const MAT_SURFACE: SurfaceKind[] = [];
/** Colours as 0..1 floats, 3 per material. */
export const MAT_COLOR = new Float32Array(MAT_COUNT * 3);

for (let i = 0; i < MAT_COUNT; i++) {
  const d = defs[i];
  MAT_HP[i] = d.hp;
  MAT_MIN[i] = d.min;
  MAT_MASS[i] = d.mass;
  MAT_STRENGTH[i] = d.strength;
  MAT_FLAGS[i] = d.flags;
  MAT_FRAG[i] = d.frag;
  MAT_BRITTLE[i] = d.brittle;
  MAT_COLLIDE[i] = d.flags & F_COLLIDE ? 1 : 0;
  MAT_OPAQUE[i] = d.flags & F_OPAQUE ? 1 : 0;
  MAT_SURFACE[i] = d.surface;
  MAT_COLOR[i * 3] = d.color[0] / 255;
  MAT_COLOR[i * 3 + 1] = d.color[1] / 255;
  MAT_COLOR[i * 3 + 2] = d.color[2] / 255;
}

// ---------------------------------------------------------------------------
// Procedural texture atlas (one layer per material, tiles every 16 voxels).
// ---------------------------------------------------------------------------
export const TEX_SIZE = 128;
/** Texture period in voxels. Chunk size and body texture offsets are multiples of this. */
export const TEX_PERIOD = 16;
const PX = TEX_SIZE / TEX_PERIOD; // pixels per voxel (8)

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];

/** Per-texel colour for a material. u,v are pixel coordinates; v grows upward. */
function texel(id: number, u: number, v: number): RGB {
  const base = defs[id].color as RGB;
  const vx = Math.floor(u / PX);
  const vy = Math.floor(v / PX);
  const fu = u % PX;
  const fv = v % PX;
  const grain = hash3(u, v, id) - 0.5;
  const blotch = valueNoise(u / 16, v / 16, 8, 8, id) - 0.5;
  const fine = valueNoise(u / 4, v / 4, 32, 32, id + 40) - 0.5;
  switch (id) {
    case M.Brick: {
      const off = vy & 1 ? PX : 0;
      const bx = (u + off) % (PX * 2);
      if (fv === 0 || bx === 0) return mul([168, 160, 150], 0.82 + grain * 0.12);
      const bi = Math.floor((u + off) / (PX * 2));
      const tone = hash3(bi, vy, 5);
      const c = mix([126, 66, 52], [164, 96, 70], tone);
      const edge = fv === PX - 1 || bx === 1 ? 1.07 : fv === 1 ? 0.9 : 1;
      return mul(c, (0.92 + grain * 0.16 + fine * 0.1) * edge);
    }
    case M.Concrete: {
      let k = 0.95 + blotch * 0.16 + grain * 0.07 + fine * 0.06;
      if (v % (PX * 8) === 0) k *= 0.84; // pour seam
      const hx = u % (PX * 4);
      const hy = v % (PX * 4);
      if (hx >= 15 && hx <= 16 && hy >= 15 && hy <= 16) k *= 0.62; // form-tie hole
      if (hash3(u, v, 91) > 0.985) k *= 0.8;
      return mul(base, k);
    }
    case M.Wood:
    case M.WoodDark: {
      const tone = hash3(vy, 3, id);
      const streak = valueNoise(u / 8, vy, 16, 16, id + 60) - 0.5;
      let k = 0.9 + tone * 0.2 + streak * 0.22 + grain * 0.06;
      if (fv === 0) k *= 0.6; // plank seam
      if ((u + vy * 37) % 64 === 0) k *= 0.62; // butt joint
      const knot = hash3(Math.floor(u / 16), vy, 77);
      if (knot > 0.93 && fu > 2 && fu < 5 && fv > 2 && fv < 6) k *= 0.7;
      return mul(base, k);
    }
    case M.Steel: {
      let k = 0.92 + (hash2(v, 3) - 0.5) * 0.12 + grain * 0.05 + blotch * 0.1;
      if (u % (PX * 8) === 0 || v % (PX * 8) === 0) k *= 0.78;
      const rx = u % (PX * 4);
      const ry = v % (PX * 4);
      if (rx >= 3 && rx <= 4 && ry >= 3 && ry <= 4) k *= rx === 3 && ry === 4 ? 1.35 : 0.7; // rivet
      const c = mul(base, k);
      const rust = valueNoise(u / 16, v / 16, 8, 8, 300);
      return rust > 0.74 ? mix(c, [124, 76, 46], (rust - 0.74) * 2.4) : c;
    }
    case M.SheetMetal: {
      const rib = 0.84 + 0.2 * Math.cos((u / PX) * Math.PI * 2);
      const c = mul(base, rib * (0.96 + grain * 0.05 + blotch * 0.08) * (v % (PX * 8) === 0 ? 0.8 : 1));
      const rust = valueNoise(u / 4, v / 32, 32, 4, 301);
      return rust > 0.8 ? mix(c, [130, 84, 54], (rust - 0.8) * 3) : c;
    }
    case M.PaintRed:
    case M.PaintBlue: {
      const rib = 0.86 + 0.18 * Math.cos((u / PX) * Math.PI * 2);
      let c = mul(base, rib * (0.96 + grain * 0.05 + blotch * 0.12));
      if (v % (PX * 8) < 1) c = mul(c, 0.78);
      const chip = valueNoise(u / 4, v / 4, 32, 32, id + 9);
      if (chip > 0.86) c = mix(c, [112, 72, 52], 0.7);
      return c;
    }
    case M.PaintYellow:
    case M.PaintWhite: {
      let k = 0.97 + blotch * 0.08 + grain * 0.03;
      if (u % (PX * 8) === 0 || v % (PX * 8) === 0) k *= 0.82;
      const scratch = hash3(Math.floor(u / 3), v, id + 3);
      if (scratch > 0.988) k *= 0.8;
      return mul(base, k);
    }
    case M.MetalDark: {
      let k = 0.95 + grain * 0.1 + blotch * 0.14;
      if (u % (PX * 4) === 0 || v % (PX * 4) === 0) k *= 0.75;
      return mul(base, k);
    }
    case M.Plaster:
      return mul(base, 0.97 + blotch * 0.05 + grain * 0.03 + fine * 0.03);
    case M.Porcelain:
      return mul(base, 0.99 + grain * 0.02);
    case M.Glass:
      return mul(base, 1);
    case M.Leaves: {
      const cluster = valueNoise(u / 4, v / 4, 32, 32, 501);
      const c = cluster > 0.62 ? [96, 128, 66] : cluster > 0.38 ? [72, 104, 56] : [52, 82, 46];
      const hole = hash3(Math.floor(u / 2), Math.floor(v / 2), 502) < 0.1 ? 0.62 : 1;
      return mul(c as RGB, (0.94 + grain * 0.14) * hole);
    }
    case M.Bark: {
      const streak = valueNoise(u / 2, v / 16, 64, 8, 510);
      return mul(base, (streak < 0.34 ? 0.62 : 0.9 + streak * 0.3) * (1 + grain * 0.1));
    }
    case M.Asphalt: {
      let k = 0.94 + blotch * 0.14 + grain * 0.1;
      const agg = hash3(u, v, 520);
      if (agg > 0.94) k *= 1.5;
      else if (agg < 0.05) k *= 0.72;
      return mul(base, k);
    }
    case M.RoadPaint: {
      const wear = valueNoise(u / 8, v / 8, 16, 16, 530);
      const k = 0.94 + grain * 0.06;
      return wear < 0.24 ? mul([72, 72, 74], 1 + grain * 0.2) : mul(base, k);
    }
    case M.Pavement: {
      const sx = Math.floor(u / (PX * 4));
      const sy = Math.floor(v / (PX * 4));
      let k = 0.9 + hash3(sx, sy, 540) * 0.14 + grain * 0.06 + fine * 0.05;
      if (u % (PX * 4) === 0 || v % (PX * 4) === 0) k *= 0.66;
      return mul(base, k);
    }
    case M.Gravel: {
      const t = hash3(Math.floor(u / 2), Math.floor(v / 2), 550);
      const c: RGB = t > 0.66 ? [150, 144, 132] : t > 0.33 ? [122, 114, 102] : [96, 90, 82];
      return mul(c, 0.94 + grain * 0.14);
    }
    case M.Dirt: {
      let k = 0.92 + blotch * 0.2 + grain * 0.12;
      if (hash3(Math.floor(u / 2), Math.floor(v / 2), 560) > 0.94) k *= 1.35;
      return mul(base, k);
    }
    case M.Grass: {
      const patch = valueNoise(u / 16, v / 16, 8, 8, 570);
      const blade = hash3(u, Math.floor(v / 2), 571);
      const c = mix([70, 100, 52], [106, 126, 64], patch);
      return mul(c, blade > 0.7 ? 1.14 : blade < 0.2 ? 0.82 : 1);
    }
    case M.Rubber: {
      const tread = (u + v) % 6 < 2 ? 0.7 : 1;
      return mul(base, tread * (0.95 + grain * 0.2) + 0.02);
    }
    case M.Lamp:
      return mul(base, 1);
    case M.Neon:
      return mul(base, 1);
    case M.Fabric: {
      const weave = ((u >> 1) + (v >> 1)) & 1 ? 1.06 : 0.92;
      return mul(base, weave * (0.97 + grain * 0.06 + blotch * 0.08));
    }
    case M.Explosive: {
      const band = vy % 8;
      if (band === 3 || band === 4) return (u + v) % 16 < 8 ? [222, 176, 38] : [30, 28, 26];
      return mul(base, 0.96 + grain * 0.05 + blotch * 0.1);
    }
    case M.Tile: {
      const tx = Math.floor(u / (PX * 2));
      const ty = Math.floor(v / (PX * 2));
      if (u % (PX * 2) === 0 || v % (PX * 2) === 0) return [150, 152, 148];
      return mul((tx + ty) & 1 ? [206, 210, 204] : [186, 192, 188], 0.98 + grain * 0.03);
    }
    case M.Char: {
      const ash = hash3(u, v, 580);
      if (ash > 0.975) return [150, 70, 30];
      return mul(base, ash > 0.9 ? 2.4 : 0.9 + grain * 0.5);
    }
    case M.RoofTile: {
      const off = vy & 1 ? PX : 0;
      const tx = (u + off) % (PX * 2);
      let k = 0.94 + hash3(Math.floor((u + off) / (PX * 2)), vy, 590) * 0.14 + grain * 0.06;
      if (fv === 0) k *= 0.6;
      else if (fv === PX - 1) k *= 1.1;
      if (tx === 0) k *= 0.74;
      return mul(base, k);
    }
    case M.Bedrock:
      return mul(base, 0.9 + blotch * 0.3 + grain * 0.1);
    default:
      return mul(base, 0.95 + grain * 0.08);
  }
}

/** RGBA8 pixel data for a DataArrayTexture: MAT_COUNT layers of TEX_SIZE². Alpha = roughness detail. */
export function buildMaterialAtlas(): Uint8Array {
  const out = new Uint8Array(TEX_SIZE * TEX_SIZE * 4 * MAT_COUNT);
  let p = 0;
  for (let id = 0; id < MAT_COUNT; id++) {
    for (let v = 0; v < TEX_SIZE; v++) {
      for (let u = 0; u < TEX_SIZE; u++) {
        const c = id === 0 ? ([0, 0, 0] as RGB) : texel(id, u, v);
        const lum = (c[0] + c[1] + c[2]) / (3 * 255);
        out[p++] = clamp(Math.round(c[0]), 0, 255);
        out[p++] = clamp(Math.round(c[1]), 0, 255);
        out[p++] = clamp(Math.round(c[2]), 0, 255);
        // brighter texels read as slightly smoother (worn edges, paint), darker as rougher (seams, dirt)
        out[p++] = clamp(Math.round(255 * (1.08 - lum * 0.35)), 96, 255);
      }
    }
  }
  return out;
}

/** Roughness / metalness / emissive per material packed for a shader uniform (vec3 × MAT_COUNT). */
export function buildMaterialParams(): Float32Array {
  const out = new Float32Array(MAT_COUNT * 3);
  for (let i = 0; i < MAT_COUNT; i++) {
    out[i * 3] = defs[i].rough;
    out[i * 3 + 1] = defs[i].metal;
    out[i * 3 + 2] = defs[i].emissive;
  }
  return out;
}
