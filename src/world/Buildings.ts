/**
 * The four lots of the district. Every structure is built voxel by voxel with real
 * load paths (columns, beams, joists, 6-connected stairs) so the structural solver has
 * something meaningful to collapse.
 */
import { M } from './Materials';
import { G, type Builder } from './WorldGenerator';

const GOODS = [M.PaintRed, M.PaintBlue, M.PaintYellow, M.PaintWhite, M.Fabric];

/** Shipping container shell with a framed door end. Long axis along z. */
function container(b: Builder, x: number, y: number, z: number, mat: number, open = false): void {
  b.box(x, y, z, x + 11, y + 12, z + 29, mat);
  b.clear(x + 1, y + 1, z + 1, x + 10, y + 11, z + 28);
  b.box(x, y, z, x + 11, y, z + 29, M.MetalDark);
  for (const [cx, cz] of [[x, z], [x + 11, z], [x, z + 29], [x + 11, z + 29]] as const) b.box(cx, y, cz, cx, y + 12, cz, M.MetalDark);
  if (open) b.clear(x + 1, y + 1, z + 29, x + 10, y + 11, z + 29);
  else {
    b.box(x + 5, y + 1, z + 29, x + 6, y + 11, z + 29, M.MetalDark);
    b.box(x + 3, y + 5, z + 29, x + 3, y + 7, z + 29, M.Steel);
    b.box(x + 8, y + 5, z + 29, x + 8, y + 7, z + 29, M.Steel);
  }
}

/** Pallet racking along z with timber decks and a random load of boxes. */
function rack(b: Builder, x: number, z0: number, z1: number): void {
  for (let z = z0; z <= z1; z += 12) {
    b.box(x, G, z, x, G + 22, z, M.Steel);
    b.box(x + 5, G, z, x + 5, G + 22, z, M.Steel);
    b.box(x, G + 22, z, x + 5, G + 22, z, M.Steel);
  }
  for (const y of [G + 6, G + 13, G + 20]) {
    b.box(x, y, z0, x, y, z1, M.Steel);
    b.box(x + 5, y, z0, x + 5, y, z1, M.Steel);
    b.box(x + 1, y, z0, x + 4, y, z1, M.Wood);
    for (let z = z0 + 1; z < z1 - 5; z += 6) {
      const r = b.rnd();
      if (r < 0.45) b.stamp('crateSmall', x + 1, y + 1, z);
      else if (r < 0.6) b.box(x + 1, y + 1, z, x + 4, y + 2 + Math.floor(b.rnd() * 2), z + 3, GOODS[Math.floor(b.rnd() * 4)]);
    }
  }
}

// ---------------------------------------------------------------------------
// NW lot: Kestrel Freight warehouse
// ---------------------------------------------------------------------------
export function buildWarehouse(b: Builder): void {
  const x0 = 40, x1 = 159, z0 = 36, z1 = 115, H = 30;
  const top = G + H - 1;
  const roofY = (z: number) => G + H + Math.floor((40 - Math.abs(z - 75.5)) / 5);
  const frames = [40, 64, 88, 112, 136, 158];

  b.surface(x0, z0, x1, z1, M.Concrete);
  b.walls(x0, G, z0, x1, top, z1, M.Brick, 2);
  for (let z = z0; z <= z1; z++) {
    const ry = roofY(z) - 1;
    if (ry >= G + H) {
      b.box(x0, G + H, z, x0 + 1, ry, z, M.Brick);
      b.box(x1 - 1, G + H, z, x1, ry, z, M.Brick);
    }
  }
  // steel portal frames: columns in the walls, trusses across the hall
  for (const fx of frames) {
    b.box(fx, G, z0, fx + 1, top, z0 + 1, M.Steel);
    b.box(fx, G, z1 - 1, fx + 1, top, z1, M.Steel);
    b.box(fx, G + 27, z0 + 2, fx + 1, G + 28, z1 - 2, M.Steel);
    for (let z = z0; z <= z1; z++) b.box(fx, roofY(z) - 2, z, fx + 1, roofY(z) - 1, z, M.Steel);
    for (let z = z0 + 7; z < z1 - 4; z += 8) b.box(fx, G + 29, z, fx, roofY(z) - 2, z, M.Steel);
  }
  for (let z = z0 + 3; z <= z1 - 3; z += 9) b.box(x0, roofY(z) - 1, z, x1, roofY(z) - 1, z, M.Steel);
  // corrugated roof (two voxels thick where it steps so it stays connected) with glass skylights
  for (let z = z0 - 2; z <= z1 + 2; z++) b.box(x0 - 2, roofY(z) - 1, z, x1 + 2, roofY(z), z, M.SheetMetal);
  for (let z = z0; z <= z1; z++) for (const fx of frames) b.box(fx, roofY(z) - 1, z, fx + 1, roofY(z) - 1, z, M.Steel);
  for (const sx of [50, 98, 122]) for (let z = 58; z <= 66; z++) b.box(sx, roofY(z) - 1, z, sx + 9, roofY(z), z, M.Glass);

  // clerestory windows between the frames
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i] + 5;
    const c = frames[i + 1] - 4;
    b.windowZ(a, G + 17, c, G + 22, z0, z0 + 1);
    if (frames[i] !== 88) b.windowZ(a, G + 17, c, G + 22, z1, z1 - 1);
  }
  for (const wz of [46, 70, 94]) {
    b.windowX(wz, G + 17, wz + 12, G + 22, x0, x0 + 1);
    if (wz !== 46) b.windowX(wz, G + 17, wz + 12, G + 22, x1, x1 - 1);
  }
  // main roller door (half open), lintel, bollards, sign band
  b.clear(90, G, z1 - 1, 109, G + 19, z1);
  b.box(86, G + 20, z1 - 1, 113, G + 22, z1, M.Steel);
  b.box(90, G + 13, z1, 109, G + 19, z1, M.SheetMetal);
  b.box(88, G + 24, z1 + 1, 111, G + 27, z1 + 1, M.PaintYellow);
  b.box(92, G + 25, z1 + 2, 107, G + 26, z1 + 2, M.Neon);
  b.box(87, G, z1 + 4, 87, G + 4, z1 + 4, M.PaintYellow);
  b.box(112, G, z1 + 4, 112, G + 4, z1 + 4, M.PaintYellow);
  // personnel door in the east wall
  b.clear(x1 - 1, G, 100, x1, G + 10, 104);
  b.meta.doors.push({ x: x1, y: G, z: 100, width: 5, height: 11, axis: 'z', hinge: 0, mat: M.SheetMetal });

  // mezzanine office (NE corner): steel deck frame, timber floor, plaster office underneath
  const mx0 = 124, mz1 = 69, deck = G + 15;
  b.box(mx0, deck - 1, z0 + 2, x1 - 2, deck - 1, mz1, M.Steel);
  b.clear(mx0 + 1, deck - 1, z0 + 2, x1 - 2, deck - 1, mz1 - 1);
  for (let x = mx0 + 6; x < x1 - 2; x += 6) b.box(x, deck - 1, z0 + 2, x, deck - 1, mz1, M.Steel);
  b.box(mx0, deck, z0 + 2, x1 - 2, deck, mz1, M.Wood);
  for (const [px, pz] of [[mx0, mz1 - 1], [mx0, 52], [140, mz1 - 1]] as const) b.box(px, G, pz, px + 1, deck - 2, pz + 1, M.Steel);
  b.box(mx0, G, z0 + 2, mx0, deck - 2, mz1, M.Plaster);
  b.box(mx0, G, mz1, x1 - 2, deck - 2, mz1, M.Plaster);
  b.clear(mx0, G, 58, mx0, G + 10, 62);
  b.box(134, G + 5, mz1, 146, G + 10, mz1, M.Glass);
  b.windowX(46, G + 5, 58, G + 10, x1, x1 - 1);
  // railing with a gap at the stair head
  for (let z = z0 + 2; z <= mz1; z++) {
    if (z >= 64 && z <= 68) continue;
    if (z % 5 === 0) b.box(mx0, deck + 1, z, mx0, deck + 4, z, M.Steel);
    b.set(mx0, deck + 5, z, M.Steel);
  }
  b.box(mx0, deck + 1, 63, mx0, deck + 5, 63, M.Steel);
  b.box(mx0, deck + 1, mz1, mx0, deck + 5, mz1, M.Steel);
  for (let x = mx0; x <= x1 - 2; x++) {
    if (x % 5 === 0) b.box(x, deck + 1, mz1, x, deck + 4, mz1, M.Steel);
    b.set(x, deck + 5, mz1, M.Steel);
  }
  // steel stair up to the deck (treads two voxels deep so each connects to the next)
  for (let i = 0; i < 16; i++) {
    const x = 108 + i;
    b.box(x, Math.max(G, G + i - 1), 64, x, G + i, 68, M.Steel);
    if (i % 5 === 4) {
      b.box(x, G, 64, x, G + i, 64, M.Steel);
      b.box(x, G, 68, x, G + i, 68, M.Steel);
    }
  }
  // office furniture
  b.box(146, G + 3, 44, 153, G + 3, 48, M.WoodDark);
  for (const [lx, lz] of [[146, 44], [153, 44], [146, 48], [153, 48]] as const) b.box(lx, G, lz, lx, G + 2, lz, M.MetalDark);
  b.box(148, G + 4, 45, 150, G + 6, 45, M.MetalDark);
  b.box(153, G, 62, 156, G + 8, 66, M.MetalDark);
  b.prop('chair', 148, G, 50, 2);
  b.box(132, deck + 1, 40, 139, deck + 3, 43, M.WoodDark);
  b.stamp('crateSmall', 150, deck + 1, 40);
  b.stamp('crateSmall', 150, deck + 1, 46);
  b.prop('crateSmall', 144, deck + 1, 58);
  b.prop('barrel', 130, deck + 1, 60, 0, 1);

  // racking in the west half
  rack(b, 48, 44, 104);
  rack(b, 64, 44, 104);
  rack(b, 80, 44, 92);

  // loose stock on the hall floor
  for (const [cx, cz] of [[96, 96], [102, 97], [97, 103], [116, 90], [118, 84]] as const) b.prop('crate', cx, G, cz);
  b.prop('crate', 97, G + 5, 97);
  b.prop('crateSmall', 104, G, 104);
  b.prop('pallet', 114, G, 100);
  b.prop('pallet', 114, G + 2, 100);
  b.prop('bricks', 114, G + 4, 100);
  for (const [bx, bz, kind] of [[86, 96, 0], [90, 102, 1], [85, 104, 1], [91, 108, 0], [84, 109, 0]] as const) b.prop(kind ? 'barrelExplosive' : 'barrel', bx, G, bz, 0, bx);
  b.prop('steelBeam', 128, G, 104);
  b.prop('steelBeam', 128, G, 107);
  b.prop('tire', 150, G, 108);
  b.prop('tire', 150, G + 2, 108);
  b.prop('toolbox', 120, G, 72);

  // yard: containers, dumpster, van, pallets
  container(b, 14, G, 126, M.PaintRed);
  container(b, 28, G, 126, M.PaintBlue, true);
  container(b, 16, G + 13, 128, M.PaintBlue);
  b.prop('crate', 31, G + 1, 132);
  b.prop('crate', 31, G + 1, 140);
  b.prop('barrelExplosive', 32, G + 1, 148);
  b.box(168, G, 60, 183, G + 6, 68, M.PaintBlue);
  b.clear(169, G + 1, 61, 182, G + 6, 67);
  b.prop('van', 124, G, 140, 1, 0);
  b.prop('pallet', 70, G, 130);
  b.prop('pallet', 70, G + 2, 130);
  b.prop('pallet', 70, G + 4, 130);
  b.prop('concreteBlock', 60, G, 150);
  b.prop('concreteBlock', 60, G, 154);
  b.prop('barrel', 160, G, 130, 0, 1);
  b.tree(20, 24, 17, 8);
  b.tree(180, 30, 15, 7);

  b.meta.regions.push({ key: 'warehouse', name: 'Kestrel Freight', min: [x0 - 2, G, z0 - 2], max: [x1 + 2, G + 40, z1 + 2] });
}

// ---------------------------------------------------------------------------
// NE lot: fuel station
// ---------------------------------------------------------------------------
export function buildGasStation(b: Builder): void {
  // canopy on four steel columns
  for (const cx of [300, 350]) for (const cz of [100, 135]) b.box(cx, G, cz, cx + 1, G + 22, cz + 1, M.Steel);
  const dx0 = 296, dx1 = 355, dz0 = 96, dz1 = 140;
  b.box(dx0, G + 23, dz0, dx1, G + 23, dz1, M.PaintWhite);
  b.box(dx0, G + 26, dz0, dx1, G + 26, dz1, M.SheetMetal);
  b.walls(dx0, G + 24, dz0, dx1, G + 24, dz1, M.Neon);
  b.walls(dx0, G + 25, dz0, dx1, G + 25, dz1, M.PaintWhite);
  for (const cx of [300, 350]) b.box(cx, G + 24, dz0 + 1, cx + 1, G + 25, dz1 - 1, M.Steel);
  for (const cz of [100, 135]) b.box(dx0 + 1, G + 24, cz, dx1 - 1, G + 25, cz + 1, M.Steel);
  for (const lx of [312, 338]) for (const lz of [108, 128]) b.box(lx, G + 23, lz, lx + 2, G + 23, lz + 1, M.Lamp);

  // pump islands
  for (const ix of [311, 335]) {
    b.box(ix, G, 106, ix + 5, G, 130, M.Pavement);
    for (const pz of [110, 124]) {
      b.box(ix + 1, G + 1, pz, ix + 4, G + 1, pz + 2, M.MetalDark);
      b.box(ix + 1, G + 2, pz, ix + 4, G + 8, pz + 2, M.PaintRed);
      b.box(ix + 1, G + 9, pz, ix + 4, G + 9, pz + 2, M.PaintWhite);
      b.box(ix + 2, G + 3, pz + 1, ix + 3, G + 5, pz + 1, M.Explosive);
      b.box(ix + 2, G + 6, pz, ix + 3, G + 7, pz, M.Glass);
      b.box(ix + 2, G + 6, pz + 2, ix + 3, G + 7, pz + 2, M.Glass);
      b.box(ix + 2, G + 6, pz + 1, ix + 3, G + 7, pz + 1, M.MetalDark);
      b.box(ix + 5, G + 3, pz + 1, ix + 5, G + 6, pz + 1, M.Rubber);
      b.meta.zones.push({ name: 'fuel pump', min: [ix + 1, G + 1, pz], max: [ix + 4, G + 9, pz + 2], power: 0.55 });
    }
    b.box(ix + 2, G + 1, 107, ix + 3, G + 4, 107, M.PaintYellow);
    b.box(ix + 2, G + 1, 129, ix + 3, G + 4, 129, M.PaintYellow);
  }

  // shop
  const sx0 = 296, sx1 = 345, sz0 = 52, sz1 = 81, sh = G + 16;
  b.surface(sx0, sz0, sx1, sz1, M.Tile);
  b.walls(sx0, G, sz0, sx1, sh, sz1, M.Concrete, 2);
  b.box(sx0 - 2, sh + 1, sz0 - 2, sx1 + 2, sh + 2, sz1 + 2, M.Concrete);
  b.walls(sx0 - 2, sh + 3, sz0 - 2, sx1 + 2, sh + 4, sz1 + 2, M.Concrete);
  // glazed front with steel mullions and a door gap
  b.clear(300, G + 2, sz1 - 1, 341, G + 12, sz1);
  b.box(300, G + 2, sz1, 341, G + 12, sz1, M.Glass);
  for (let x = 300; x <= 341; x += 7) b.box(x, G + 2, sz1, x, G + 12, sz1, M.Steel);
  b.clear(318, G, sz1 - 1, 323, G + 11, sz1);
  b.box(317, G, sz1, 317, G + 12, sz1, M.Steel);
  b.box(324, G, sz1, 324, G + 12, sz1, M.Steel);
  b.box(300, G + 13, sz1 + 1, 341, G + 15, sz1 + 1, M.PaintWhite);
  b.box(302, G + 14, sz1 + 2, 339, G + 14, sz1 + 2, M.Neon);
  // back room partition
  b.box(sx0 + 2, G, 62, sx1 - 2, sh, 62, M.Plaster);
  b.clear(330, G, 62, 334, G + 10, 62);
  b.windowX(56, G + 6, 60, G + 10, sx0, sx0 + 1);
  // counter + register
  b.box(336, G, 65, 338, G + 4, 77, M.WoodDark);
  b.box(336, G + 5, 65, 338, G + 5, 77, M.Porcelain);
  b.box(337, G + 6, 68, 338, G + 7, 69, M.MetalDark);
  // gondola shelving with goods
  for (const gx of [304, 314, 324]) {
    b.box(gx, G, 65, gx + 3, G, 77, M.MetalDark);
    b.box(gx + 1, G + 1, 65, gx + 2, G + 10, 65, M.MetalDark);
    b.box(gx + 1, G + 1, 77, gx + 2, G + 10, 77, M.MetalDark);
    b.box(gx + 1, G + 1, 66, gx + 2, G + 10, 76, M.SheetMetal);
    for (const sy of [G + 3, G + 6, G + 9]) {
      b.box(gx, sy, 65, gx + 3, sy, 77, M.SheetMetal);
      for (let z = 66; z <= 76; z++) {
        if (b.rnd() < 0.7) b.set(gx, sy + 1, z, GOODS[Math.floor(b.rnd() * 5)]);
        if (b.rnd() < 0.7) b.set(gx + 3, sy + 1, z, GOODS[Math.floor(b.rnd() * 5)]);
      }
    }
  }
  // fridge wall
  b.box(sx0 + 2, G, 64, sx0 + 4, G + 11, 79, M.Porcelain);
  b.box(sx0 + 5, G + 1, 65, sx0 + 5, G + 10, 78, M.Glass);
  for (let z = 64; z <= 79; z += 5) b.box(sx0 + 5, G, z, sx0 + 5, G + 11, z, M.MetalDark);
  // back-room stock, ceiling lights, roof plant
  b.stamp('crate', 300, G, 55);
  b.stamp('crate', 306, G, 55);
  b.stamp('crateSmall', 301, G + 5, 55);
  b.prop('barrel', 338, G, 55, 0, 1);
  b.prop('crateSmall', 322, G, 56);
  for (const lx of [306, 320, 334]) b.box(lx, sh, 70, lx + 3, sh, 71, M.Lamp);
  b.box(300, sh + 3, 56, 308, sh + 7, 61, M.MetalDark);
  b.box(302, sh + 8, 58, 306, sh + 8, 59, M.SheetMetal);

  // gas cylinder cage beside the shop
  for (const [cx, cz] of [[348, 60], [357, 60], [348, 67], [357, 67]] as const) b.box(cx, G, cz, cx, G + 8, cz, M.Steel);
  b.walls(348, G + 8, 60, 357, G + 8, 67, M.Steel);
  b.walls(348, G + 4, 60, 357, G + 4, 67, M.Steel);
  for (const px of [350, 353]) for (const pz of [62, 64]) b.prop('propane', px, G, pz);

  // bulk fuel tank in a bund behind the shop
  b.walls(256, G, 24, 293, G + 2, 48, M.Concrete);
  for (const sx of [265, 281]) b.box(sx, G, 31, sx + 2, G + 3, 41, M.Concrete);
  for (let x = 262; x <= 287; x++)
    for (let dy = -6; dy <= 6; dy++)
      for (let dz = -6; dz <= 6; dz++) {
        const d = Math.sqrt(dy * dy + dz * dz);
        const cap = x === 262 || x === 287;
        if (d < 5.6 && (d > 4.4 || cap)) b.set(x, G + 9 + dy, 36 + dz, x === 274 || x === 275 ? M.PaintRed : M.PaintWhite);
        else if (d <= 4.4 && !cap && dy < 2) b.set(x, G + 9 + dy, 36 + dz, M.Explosive);
      }
  b.box(274, G + 15, 36, 275, G + 17, 36, M.MetalDark);
  b.meta.zones.push({ name: 'fuel tank', min: [262, G + 3, 30], max: [287, G + 15, 42], power: 1.25 });

  // price sign near the junction
  b.box(270, G, 186, 271, G + 34, 187, M.Steel);
  b.box(263, G + 35, 185, 278, G + 45, 188, M.PaintWhite);
  b.clear(264, G + 36, 186, 277, G + 44, 187);
  for (const sy of [G + 38, G + 41, G + 43]) {
    b.box(265, sy, 185, 276, sy, 185, M.Neon);
    b.box(265, sy, 188, 276, sy, 188, M.Neon);
  }

  // parking bays with wheel stops, parked vehicles
  for (let z = 38; z <= 178; z += 14) b.box(384, G - 1, z, 430, G - 1, z, M.RoadPaint);
  for (let z = 44; z <= 170; z += 14) b.box(431, G, z, 432, G, z + 3, M.Concrete);
  b.prop('car', 400, G, 41, 0, 1);
  b.prop('car', 400, G, 69, 0, 0);
  b.prop('van', 398, G, 111, 0, 2);
  b.prop('car', 321, G, 107, 1, 3);
  b.prop('bin', 326, G, 84);
  b.prop('tire', 362, G, 70);
  b.prop('cone', 368, G, 150);
  b.prop('barrelExplosive', 290, G, 86);
  b.tree(425, 20, 16, 8);

  b.meta.regions.push({ key: 'gasstation', name: 'Kestrel Fuel Station', min: [294, G, 50], max: [357, G + 28, 141] });
}

// ---------------------------------------------------------------------------
// SW lot: No. 4 Mill Lane
// ---------------------------------------------------------------------------
export function buildResidential(b: Builder): void {
  const x0 = 70, x1 = 117, z0 = 300, z1 = 339;
  const f1 = G + 14; // first-floor slab bottom
  const f2 = G + 29; // attic slab bottom
  const wallTop = G + 30;
  const roofY = (z: number) => G + 31 + Math.floor((22 - Math.abs(z - 319.5)) / 2);

  b.box(x0, G, z0, x1, G, z1, M.Wood);
  b.walls(x0, G, z0, x1, wallTop, z1, M.Brick, 2);
  b.box(x0 + 2, f1, z0 + 2, x1 - 2, f1 + 1, z1 - 2, M.Wood);
  b.box(x0 + 2, f2, z0 + 2, x1 - 2, f2 + 1, z1 - 2, M.Wood);
  for (let x = x0 + 8; x < x1 - 4; x += 8) {
    b.box(x, f1 - 1, z0 + 2, x, f1 - 1, z1 - 2, M.WoodDark);
    b.box(x, f2 - 1, z0 + 2, x, f2 - 1, z1 - 2, M.WoodDark);
  }
  // gable roof: boards + tiles, two voxels thick so every course touches the next
  for (let z = z0 - 2; z <= z1 + 2; z++) {
    const ry = roofY(z);
    b.box(x0 - 2, ry - 1, z, x1 + 2, ry - 1, z, M.Wood);
    b.box(x0 - 2, ry, z, x1 + 2, ry, z, M.RoofTile);
    if (z >= z0 && z <= z1 && ry - 2 > wallTop) {
      b.box(x0, wallTop + 1, z, x0 + 1, ry - 2, z, M.Brick);
      b.box(x1 - 1, wallTop + 1, z, x1, ry - 2, z, M.Brick);
    }
  }
  for (let x = x0 + 6; x < x1; x += 10) for (let z = z0; z <= z1; z++) b.set(x, roofY(z) - 2, z, M.WoodDark);
  // chimney on the west wall
  b.box(66, G, 317, 69, G + 47, 322, M.Brick);
  b.clear(67, G + 3, 318, 68, G + 47, 321);
  b.box(65, G + 46, 316, 70, G + 46, 323, M.Concrete);
  b.clear(67, G + 46, 318, 68, G + 46, 321);

  // windows (ground and first floor)
  for (const [sill, head] of [[G + 5, G + 10], [G + 20, G + 25]] as const) {
    for (const wx of [78, 104]) {
      b.windowZ(wx, sill, wx + 6, head, z0, z0 + 1);
      b.windowZ(wx, sill, wx + 6, head, z1, z1 - 1);
    }
    b.windowX(326, sill, 332, head, x1, x1 - 1);
    b.windowX(306, sill, 312, head, x0, x0 + 1);
    b.windowX(328, sill, 334, head, x0, x0 + 1);
  }
  b.windowZ(91, G + 20, 97, G + 25, z0, z0 + 1);
  b.windowX(306, G + 20, 312, G + 25, x1, x1 - 1);
  // front and back doors
  b.clear(92, G + 1, z0, 96, G + 11, z0 + 1);
  b.clear(92, G + 1, z1 - 1, 96, G + 11, z1);
  b.meta.doors.push({ x: 92, y: G + 1, z: z0, width: 5, height: 11, axis: 'x', hinge: 0, mat: M.WoodDark });
  b.meta.doors.push({ x: 92, y: G + 1, z: z1, width: 5, height: 11, axis: 'x', hinge: 1, mat: M.WoodDark });
  // porch
  b.box(89, G, 295, 99, G, 299, M.Wood);
  b.box(89, G + 1, 295, 89, G + 12, 295, M.WoodDark);
  b.box(99, G + 1, 295, 99, G + 12, 295, M.WoodDark);
  b.box(88, G + 13, 294, 100, G + 13, 299, M.Wood);
  b.box(88, G + 14, 294, 100, G + 14, 299, M.RoofTile);

  // ground-floor partitions and the staircase
  b.box(x0 + 2, G + 1, 320, 109, f1 - 1, 320, M.Plaster);
  b.clear(84, G + 1, 320, 88, G + 11, 320);
  b.box(96, G + 1, z0 + 2, 96, f1 - 1, 319, M.Plaster);
  b.clear(96, G + 1, 309, 96, G + 11, 313);
  b.clear(110, f1, 304, 114, f1 + 1, 318);
  for (let i = 0; i < 15; i++) b.box(110, G + 1, 304 + i, 114, G + 1 + i, 304 + i, M.Wood);
  // first-floor partitions and stair guard
  b.box(x0 + 2, f1 + 2, 322, x1 - 2, f2 - 1, 322, M.Plaster);
  b.clear(95, f1 + 2, 322, 98, f1 + 12, 322);
  b.clear(104, f1 + 2, 322, 107, f1 + 12, 322);
  b.box(94, f1 + 2, z0 + 2, 94, f2 - 1, 321, M.Plaster);
  b.clear(94, f1 + 2, 312, 94, f1 + 12, 316);
  b.box(100, f1 + 2, 323, 100, f2 - 1, z1 - 2, M.Plaster);
  for (let z = 304; z <= 318; z++) {
    if (z % 4 === 0) b.box(109, f1 + 2, z, 109, f1 + 5, z, M.WoodDark);
    b.set(109, f1 + 6, z, M.WoodDark);
  }
  b.box(109, f1 + 2, 304, 109, f1 + 6, 304, M.WoodDark);
  b.box(109, f1 + 2, 303, 114, f1 + 6, 303, M.WoodDark);
  b.clear(110, f1 + 2, 303, 113, f1 + 5, 303);

  // living room
  b.box(73, G + 1, 306, 77, G + 2, 316, M.Fabric);
  b.box(73, G + 3, 306, 74, G + 5, 316, M.Fabric);
  b.box(73, G + 3, 306, 77, G + 4, 306, M.Fabric);
  b.box(73, G + 3, 316, 77, G + 4, 316, M.Fabric);
  b.box(93, G + 1, 304, 95, G + 3, 314, M.WoodDark);
  b.box(94, G + 4, 305, 94, G + 9, 313, M.MetalDark);
  b.box(93, G + 5, 306, 93, G + 8, 312, M.Glass);
  b.box(86, G + 1, 302, 91, G + 11, 303, M.WoodDark);
  for (const sy of [G + 2, G + 5, G + 8]) for (let x = 87; x <= 90; x++) b.box(x, sy, 303, x, sy + 1, 303, GOODS[Math.floor(b.rnd() * 4)]);
  b.prop('table', 80, G + 1, 309, 1);
  b.box(98, G + 1, 302, 104, G + 4, 303, M.WoodDark);
  // kitchen + dining
  b.box(72, G + 1, 322, 75, G + 11, 325, M.Porcelain);
  b.box(72, G + 1, 326, 74, G + 3, 337, M.WoodDark);
  b.box(72, G + 4, 326, 74, G + 4, 337, M.Porcelain);
  b.box(72, G + 4, 330, 73, G + 4, 332, M.MetalDark);
  b.box(76, G + 1, 335, 84, G + 3, 337, M.WoodDark);
  b.box(76, G + 4, 335, 84, G + 4, 337, M.Porcelain);
  b.box(80, G + 1, 335, 84, G + 4, 337, M.MetalDark);
  b.prop('table', 100, G + 1, 328);
  b.prop('chair', 102, G + 1, 324, 0);
  b.prop('chair', 102, G + 1, 334, 2);
  b.prop('chair', 96, G + 1, 329, 3);
  b.prop('chair', 109, G + 1, 329, 1);
  // bedrooms
  const fy = f1 + 2;
  for (const bz of [303, 330]) {
    b.box(73, fy, bz, 82, fy + 1, bz + 6, M.WoodDark);
    b.box(73, fy + 2, bz, 82, fy + 2, bz + 6, M.Fabric);
    b.box(73, fy + 3, bz + 1, 74, fy + 3, bz + 5, M.Porcelain);
    b.box(72, fy, bz, 72, fy + 5, bz + 6, M.WoodDark);
  }
  b.box(86, fy, 318, 92, fy + 11, 320, M.WoodDark);
  b.box(90, fy + 3, 335, 97, fy + 3, 337, M.WoodDark);
  b.box(90, fy, 335, 90, fy + 2, 337, M.WoodDark);
  b.box(97, fy, 335, 97, fy + 2, 337, M.WoodDark);
  b.prop('chair', 92, fy, 331, 2);
  b.prop('crateSmall', 86, fy, 306);
  // bathroom
  b.box(101, f1 + 1, 323, x1 - 2, f1 + 1, z1 - 2, M.Tile);
  b.box(108, fy, 333, 115, fy + 2, 337, M.Porcelain);
  b.clear(109, fy + 1, 334, 114, fy + 2, 336);
  b.box(113, fy, 324, 115, fy + 2, 326, M.Porcelain);
  b.box(115, fy + 3, 324, 115, fy + 5, 326, M.Porcelain);
  b.box(102, fy + 3, 336, 104, fy + 4, 337, M.Porcelain);
  b.box(103, fy, 337, 103, fy + 2, 337, M.Porcelain);
  // ceiling lamps
  for (const [lx, lz] of [[83, 310], [100, 328], [104, 310]] as const) b.box(lx, f1 - 1, lz, lx + 1, f1 - 1, lz + 1, M.Lamp);
  for (const [lx, lz] of [[83, 310], [86, 330], [107, 330]] as const) b.box(lx, f2 - 1, lz, lx + 1, f2 - 1, lz + 1, M.Lamp);

  // yard: path, driveway, picket fence, shed, trees
  b.surface(91, 252, 97, 294, M.Pavement);
  b.surface(126, 252, 141, 299, M.Pavement);
  const fence = (ax: number, az: number, bx: number, bz: number) => {
    const n = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
    for (let i = 0; i <= n; i++) {
      const x = ax + Math.round(((bx - ax) * i) / n);
      const z = az + Math.round(((bz - az) * i) / n);
      if (i % 6 === 0) b.box(x, G, z, x, G + 5, z, M.WoodDark);
      else if (i % 2 === 0) b.box(x, G, z, x, G + 4, z, M.Wood);
      else {
        b.set(x, G + 1, z, M.Wood);
        b.set(x, G + 3, z, M.Wood);
      }
    }
  };
  fence(30, 262, 88, 262);
  fence(100, 262, 124, 262);
  fence(144, 262, 172, 262);
  fence(30, 262, 30, 424);
  fence(172, 262, 172, 424);
  fence(30, 424, 172, 424);
  b.box(101, G, 258, 101, G + 5, 258, M.WoodDark);
  b.box(100, G + 6, 257, 102, G + 7, 259, M.PaintRed);
  b.prop('car', 129, G, 268, 1, 2);
  // shed
  b.walls(140, G, 350, 159, G + 11, 365, M.Wood);
  b.box(138, G + 12, 348, 161, G + 12, 367, M.SheetMetal);
  for (const [px, pz] of [[140, 350], [159, 350], [140, 365], [159, 365]] as const) b.box(px, G, pz, px, G + 11, pz, M.WoodDark);
  b.clear(140, G, 355, 140, G + 9, 359);
  b.box(148, G + 5, 350, 153, G + 8, 350, M.Glass);
  b.box(153, G + 4, 362, 158, G + 4, 364, M.WoodDark);
  b.prop('barrelExplosive', 152, G, 353);
  b.prop('crate', 145, G, 360);
  b.prop('toolbox', 154, G + 5, 362);
  b.prop('plank', 143, G, 352);
  b.prop('tire', 155, G, 357);
  // kennel, bench, trees
  b.walls(56, G, 396, 62, G + 4, 402, M.Wood);
  b.box(55, G + 5, 395, 63, G + 5, 403, M.RoofTile);
  b.clear(59, G, 396, 59, G + 3, 396);
  b.box(118, G + 2, 386, 128, G + 2, 388, M.WoodDark);
  b.box(118, G, 386, 118, G + 1, 388, M.WoodDark);
  b.box(128, G, 386, 128, G + 1, 388, M.WoodDark);
  b.box(118, G + 3, 388, 128, G + 5, 388, M.Wood);
  for (const [tx, tz, h, r] of [[44, 282, 16, 8], [158, 300, 14, 7], [48, 372, 18, 9], [150, 404, 15, 7], [100, 400, 13, 6]] as const) b.tree(tx, tz, h, r);

  b.meta.regions.push({ key: 'residential', name: 'No. 4 Mill Lane', min: [64, G, 293], max: [120, G + 48, 342] });
}

// ---------------------------------------------------------------------------
// SE lot: Lot 9 construction site
// ---------------------------------------------------------------------------
export function buildConstructionSite(b: Builder): void {
  const x0 = 290, x1 = 349, z0 = 300, z1 = 349;
  const colX = [290, 309, 328, 347];
  const colZ = [300, 324, 347];
  const slabs = [G + 15, G + 31, G + 47];

  b.box(x0 - 2, G, z0 - 2, x1 + 2, G, z1 + 2, M.Concrete);
  for (const cx of colX)
    for (const cz of colZ) {
      const full = cx <= 328;
      b.box(cx, G + 1, cz, cx + 2, full ? G + 46 : G + 52, cz + 2, M.Concrete);
      // starter bars
      for (const [rx, rz] of [[cx, cz], [cx + 2, cz], [cx, cz + 2], [cx + 2, cz + 2]] as const) b.box(rx, (full ? G + 49 : G + 53), rz, rx, (full ? G + 51 : G + 57), rz, M.Steel);
    }
  slabs.forEach((sy, level) => {
    const xe = level === 2 ? 330 : x1;
    for (const cz of colZ) b.box(x0, sy - 2, cz, xe, sy - 1, cz + 2, M.Concrete);
    for (const cx of colX) if (cx <= xe) b.box(cx, sy - 2, z0, cx + 2, sy - 1, z1, M.Concrete);
    b.box(x0, sy, z0, xe, sy + 1, z1, M.Concrete);
  });
  // stairwell openings
  b.clear(331, slabs[0] - 2, 304, 345, slabs[0] + 1, 308);
  b.clear(332, slabs[1] - 2, 318, 346, slabs[1] + 1, 322);
  for (let i = 0; i < 16; i++) b.box(331 + i, G + 1, 304, 331 + i, G + 1 + i, 308, M.Concrete);
  for (let j = 0; j < 16; j++) b.box(346 - j, G + 16 + j, 318, 346 - j, G + 17 + j, 322, M.Concrete);
  // timber edge protection on the two finished decks
  for (const sy of [slabs[0], slabs[1]]) {
    const y = sy + 2;
    for (let x = x0; x <= x1; x++) {
      for (const z of [z0, z1]) {
        if (x % 6 === 0) b.box(x, y, z, x, y + 3, z, M.WoodDark);
        b.set(x, y + 4, z, M.Wood);
        b.set(x, y + 2, z, M.Wood);
      }
    }
    for (let z = z0; z <= z1; z++) {
      if (z % 6 === 0) b.box(x1, y, z, x1, y + 3, z, M.WoodDark);
      b.set(x1, y + 4, z, M.Wood);
      b.set(x1, y + 2, z, M.Wood);
    }
    b.box(x1, y, z0, x1, y + 4, z0, M.WoodDark);
    b.box(x1, y, z1, x1, y + 4, z1, M.WoodDark);
    b.box(x0, y, z0, x0, y + 4, z0, M.WoodDark);
    b.box(x0, y, z1, x0, y + 4, z1, M.WoodDark);
  }

  // scaffold along the west face
  const polesZ = [298, 311, 324, 337, 351];
  for (const pz of polesZ) {
    b.box(282, G, pz, 282, G + 52, pz, M.Steel);
    b.box(287, G, pz, 287, G + 52, pz, M.Steel);
    b.box(281, G, pz, 283, G, pz, M.MetalDark);
    b.box(286, G, pz, 288, G, pz, M.MetalDark);
  }
  for (const dy of [G + 16, G + 32, G + 48]) {
    b.box(282, dy, 298, 282, dy, 351, M.Steel);
    b.box(287, dy, 298, 287, dy, 351, M.Steel);
    b.box(283, dy, 298, 286, dy, 351, M.Wood);
    b.box(282, dy + 5, 298, 282, dy + 5, 351, M.Steel);
    for (const pz of polesZ) {
      b.box(282, dy - 1, pz, 287, dy - 1, pz, M.Steel);
      if (dy < G + 48) b.box(288, dy, pz, 289, dy, pz, M.Steel);
    }
  }
  for (let i = 0; i < polesZ.length - 1; i++) {
    const a = polesZ[i], c = polesZ[i + 1];
    b.line(282, G + 1, i % 2 ? c : a, 282, G + 15, i % 2 ? a : c, M.Steel);
    b.line(282, G + 17, i % 2 ? a : c, 282, G + 31, i % 2 ? c : a, M.Steel);
  }

  // tower crane east of the frame, jib reaching over it
  const mx = 362, mz = 321, mt = G + 100;
  b.box(mx - 3, G, mz - 3, mx + 10, G + 1, mz + 10, M.Concrete);
  for (const px of [mx, mx + 6]) for (const pz of [mz, mz + 6]) b.box(px, G + 2, pz, px + 1, mt, pz + 1, M.Steel);
  for (let y = G + 8; y <= mt; y += 8) {
    b.walls(mx, y, mz, mx + 7, y, mz + 7, M.Steel);
    const up = (y / 8) % 2 === 0;
    b.line(mx + 2, up ? y - 7 : y - 1, mz, mx + 5, up ? y - 1 : y - 7, mz, M.Steel);
    b.line(mx + 2, up ? y - 1 : y - 7, mz + 7, mx + 5, up ? y - 7 : y - 1, mz + 7, M.Steel);
    b.line(mx, up ? y - 7 : y - 1, mz + 2, mx, up ? y - 1 : y - 7, mz + 5, M.Steel);
    b.line(mx + 7, up ? y - 1 : y - 7, mz + 2, mx + 7, up ? y - 7 : y - 1, mz + 5, M.Steel);
  }
  b.box(mx - 1, mt + 1, mz - 1, mx + 8, mt + 2, mz + 8, M.MetalDark);
  const jy = mt + 3;
  const jz0 = mz + 2, jz1 = mz + 5;
  // jib (towards -x): two bottom chords, a top chord and lattice
  b.box(300, jy, jz0, mx + 7, jy, jz0, M.Steel);
  b.box(300, jy, jz1, mx + 7, jy, jz1, M.Steel);
  b.box(304, jy + 5, jz0 + 1, mx + 4, jy + 5, jz0 + 2, M.Steel);
  for (let x = 300; x <= mx; x += 6) {
    b.box(x, jy, jz0, x, jy, jz1, M.Steel);
    if (x >= 304) {
      b.line(x, jy, jz0, x + 3, jy + 5, jz0 + 1, M.Steel);
      b.line(x + 6, jy, jz1, x + 3, jy + 5, jz0 + 2, M.Steel);
    }
  }
  b.line(300, jy, jz0, 304, jy + 5, jz0 + 1, M.Steel);
  b.line(300, jy, jz1, 304, jy + 5, jz0 + 2, M.Steel);
  // tower head and pendant ties
  b.box(mx + 3, jy, mz + 3, mx + 4, jy + 16, mz + 4, M.Steel);
  b.line(mx + 3, jy + 16, mz + 3, 322, jy + 6, jz0 + 1, M.Steel);
  b.line(mx + 4, jy + 16, mz + 4, 322, jy + 6, jz0 + 2, M.Steel);
  // counter-jib with ballast
  b.box(mx + 8, jy, mz + 1, mx + 31, jy, mz + 6, M.Steel);
  b.box(mx + 8, jy + 1, mz + 1, mx + 31, jy + 3, mz + 1, M.Steel);
  b.clear(mx + 9, jy + 1, mz + 1, mx + 30, jy + 2, mz + 1);
  b.box(mx + 8, jy + 1, mz + 6, mx + 31, jy + 3, mz + 6, M.Steel);
  b.clear(mx + 9, jy + 1, mz + 6, mx + 30, jy + 2, mz + 6);
  b.box(mx + 21, jy + 1, mz + 1, mx + 30, jy + 6, mz + 6, M.Steel);
  b.box(mx + 21, jy + 7, mz + 2, mx + 30, jy + 7, mz + 5, M.Concrete);
  b.line(mx + 4, jy + 16, mz + 3, mx + 30, jy + 4, mz + 1, M.Steel);
  b.line(mx + 4, jy + 16, mz + 4, mx + 30, jy + 4, mz + 6, M.Steel);
  // operator cab
  b.box(mx + 1, mt + 2, mz + 9, mx + 7, mt + 2, mz + 13, M.MetalDark);
  b.box(mx + 1, mt + 3, mz + 9, mx + 7, mt + 9, mz + 13, M.PaintYellow);
  b.clear(mx + 2, mt + 3, mz + 10, mx + 6, mt + 8, mz + 12);
  b.box(mx + 2, mt + 5, mz + 13, mx + 6, mt + 8, mz + 13, M.Glass);
  b.box(mx + 1, mt + 5, mz + 10, mx + 1, mt + 8, mz + 12, M.Glass);
  // trolley, hoist cable, hook and a suspended slab
  const hx = 318;
  b.box(hx - 1, jy - 1, jz0, hx + 2, jy - 1, jz1, M.MetalDark);
  b.box(hx, G + 62, jz0 + 1, hx, jy - 2, jz0 + 1, M.Steel);
  b.box(hx - 1, G + 59, jz0, hx + 1, G + 61, jz0 + 2, M.MetalDark);
  b.box(hx - 6, G + 53, jz0 - 3, hx + 7, G + 54, jz0 + 5, M.Concrete);
  b.line(hx - 1, G + 58, jz0, hx - 5, G + 55, jz0 - 2, M.Steel);
  b.line(hx + 1, G + 58, jz0, hx + 6, G + 55, jz0 - 2, M.Steel);
  b.line(hx - 1, G + 58, jz0 + 2, hx - 5, G + 55, jz0 + 4, M.Steel);
  b.line(hx + 1, G + 58, jz0 + 2, hx + 6, G + 55, jz0 + 4, M.Steel);

  // timber hoarding with two gates
  const hoard = (ax: number, az: number, bx: number, bz: number) => {
    const n = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
    for (let i = 0; i <= n; i++) {
      const x = ax + Math.round(((bx - ax) * i) / n);
      const z = az + Math.round(((bz - az) * i) / n);
      b.box(x, G, z, x, G + 9, z, i % 8 === 0 ? M.WoodDark : M.Wood);
      if (i % 8 === 0) b.set(x, G + 10, z, M.WoodDark);
    }
  };
  hoard(258, 258, 296, 258);
  hoard(322, 258, 434, 258);
  hoard(258, 258, 258, 326);
  hoard(258, 350, 258, 434);
  hoard(258, 434, 434, 434);
  hoard(434, 258, 434, 434);
  b.box(259, G + 6, 258, 296, G + 7, 258, M.PaintYellow);

  // site office cabin on blocks
  for (const [px, pz] of [[392, 268], [420, 268], [392, 278], [420, 278], [406, 268], [406, 278]] as const) b.box(px, G, pz, px + 1, G, pz + 1, M.Concrete);
  b.box(392, G + 1, 268, 421, G + 1, 279, M.Wood);
  b.walls(392, G + 2, 268, 421, G + 13, 279, M.PaintWhite);
  b.box(392, G + 14, 268, 421, G + 14, 279, M.PaintWhite);
  b.walls(392, G + 7, 268, 421, G + 7, 279, M.PaintBlue);
  b.clear(400, G + 2, 279, 404, G + 12, 279);
  b.box(410, G + 6, 279, 418, G + 10, 279, M.Glass);
  b.box(396, G + 6, 268, 404, G + 10, 268, M.Glass);
  b.box(408, G + 5, 269, 418, G + 5, 272, M.WoodDark);
  b.box(408, G + 2, 269, 408, G + 4, 272, M.MetalDark);
  b.box(418, G + 2, 269, 418, G + 4, 272, M.MetalDark);
  b.prop('chair', 412, G + 2, 274, 2);
  b.box(399, G, 280, 405, G, 282, M.Wood);
  // portable toilet
  b.box(424, G, 290, 428, G + 11, 294, M.PaintBlue);
  b.clear(425, G + 1, 291, 427, G + 10, 293);
  b.box(424, G + 12, 290, 428, G + 12, 294, M.PaintWhite);

  // aggregate heaps
  const heap = (cx: number, cz: number, r: number, h: number, m: number) => {
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        const top = Math.round(h * (1 - Math.sqrt(dx * dx + dz * dz) / r) + (b.rnd() - 0.5));
        if (top > 0) b.box(cx + dx, G, cz + dz, cx + dx, G + top - 1, cz + dz, m);
      }
  };
  heap(300, 396, 13, 8, M.Gravel);
  heap(332, 404, 10, 6, M.Dirt);

  // loose materials and plant
  for (let i = 0; i < 4; i++) b.prop('concreteBlock', 270, G + i * 2, 372);
  for (let i = 0; i < 3; i++) b.prop('concreteBlock', 270, G + i * 2, 376);
  b.prop('bricks', 268, G, 300);
  b.prop('bricks', 276, G, 300);
  b.prop('bricks', 272, G + 5, 300);
  // three beams side by side with a fourth resting on the middle one
  for (let i = 0; i < 3; i++) b.prop('steelBeam', 356, G, 370 + i);
  b.prop('steelBeam', 356, G + 2, 371);
  for (let i = 0; i < 5; i++) b.prop('plank', 300 + i, G + 17, 330, 1);
  b.prop('plank', 284, G + 17, 318, 1);
  b.prop('pallet', 310, G + 1, 336);
  b.prop('pallet', 310, G + 3, 336);
  b.prop('barrel', 296, G + 1, 304, 0, 0);
  b.prop('barrelExplosive', 322, G + 1, 340);
  b.prop('barrelExplosive', 340, G + 17, 340);
  b.prop('crate', 300, G + 17, 310);
  b.prop('crate', 318, G + 33, 336);
  b.prop('toolbox', 306, G + 1, 312);
  b.prop('cone', 300, G, 262);
  b.prop('cone', 318, G, 262);
  b.prop('excavator', 372, G, 392, 2);
  b.prop('bin', 388, G, 284);

  b.meta.regions.push({ key: 'construction', name: 'Lot 9 Frame', min: [280, G, 296], max: [352, G + 58, 353] });
}
