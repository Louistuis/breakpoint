/**
 * The six tools. Each one owns its first-person view model (built from boxes to match
 * the voxel look), its ammunition, its animation state and whatever it leaves in the
 * world (rockets in flight, planted charges). All damage goes through the shared
 * destruction systems; nothing here fakes an effect.
 */
import * as THREE from 'three';
import type { LoopHandle } from '../audio/types';
import type { LightHandle } from '../engine/Renderer';
import type { AmmoHud, CrosshairKind } from '../ui/types';
import { clamp, damp, lerp, smoothstep } from '../utils/math';
import { F_FLAMMABLE, MAT_FLAGS, MAT_SURFACE } from '../world/Materials';
import { GRAVITY } from '../world/config';
import type { VoxelBody } from '../destruction/VoxelBody';
import type { ChallengeDef, WeaponId } from './challenges';
import type { WeaponInput, WeaponManager } from './WeaponManager';

type Loadout = ChallengeDef['loadout'];

const vDir = new THREE.Vector3();
const vOrigin = new THREE.Vector3();
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const qA = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

// ---------------------------------------------------------------------------
// view-model construction helpers
// ---------------------------------------------------------------------------
const UNIT = new THREE.BoxGeometry(1, 1, 1);
const matCache = new Map<string, THREE.MeshStandardMaterial>();

function vmat(color: number, rough: number, metal: number, emissive: number): THREE.MeshStandardMaterial {
  const key = `${color}|${rough}|${metal}|${emissive}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    if (emissive > 0) {
      m.emissive.setHex(color);
      m.emissiveIntensity = emissive;
    }
    matCache.set(key, m);
  }
  return m;
}

/** Add a box (size w×h×d centred at x,y,z) to a parent. */
function box(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, color: number, rough = 0.65, metal = 0.1, emissive = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(UNIT, vmat(color, rough, metal, emissive));
  mesh.scale.set(w, h, d);
  mesh.position.set(x, y, z);
  mesh.frustumCulled = false;
  parent.add(mesh);
  return mesh;
}

const C_STEEL = 0x34373c;
const C_STEEL_LIGHT = 0x6a7079;
const C_BLACK = 0x18191b;
const C_WOOD = 0x8a6238;
const C_GLOVE = 0x25272b;
const C_SLEEVE = 0xc65a1c;
const C_ACCENT = 0xe86a1c;

/** Gloved hand plus a hi-vis sleeve running back out of frame. */
function arm(parent: THREE.Object3D, x: number, y: number, z: number, yaw = 0): void {
  box(parent, 0.062, 0.088, 0.078, x, y, z, C_GLOVE, 0.9, 0);
  const sleeve = box(parent, 0.078, 0.078, 0.4, x + Math.sin(yaw) * 0.2, y - 0.062, z + 0.22, C_SLEEVE, 0.9, 0);
  sleeve.rotation.set(0.27, yaw, 0);
}

let glowTexture: THREE.Texture | null = null;
function glow(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,220,160,0.75)');
  grad.addColorStop(0.6, 'rgba(255,140,40,0.2)');
  grad.addColorStop(1, 'rgba(255,90,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

/** Three crossed additive quads that pop for a couple of frames. */
class MuzzleFlash {
  readonly group = new THREE.Group();
  private life = 0;

  constructor(parent: THREE.Object3D, x: number, y: number, z: number, private readonly size: number) {
    const material = new THREE.MeshBasicMaterial({ map: glow(), color: new THREE.Color(5, 3.2, 1.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
    const quad = new THREE.PlaneGeometry(1, 1);
    const a = new THREE.Mesh(quad, material);
    const b = new THREE.Mesh(quad, material);
    b.rotation.y = Math.PI / 2;
    b.scale.set(1.8, 0.6, 1);
    const c = new THREE.Mesh(quad, material);
    c.rotation.x = Math.PI / 2;
    c.scale.set(0.6, 1.8, 1);
    for (const m of [a, b, c]) {
      m.frustumCulled = false;
      m.renderOrder = 5;
      this.group.add(m);
    }
    this.group.position.set(x, y, z);
    this.group.visible = false;
    parent.add(this.group);
  }

  fire(): void {
    this.life = 0.05;
    this.group.visible = true;
    this.group.rotation.z = Math.random() * Math.PI;
    this.group.scale.setScalar(this.size * (0.8 + Math.random() * 0.5));
  }

  update(dt: number): void {
    if (this.life <= 0) return;
    this.life -= dt;
    if (this.life <= 0) this.group.visible = false;
  }
}

// ---------------------------------------------------------------------------
// base
// ---------------------------------------------------------------------------
export abstract class Weapon {
  abstract readonly id: WeaponId;
  abstract readonly name: string;
  /** Root of the first-person model (camera space, parented to the manager's rig). */
  readonly view = new THREE.Group();
  crosshair: CrosshairKind = 'cross';
  canAim = false;
  /** 1 right after a shot, decays to 0. */
  protected kick = 0;
  protected readonly hip = new THREE.Vector3(0.2, -0.19, -0.42);
  protected readonly aim = new THREE.Vector3(0, -0.1, -0.32);

  constructor(protected readonly mgr: WeaponManager) {}

  protected get ctx() {
    return this.mgr.ctx;
  }

  abstract reset(loadout: Loadout | null): void;
  abstract update(dt: number, io: WeaponInput): void;
  abstract ammoHud(): AmmoHud;
  /** Called instead of update() while another tool is in hand. */
  updateIdle(_dt: number): void {}
  onEquip(): void {}
  onHolster(): void {}
  /** Base crosshair gap in CSS pixels. */
  spreadPx(): number {
    return 0;
  }

  /** Position the model between hip and sights and apply recoil. */
  protected place(dt: number, pitch = 0, roll = 0, dropY = 0): void {
    this.kick = damp(this.kick, 0, 13, dt);
    const a = this.canAim ? this.mgr.ads : 0;
    this.view.position.set(lerp(this.hip.x, this.aim.x, a), lerp(this.hip.y, this.aim.y, a) - dropY, lerp(this.hip.z, this.aim.z, a) + this.kick * 0.06);
    this.view.rotation.set(this.kick * 0.15 + pitch, 0, roll);
  }

  /** Hit-scan shot from the eye, with limited penetration of thin soft materials. */
  protected shoot(spread: number, radius: number, power: number, impulse: number, loud: number, muzzle: THREE.Vector3 | null): number {
    const cam = this.ctx.camera.camera;
    const dir = this.mgr.aimDir(spread, vDir);
    vOrigin.copy(cam.position);
    let removedTotal = 0;
    for (let pass = 0; pass < 3; pass++) {
      const hit = this.mgr.raycast(vOrigin, dir, 170);
      if (!hit) {
        if (pass === 0 && muzzle) this.mgr.tracer(muzzle, vB.copy(vOrigin).addScaledVector(dir, 70));
        break;
      }
      if (pass === 0 && muzzle) this.mgr.tracer(muzzle, hit.point);
      const surface = MAT_SURFACE[hit.mat];
      const isBody = hit.kind === 'body';
      const removed = this.mgr.impact(hit, dir, radius, power, 'bullet', impulse, pass === 0 ? loud : loud * 0.5);
      removedTotal += removed;
      if (isBody || removed === 0 || !(surface === 'glass' || surface === 'wood' || surface === 'plaster' || surface === 'foliage')) break;
      vOrigin.copy(hit.point).addScaledVector(dir, 0.3);
      power *= 0.6;
      if (power < 45) break;
    }
    return removedTotal;
  }
}

const ammo = (mag: number | null, reserve: number | null, label: string, reloading = false, reloadProgress = 0, gauge: number | null = null, detail: string | null = null): AmmoHud => ({ mag, reserve, label, reloading, reloadProgress, gauge, detail });

// ---------------------------------------------------------------------------
// 1 · sledgehammer
// ---------------------------------------------------------------------------
export class HammerWeapon extends Weapon {
  readonly id = 'hammer' as const;
  readonly name = 'Sledgehammer';
  private readonly pivot = new THREE.Group();
  private t = -1;
  private heavy = false;
  private struck = false;

  constructor(mgr: WeaponManager) {
    super(mgr);
    this.crosshair = 'dot';
    this.hip.set(0.27, -0.36, -0.46);
    const p = this.pivot;
    box(p, 0.034, 0.68, 0.034, 0, 0.26, 0, C_WOOD, 0.8, 0);
    box(p, 0.04, 0.14, 0.04, 0, -0.02, 0, C_BLACK, 0.95, 0);
    box(p, 0.1, 0.1, 0.25, 0, 0.62, 0, 0x4a4e55, 0.45, 0.7);
    box(p, 0.11, 0.11, 0.03, 0, 0.62, -0.125, C_STEEL_LIGHT, 0.35, 0.8);
    box(p, 0.11, 0.11, 0.03, 0, 0.62, 0.125, C_STEEL_LIGHT, 0.35, 0.8);
    box(p, 0.05, 0.035, 0.05, 0, 0.55, 0, C_ACCENT, 0.6, 0.1);
    arm(p, 0, 0, 0.004);
    this.view.add(p);
  }

  reset(): void {
    this.t = -1;
  }

  ammoHud(): AmmoHud {
    return ammo(null, null, 'SLEDGE', false, 0, null, 'LMB SWING · RMB HEAVY');
  }

  private start(heavy: boolean): void {
    this.t = 0;
    this.heavy = heavy;
    this.struck = false;
    this.ctx.audio.weapon('hammer_swing', { pitch: heavy ? 0.8 : 1, gain: heavy ? 1.1 : 0.8 });
  }

  private strike(): void {
    const { camera, audio } = this.ctx;
    const dir = this.mgr.aimDir(0, vDir);
    const hit = this.mgr.raycast(camera.camera.position, dir, this.heavy ? 2.8 : 2.6);
    if (!hit) return;
    const heavy = this.heavy;
    vA.copy(hit.point);
    this.mgr.impact(hit, dir, heavy ? 0.62 : 0.42, heavy ? 520 : 290, 'melee', heavy ? 1500 : 650);
    audio.weapon('hammer_hit', { pos: vA, gain: heavy ? 1.2 : 0.85, pitch: heavy ? 0.85 : 1 });
    camera.shake(heavy ? 0.3 : 0.15);
    camera.kick(-0.025, (Math.random() - 0.5) * 0.02);
  }

  update(dt: number, io: WeaponInput): void {
    if (this.t < 0) {
      if (io.secondary) this.start(true);
      else if (io.primary) this.start(false);
    }
    const REST = -0.38;
    let rx = REST, py = 0, pz = 0;
    if (this.t >= 0) {
      this.t += dt;
      const wind = this.heavy ? 0.36 : 0.11;
      const strike = this.heavy ? 0.1 : 0.08;
      const total = this.heavy ? 0.95 : 0.46;
      const back = this.heavy ? 0.9 : 0.42;
      if (this.t < wind) {
        const k = smoothstep(0, 1, this.t / wind);
        rx = lerp(REST, back, k);
        py = k * (this.heavy ? 0.12 : 0.04);
      } else if (this.t < wind + strike) {
        const k = (this.t - wind) / strike;
        rx = lerp(back, -1.7, k * k);
        py = (1 - k) * (this.heavy ? 0.12 : 0.04);
        pz = -0.18 * k;
      } else {
        const k = smoothstep(0, 1, (this.t - wind - strike) / (total - wind - strike));
        rx = lerp(-1.7, REST, k);
        pz = -0.18 * (1 - k);
      }
      if (!this.struck && this.t >= wind + strike * 0.8) {
        this.struck = true;
        this.strike();
      }
      if (this.t >= total) this.t = -1;
    }
    this.place(dt);
    this.pivot.rotation.set(rx, 0, 0.2);
    this.pivot.position.set(0, py, pz);
  }
}

// ---------------------------------------------------------------------------
// 2 · pistol
// ---------------------------------------------------------------------------
export class PistolWeapon extends Weapon {
  readonly id = 'pistol' as const;
  readonly name = 'Pistol';
  private static readonly MAG = 12;
  private mag = PistolWeapon.MAG;
  private reserve = 96;
  private cooldown = 0;
  private reload = -1;
  private slideT = 0;
  private readonly slide: THREE.Mesh;
  private readonly flash: MuzzleFlash;

  constructor(mgr: WeaponManager) {
    super(mgr);
    this.canAim = true;
    this.hip.set(0.19, -0.17, -0.44);
    this.aim.set(0, -0.058, -0.34);
    const v = this.view;
    this.slide = box(v, 0.034, 0.042, 0.2, 0, 0.022, -0.02, 0x2b2d31, 0.4, 0.6);
    box(v, 0.03, 0.028, 0.17, 0, -0.012, -0.012, 0x1d1e21, 0.6, 0.3);
    box(v, 0.016, 0.016, 0.02, 0, 0.022, -0.125, 0x0c0c0d, 0.5, 0.4);
    const grip = box(v, 0.032, 0.115, 0.052, 0, -0.075, 0.058, C_BLACK, 0.85, 0.1);
    grip.rotation.x = 0.22;
    box(v, 0.02, 0.006, 0.055, 0, -0.045, 0.012, 0x1d1e21, 0.6, 0.3);
    box(v, 0.008, 0.012, 0.008, -0.011, 0.049, 0.07, 0x0e0f10, 0.5, 0.2);
    box(v, 0.008, 0.012, 0.008, 0.011, 0.049, 0.07, 0x0e0f10, 0.5, 0.2);
    box(v, 0.006, 0.012, 0.008, 0, 0.049, -0.11, C_ACCENT, 0.5, 0, 1.4);
    arm(v, 0.002, -0.08, 0.066);
    this.flash = new MuzzleFlash(v, 0, 0.022, -0.17, 0.15);
  }

  reset(loadout: Loadout | null): void {
    const total = loadout?.rounds ?? 108;
    this.mag = Math.min(PistolWeapon.MAG, total);
    this.reserve = total - this.mag;
    this.cooldown = 0;
    this.reload = -1;
  }

  override spreadPx(): number {
    return 5;
  }

  ammoHud(): AmmoHud {
    return ammo(this.mag, this.mgr.unlimited ? Infinity : this.reserve, '9 MM', this.reload >= 0, Math.max(0, this.reload));
  }

  override onHolster(): void {
    this.reload = -1;
  }

  private startReload(): void {
    if (this.reload >= 0 || this.mag >= PistolWeapon.MAG) return;
    if (!this.mgr.unlimited && this.reserve <= 0) return;
    this.reload = 0;
    this.ctx.audio.weapon('reload');
  }

  private fire(): void {
    const { camera, audio, renderer, player } = this.ctx;
    this.mag--;
    this.cooldown = 0.125;
    const ads = this.mgr.ads;
    const spread = (0.005 + this.mgr.bloom * 0.03 + clamp(player.speed / 8, 0, 1) * 0.012 + (player.onGround ? 0 : 0.03)) * (1 - ads * 0.65);
    const muzzle = this.mgr.muzzleWorld(lerp(0.19, 0, ads), lerp(-0.15, -0.04, ads), 0.62, vA);
    this.shoot(spread, 0.22, 150, 90, 1, muzzle);
    audio.weapon('pistol');
    this.flash.fire();
    renderer.viewFlash.position.set(this.view.position.x, this.view.position.y + 0.05, this.view.position.z - 0.25);
    renderer.viewFlash.intensity = 7;
    renderer.flash(muzzle, 0xffb060, 22, 9, 0.07);
    camera.kick(0.02 + Math.random() * 0.008, (Math.random() - 0.5) * 0.014);
    this.kick = 1;
    this.slideT = 0.08;
    this.mgr.bloom = Math.min(1, this.mgr.bloom + 0.3);
  }

  update(dt: number, io: WeaponInput): void {
    this.cooldown -= dt;
    this.flash.update(dt);
    if (this.reload >= 0) {
      this.reload += dt / 1.25;
      if (this.reload >= 1) {
        const need = PistolWeapon.MAG - this.mag;
        const take = this.mgr.unlimited ? need : Math.min(need, this.reserve);
        this.mag += take;
        if (!this.mgr.unlimited) this.reserve -= take;
        this.reload = -1;
      }
    } else if (io.reloadPressed) this.startReload();
    else if (io.primaryPressed && this.cooldown <= 0) {
      if (this.mag > 0) this.fire();
      else {
        this.ctx.audio.weapon('empty');
        this.startReload();
      }
    }
    this.slideT = Math.max(0, this.slideT - dt);
    this.slide.position.z = -0.02 + (this.slideT > 0 || this.mag === 0 ? 0.035 : 0);
    const r = this.reload >= 0 ? Math.sin(Math.PI * this.reload) : 0;
    this.place(dt, -r * 0.75, r * 0.5, r * 0.1);
  }
}

// ---------------------------------------------------------------------------
// 3 · pump shotgun
// ---------------------------------------------------------------------------
export class ShotgunWeapon extends Weapon {
  readonly id = 'shotgun' as const;
  readonly name = 'Shotgun';
  private static readonly TUBE = 6;
  private mag = ShotgunWeapon.TUBE;
  private reserve = 48;
  /** Time since the last shot (pump cycle). */
  private cycle = 9;
  private pumped = true;
  private reloading = false;
  private shellT = 0;
  private readonly forend: THREE.Mesh;
  private readonly offhand = new THREE.Group();
  private readonly flash: MuzzleFlash;

  constructor(mgr: WeaponManager) {
    super(mgr);
    this.canAim = true;
    this.crosshair = 'circle';
    this.hip.set(0.2, -0.2, -0.36);
    this.aim.set(0, -0.062, -0.26);
    const v = this.view;
    box(v, 0.046, 0.062, 0.22, 0, 0, 0.04, C_STEEL, 0.45, 0.6);
    box(v, 0.026, 0.026, 0.52, 0, 0.016, -0.32, 0x26282b, 0.38, 0.7);
    box(v, 0.022, 0.022, 0.4, 0, -0.012, -0.27, 0x2f3236, 0.45, 0.6);
    this.forend = box(v, 0.05, 0.046, 0.17, 0, -0.016, -0.2, C_WOOD, 0.75, 0);
    const stock = box(v, 0.04, 0.075, 0.28, 0, -0.035, 0.28, C_WOOD, 0.75, 0);
    stock.rotation.x = 0.16;
    const grip = box(v, 0.036, 0.09, 0.045, 0, -0.07, 0.12, C_WOOD, 0.75, 0);
    grip.rotation.x = 0.35;
    box(v, 0.006, 0.012, 0.008, 0, 0.035, -0.57, C_ACCENT, 0.5, 0, 1.4);
    box(v, 0.02, 0.01, 0.03, 0, 0.036, 0.1, 0x101113, 0.5, 0.3);
    arm(v, 0.004, -0.075, 0.125);
    // the support hand rides the forend (kept in its own group: the forend mesh is scaled)
    arm(this.offhand, -0.012, -0.05, -0.2, -0.55);
    v.add(this.offhand);
    this.flash = new MuzzleFlash(v, 0, 0.016, -0.62, 0.26);
  }

  reset(loadout: Loadout | null): void {
    const total = loadout?.shells ?? 54;
    this.mag = Math.min(ShotgunWeapon.TUBE, total);
    this.reserve = total - this.mag;
    this.cycle = 9;
    this.pumped = true;
    this.reloading = false;
  }

  override spreadPx(): number {
    return 24;
  }

  ammoHud(): AmmoHud {
    return ammo(this.mag, this.mgr.unlimited ? Infinity : this.reserve, '12 GA', this.reloading, this.reloading ? clamp(this.shellT / 0.48, 0, 1) : 0);
  }

  override onHolster(): void {
    this.reloading = false;
  }

  private canReload(): boolean {
    return this.mag < ShotgunWeapon.TUBE && (this.mgr.unlimited || this.reserve > 0);
  }

  private fire(): void {
    const { camera, audio, renderer, damage } = this.ctx;
    this.mag--;
    this.cycle = 0;
    this.pumped = false;
    this.reloading = false;
    const ads = this.mgr.ads;
    const spread = lerp(0.062, 0.04, ads);
    const muzzle = this.mgr.muzzleWorld(lerp(0.2, 0, ads), lerp(-0.17, -0.045, ads), 0.9, vA).clone();
    // close-range blast: the column of shot still acts as one mass
    const centre = this.mgr.raycast(camera.camera.position, this.mgr.aimDir(0, vDir), 5.5);
    if (centre && centre.kind === 'world') {
      const k = 1 - centre.dist / 5.5;
      damage.sphere(centre.point.x + vDir.x * 0.1, centre.point.y + vDir.y * 0.1, centre.point.z + vDir.z * 0.1, 0.3 + 0.22 * k, 150 + 190 * k, 'bullet', vDir);
    }
    for (let i = 0; i < 9; i++) this.shoot(spread, 0.2, 112, 55, i < 2 ? 0.9 : 0, i % 3 === 0 ? muzzle : null);
    audio.weapon('shotgun');
    this.flash.fire();
    renderer.viewFlash.position.set(this.view.position.x, this.view.position.y + 0.05, this.view.position.z - 0.7);
    renderer.viewFlash.intensity = 12;
    renderer.flash(muzzle, 0xffb060, 44, 12, 0.09);
    camera.kick(0.06 + Math.random() * 0.015, (Math.random() - 0.5) * 0.03);
    camera.shake(0.12);
    this.kick = 1.6;
    this.mgr.bloom = 1;
  }

  update(dt: number, io: WeaponInput): void {
    this.cycle += dt;
    this.flash.update(dt);
    if (!this.pumped && this.cycle >= 0.28) {
      this.pumped = true;
      this.ctx.audio.weapon('shotgun_pump');
    }
    const ready = this.cycle >= 0.72;
    if (io.primaryPressed && ready) {
      if (this.mag > 0) this.fire();
      else {
        this.ctx.audio.weapon('empty');
        if (this.canReload()) this.reloading = true;
      }
    } else if (io.reloadPressed && ready && this.canReload()) {
      this.reloading = true;
      this.shellT = 0;
    }
    if (this.reloading) {
      this.shellT += dt;
      if (this.shellT >= 0.48) {
        this.shellT = 0;
        this.mag++;
        if (!this.mgr.unlimited) this.reserve--;
        this.ctx.audio.weapon('reload', { pitch: 1.35, gain: 0.7 });
        if (!this.canReload()) {
          this.reloading = false;
          this.ctx.audio.weapon('shotgun_pump', { gain: 0.8 });
        }
      }
    }
    // pump: back between 0.2 s and 0.42 s, forward again by 0.62 s
    const c = this.cycle;
    const pump = c < 0.2 ? 0 : c < 0.4 ? smoothstep(0.2, 0.4, c) : c < 0.62 ? 1 - smoothstep(0.42, 0.62, c) : 0;
    this.forend.position.z = -0.2 + pump * 0.085;
    this.offhand.position.z = pump * 0.085;
    const r = this.reloading ? 0.5 + 0.12 * Math.sin((this.shellT / 0.48) * Math.PI) : 0;
    this.place(dt, r * 0.5, -r * 0.6, r * 0.06);
  }
}

// ---------------------------------------------------------------------------
// 4 · demolition charges
// ---------------------------------------------------------------------------
interface Charge {
  mesh: THREE.Group;
  led: THREE.Mesh;
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  body: VoxelBody | null;
  local: THREE.Vector3;
  localN: THREE.Vector3;
  /** Seconds until detonation; negative = waiting for the remote. */
  timer: number;
  beep: number;
  blink: number;
  falling: boolean;
  vy: number;
  check: number;
}

const CHARGE_MODES = [
  { label: 'REMOTE', seconds: -1 },
  { label: 'TIMER 3 S', seconds: 3 },
  { label: 'TIMER 6 S', seconds: 6 },
  { label: 'TIMER 10 S', seconds: 10 },
] as const;
const CHARGE_REACH = 3.4;
const CHARGE_LIMIT = 16;
const CHARGE_SCALE = 0.72;

function chargeModel(ghost: boolean): { group: THREE.Group; led: THREE.Mesh } {
  const group = new THREE.Group();
  if (ghost) {
    const m = new THREE.Mesh(UNIT, new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.35, depthWrite: false, fog: false }));
    m.scale.set(0.26, 0.09, 0.34);
    m.position.y = 0.045;
    group.add(m);
    return { group, led: m };
  }
  box(group, 0.26, 0.09, 0.34, 0, 0.045, 0, 0x4a4f3c, 0.85, 0);
  box(group, 0.27, 0.095, 0.04, 0, 0.045, -0.09, C_BLACK, 0.9, 0);
  box(group, 0.27, 0.095, 0.04, 0, 0.045, 0.09, C_BLACK, 0.9, 0);
  box(group, 0.09, 0.03, 0.09, 0.05, 0.1, 0, 0x2a2c30, 0.6, 0.3);
  box(group, 0.012, 0.09, 0.012, -0.09, 0.13, -0.12, 0x101113, 0.5, 0.5);
  const led = new THREE.Mesh(UNIT, new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.5, 0.3), toneMapped: false, fog: false }));
  led.scale.set(0.03, 0.02, 0.03);
  led.position.set(0.05, 0.123, 0);
  group.add(led);
  return { group, led };
}

export class ChargeWeapon extends Weapon {
  readonly id = 'charge' as const;
  readonly name = 'Charges';
  private stock = 12;
  private mode = 0;
  private readonly charges: Charge[] = [];
  private readonly pool: { group: THREE.Group; led: THREE.Mesh }[] = [];
  private readonly ghost: THREE.Group;
  private readonly held: THREE.Group;
  private readonly thumb: THREE.Mesh;
  private throwT = 0;
  private pressT = 0;
  private hooked = false;

  constructor(mgr: WeaponManager) {
    super(mgr);
    this.crosshair = 'dot';
    this.hip.set(0, 0, 0);
    this.ghost = chargeModel(true).group;
    this.ghost.visible = false;
    this.ctx.renderer.scene.add(this.ghost);
    // right hand: the next charge
    this.held = new THREE.Group();
    const model = chargeModel(false).group;
    model.rotation.set(1.15, 0.35, 0);
    model.scale.setScalar(0.62);
    this.held.add(model);
    arm(this.held, 0.02, -0.07, 0.07);
    this.held.position.set(0.2, -0.17, -0.42);
    this.view.add(this.held);
    // left hand: the detonator
    const det = new THREE.Group();
    box(det, 0.05, 0.12, 0.032, 0, 0, 0, 0x2a2c30, 0.6, 0.2);
    box(det, 0.006, 0.1, 0.006, 0.016, 0.11, 0, 0x0c0c0d, 0.5, 0.6);
    this.thumb = box(det, 0.026, 0.014, 0.026, 0, 0.066, 0, 0xb8322a, 0.5, 0, 0.6);
    box(det, 0.01, 0.01, 0.004, -0.014, 0.04, -0.018, 0x3adf6a, 0.4, 0, 2);
    arm(det, 0, -0.03, 0.03, 0.4);
    det.position.set(-0.2, -0.2, -0.42);
    det.rotation.set(-0.25, 0.25, 0.1);
    this.view.add(det);
  }

  /** Charges currently planted in the world. */
  get placed(): number {
    return this.charges.length;
  }

  reset(loadout: Loadout | null): void {
    this.stock = loadout?.charges ?? 12;
    this.mode = 0;
    for (const c of this.charges) this.recycle(c);
    this.charges.length = 0;
    this.ghost.visible = false;
    if (!this.hooked) {
      this.hooked = true;
      this.ctx.explosions.listeners.push((x, y, z, radius) => this.sympathetic(x, y, z, radius));
    }
  }

  ammoHud(): AmmoHud {
    const mode = CHARGE_MODES[this.mode];
    const detail = mode.seconds < 0 ? (this.charges.length ? 'REMOTE · RMB DETONATE' : 'REMOTE · R MODE') : `${mode.label} · R MODE`;
    return ammo(this.charges.length, this.mgr.unlimited ? Infinity : this.stock, 'PLACED', false, 0, null, detail);
  }

  override onHolster(): void {
    this.ghost.visible = false;
  }

  private recycle(c: Charge): void {
    this.ctx.renderer.scene.remove(c.mesh);
    this.pool.push({ group: c.mesh, led: c.led });
  }

  private plant(): void {
    const { camera, audio, debris, renderer, hud } = this.ctx;
    if (!this.mgr.unlimited && this.stock <= 0) {
      audio.weapon('empty');
      return;
    }
    if (this.charges.length >= CHARGE_LIMIT) {
      audio.weapon('empty');
      hud.toast('Detonate some charges first', 'warn');
      return;
    }
    const hit = this.mgr.raycast(camera.camera.position, this.mgr.aimDir(0, vDir), CHARGE_REACH);
    if (!hit) return;
    const model = this.pool.pop() ?? chargeModel(false);
    const c: Charge = {
      mesh: model.group,
      led: model.led,
      pos: hit.point.clone().addScaledVector(hit.normal, 0.01),
      normal: hit.normal.clone(),
      body: hit.body,
      local: new THREE.Vector3(),
      localN: new THREE.Vector3(),
      timer: CHARGE_MODES[this.mode].seconds,
      beep: 0,
      blink: 0,
      falling: false,
      vy: 0,
      check: 0.2,
    };
    if (c.body) {
      debris.toLocal(c.body, c.pos.x, c.pos.y, c.pos.z, c.local);
      const r = c.body.rb.rotation();
      c.localN.copy(c.normal).applyQuaternion(qA.set(-r.x, -r.y, -r.z, r.w));
    }
    this.orient(c);
    renderer.scene.add(c.mesh);
    this.charges.push(c);
    if (!this.mgr.unlimited) this.stock--;
    this.mgr.explosivesUsed++;
    this.throwT = 0.28;
    audio.weapon('charge_place', { pos: c.pos });
  }

  private orient(c: Charge): void {
    c.mesh.position.copy(c.pos);
    c.mesh.quaternion.setFromUnitVectors(UP, c.normal);
  }

  private detonate(c: Charge): void {
    const i = this.charges.indexOf(c);
    if (i >= 0) this.charges.splice(i, 1);
    this.recycle(c);
    this.ctx.explosions.explode(c.pos.x + c.normal.x * 0.12, c.pos.y + c.normal.y * 0.12, c.pos.z + c.normal.z * 0.12, CHARGE_SCALE);
  }

  /** Another explosion close by sets waiting charges off. */
  private sympathetic(x: number, y: number, z: number, radius: number): void {
    for (const c of this.charges) {
      if (c.timer >= 0 && c.timer < 0.2) continue;
      const d = Math.hypot(c.pos.x - x, c.pos.y - y, c.pos.z - z);
      if (d < radius * 0.85) c.timer = 0.07 + Math.random() * 0.12;
    }
  }

  private fireRemote(): void {
    const { audio } = this.ctx;
    this.pressT = 0.18;
    audio.weapon('detonator');
    let k = 0;
    for (const c of this.charges) if (c.timer < 0) c.timer = 0.12 + 0.1 * k++;
  }

  /** Planted charges keep ticking whichever tool is in hand. */
  private simulate(dt: number): void {
    const { grid, debris, audio } = this.ctx;
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const c = this.charges[i];
      // --- stay attached to whatever the charge was stuck to
      if (c.falling) {
        c.vy -= GRAVITY * dt;
        const step = Math.max(0.02, -c.vy * dt);
        const hit = this.mgr.raycast(vA.copy(c.pos).addScaledVector(UP, 0.05), DOWN, step + 0.05);
        if (hit) {
          c.pos.copy(hit.point).addScaledVector(UP, 0.01);
          c.normal.copy(UP);
          c.falling = false;
          c.body = hit.body;
          if (c.body) {
            debris.toLocal(c.body, c.pos.x, c.pos.y, c.pos.z, c.local);
            const r = c.body.rb.rotation();
            c.localN.copy(UP).applyQuaternion(qA.set(-r.x, -r.y, -r.z, r.w));
          }
        } else {
          c.pos.y -= step;
          if (c.pos.y < -5) c.timer = 0;
        }
        this.orient(c);
      } else if (c.body) {
        if (!c.body.alive) {
          c.body = null;
          c.falling = true;
          c.vy = 0;
        } else if (!c.body.rb.isSleeping()) {
          debris.toWorld(c.body, c.local.x, c.local.y, c.local.z, c.pos);
          const r = c.body.rb.rotation();
          c.normal.copy(c.localN).applyQuaternion(qA.set(r.x, r.y, r.z, r.w));
          this.orient(c);
        }
      } else {
        c.check -= dt;
        if (c.check <= 0) {
          c.check = 0.2;
          if (!grid.solidAt(c.pos.x - c.normal.x * 0.12, c.pos.y - c.normal.y * 0.12, c.pos.z - c.normal.z * 0.12)) {
            c.falling = true;
            c.vy = 0;
          }
        }
      }
      // --- indicator and fuse
      c.blink += dt;
      if (c.timer < 0) {
        c.led.visible = c.blink % 1.3 < 0.12;
      } else {
        c.timer -= dt;
        c.beep -= dt;
        if (c.beep <= 0 && c.timer > 0.15) {
          c.beep = clamp(c.timer * 0.16, 0.07, 0.9);
          c.blink = 0;
          audio.weapon('charge_beep', { pos: c.pos, pitch: c.timer < 1.2 ? 1.25 : 1, gain: 0.8 });
        }
        c.led.visible = c.blink < 0.06 || c.timer < 0.15;
        if (c.timer <= 0) this.detonate(c);
      }
    }
  }

  override updateIdle(dt: number): void {
    this.simulate(dt);
  }

  update(dt: number, io: WeaponInput): void {
    const { camera, audio } = this.ctx;
    if (io.reloadPressed) {
      this.mode = (this.mode + 1) % CHARGE_MODES.length;
      audio.ui('tick');
    }
    if (io.primaryPressed) this.plant();
    if (io.secondaryPressed) {
      if (this.charges.some((c) => c.timer < 0)) this.fireRemote();
      else audio.weapon('empty');
    }
    this.simulate(dt);

    // placement preview
    const canPlace = (this.mgr.unlimited || this.stock > 0) && this.charges.length < CHARGE_LIMIT;
    const hit = canPlace ? this.mgr.raycast(camera.camera.position, this.mgr.aimDir(0, vDir), CHARGE_REACH) : null;
    this.ghost.visible = !!hit;
    if (hit) {
      this.ghost.position.copy(hit.point).addScaledVector(hit.normal, 0.01);
      this.ghost.quaternion.setFromUnitVectors(UP, hit.normal);
    }

    this.throwT = Math.max(0, this.throwT - dt);
    this.pressT = Math.max(0, this.pressT - dt);
    const t = this.throwT / 0.28;
    this.held.visible = this.mgr.unlimited || this.stock > 0;
    this.held.position.set(0.2, -0.17 - Math.sin(t * Math.PI) * 0.05, -0.42 - Math.sin(t * Math.PI) * 0.16);
    this.thumb.position.y = 0.066 - (this.pressT > 0 ? 0.008 : 0);
    this.place(dt);
  }
}

// ---------------------------------------------------------------------------
// 5 · rocket launcher
// ---------------------------------------------------------------------------
interface Rocket {
  mesh: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  alive: boolean;
  sound: LoopHandle | null;
  light: LightHandle | null;
}

export class RocketWeapon extends Weapon {
  readonly id = 'rocket' as const;
  readonly name = 'Rocket Launcher';
  private loaded = true;
  private reserve = 7;
  private reload = -1;
  private readonly rockets: Rocket[] = [];
  private readonly warhead: THREE.Mesh;
  private readonly flash: MuzzleFlash;

  constructor(mgr: WeaponManager) {
    super(mgr);
    this.canAim = true;
    this.hip.set(0.22, -0.13, -0.26);
    this.aim.set(0.075, -0.1, -0.2);
    const v = this.view;
    box(v, 0.1, 0.1, 0.92, 0, 0, -0.12, 0x4a5240, 0.7, 0.15);
    box(v, 0.122, 0.122, 0.06, 0, 0, -0.57, 0x2c3027, 0.6, 0.3);
    box(v, 0.122, 0.122, 0.07, 0, 0, 0.33, 0x2c3027, 0.6, 0.3);
    box(v, 0.105, 0.03, 0.2, 0, 0.055, -0.12, C_ACCENT, 0.6, 0.1);
    box(v, 0.03, 0.075, 0.07, -0.075, 0.085, -0.14, C_BLACK, 0.5, 0.3);
    box(v, 0.012, 0.03, 0.012, -0.075, 0.105, -0.36, C_BLACK, 0.5, 0.3);
    const grip = box(v, 0.036, 0.11, 0.045, 0, -0.1, -0.1, C_BLACK, 0.85, 0.1);
    grip.rotation.x = 0.2;
    box(v, 0.036, 0.09, 0.04, 0, -0.09, -0.36, C_BLACK, 0.85, 0.1);
    this.warhead = box(v, 0.07, 0.07, 0.12, 0, 0, -0.63, 0xb8322a, 0.5, 0.2);
    arm(v, 0.004, -0.1, -0.09);
    arm(v, -0.012, -0.1, -0.35, -0.5);
    this.flash = new MuzzleFlash(v, 0, 0, -0.66, 0.34);
    const scene = this.ctx.renderer.scene;
    for (let i = 0; i < 5; i++) {
      const mesh = new THREE.Group();
      box(mesh, 0.09, 0.09, 0.5, 0, 0, 0, 0x5c6350, 0.6, 0.2);
      box(mesh, 0.075, 0.075, 0.14, 0, 0, -0.3, 0xb8322a, 0.5, 0.2);
      box(mesh, 0.22, 0.012, 0.1, 0, 0, 0.22, 0x2c3027, 0.6, 0.3);
      box(mesh, 0.012, 0.22, 0.1, 0, 0, 0.22, 0x2c3027, 0.6, 0.3);
      const jet = new THREE.Mesh(UNIT, new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3.4, 1.2), toneMapped: false, fog: false }));
      jet.scale.set(0.06, 0.06, 0.16);
      jet.position.z = 0.32;
      mesh.add(jet);
      mesh.visible = false;
      scene.add(mesh);
      this.rockets.push({ mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, alive: false, sound: null, light: null });
    }
  }

  reset(loadout: Loadout | null): void {
    const total = loadout?.rockets ?? 8;
    this.loaded = total > 0;
    this.reserve = Math.max(0, total - 1);
    this.reload = -1;
    for (const r of this.rockets) this.retire(r);
  }

  override spreadPx(): number {
    return 9;
  }

  ammoHud(): AmmoHud {
    return ammo(this.loaded ? 1 : 0, this.mgr.unlimited ? Infinity : this.reserve, 'HE ROCKET', this.reload >= 0, Math.max(0, this.reload));
  }

  private retire(r: Rocket): void {
    r.alive = false;
    r.mesh.visible = false;
    r.sound?.stop(0.08);
    r.sound = null;
    r.light?.release();
    r.light = null;
  }

  private launch(): void {
    const { camera, audio, renderer, particles, explosions } = this.ctx;
    const r = this.rockets.find((x) => !x.alive);
    if (!r) return;
    const cam = camera.camera;
    const dir = this.mgr.aimDir(0.004 * (1 - this.mgr.ads), vDir);
    this.loaded = false;
    this.mgr.explosivesUsed++;
    // aim at whatever is under the crosshair, launch from the tube
    const target = this.mgr.raycast(cam.position, dir, 220);
    const aimPoint = vB.copy(cam.position).addScaledVector(dir, target ? Math.max(target.dist, 3) : 220);
    const blocked = target && target.dist < 1.1;
    const start = this.mgr.muzzleWorld(lerp(0.2, 0.07, this.mgr.ads), -0.1, 0.9, vA);
    audio.weapon('rocket_launch');
    this.flash.fire();
    renderer.viewFlash.position.set(0.2, -0.1, -0.8);
    renderer.viewFlash.intensity = 14;
    camera.kick(0.05, (Math.random() - 0.5) * 0.02);
    camera.shake(0.22);
    this.kick = 1.8;
    this.mgr.bloom = 1;
    // back-blast
    for (let i = 0; i < 6; i++) particles.smoke(cam.position.x - dir.x * (0.6 + i * 0.25), cam.position.y - 0.15, cam.position.z - dir.z * (0.6 + i * 0.25), -dir.x * 3, 0.6, -dir.z * 3, 0.7, 1.4, 0.7, 0.35);
    if (blocked && target) {
      explosions.explode(target.point.x - dir.x * 0.1, target.point.y - dir.y * 0.1, target.point.z - dir.z * 0.1, 1);
      return;
    }
    r.alive = true;
    r.life = 7;
    r.pos.copy(start);
    r.vel.copy(aimPoint).sub(start).normalize().multiplyScalar(26);
    r.mesh.visible = true;
    r.mesh.position.copy(start);
    r.mesh.lookAt(aimPoint);
    r.sound = audio.loop('rocket', { pos: r.pos, gain: 0.9 });
    r.light = renderer.holdLight(0xffa040, 14);
  }

  private simulate(dt: number): void {
    const { particles, explosions } = this.ctx;
    for (const r of this.rockets) {
      if (!r.alive) continue;
      r.life -= dt;
      const speed = r.vel.length();
      vC.copy(r.vel).multiplyScalar(1 / speed);
      // motor burn: accelerate along the heading, sag slightly under gravity
      const next = Math.min(72, speed + 70 * dt);
      r.vel.copy(vC).multiplyScalar(next);
      r.vel.y -= 1.4 * dt;
      const step = next * dt;
      const hit = this.mgr.raycast(r.pos, vC, step + 0.25);
      if (hit || r.life <= 0) {
        const p = hit ? vA.copy(hit.point).addScaledVector(vC, -0.14) : r.pos;
        this.retire(r);
        explosions.explode(p.x, p.y, p.z, 1);
        continue;
      }
      r.pos.addScaledVector(vC, step);
      r.mesh.position.copy(r.pos);
      r.mesh.lookAt(vA.copy(r.pos).add(r.vel));
      r.mesh.rotateZ(r.life * 9);
      r.sound?.setPos(r.pos);
      r.light?.set(r.pos, 26 + Math.random() * 8);
      const bx = r.pos.x - vC.x * 0.4, by = r.pos.y - vC.y * 0.4, bz = r.pos.z - vC.z * 0.4;
      particles.smoke(bx, by, bz, (Math.random() - 0.5) * 0.6, 0.3 + Math.random() * 0.4, (Math.random() - 0.5) * 0.6, 0.45, 1.5 + Math.random(), 0.74, 0.34);
      particles.flame(bx, by, bz, -vC.x * 4, -vC.y * 4, -vC.z * 4, 0.3, 0.12, 1.2);
    }
  }

  override updateIdle(dt: number): void {
    this.simulate(dt);
  }

  override onHolster(): void {
    this.reload = -1;
  }

  update(dt: number, io: WeaponInput): void {
    this.flash.update(dt);
    const hasSpare = this.mgr.unlimited || this.reserve > 0;
    if (this.reload >= 0) {
      this.reload += dt / 1.7;
      if (this.reload >= 1) {
        this.reload = -1;
        this.loaded = true;
        if (!this.mgr.unlimited) this.reserve--;
      }
    } else if (!this.loaded && hasSpare) {
      this.reload = 0;
      this.ctx.audio.weapon('reload', { pitch: 0.7, delay: 0.35 });
    } else if (io.primaryPressed) {
      if (this.loaded) this.launch();
      else this.ctx.audio.weapon('empty');
    }
    this.simulate(dt);
    this.warhead.visible = this.loaded || this.reload > 0.6;
    const r = this.reload >= 0 ? Math.sin(Math.PI * this.reload) : 0;
    this.place(dt, r * 0.45, r * 0.25, r * 0.1);
  }
}

// ---------------------------------------------------------------------------
// 6 · blowtorch
// ---------------------------------------------------------------------------
const TORCH_RANGE = 2.5;
const TORCH_TICK = 0.06;

export class BlowtorchWeapon extends Weapon {
  readonly id = 'torch' as const;
  readonly name = 'Blowtorch';
  private fuel = 1;
  private lit = false;
  private idle = 9;
  private tick = 0;
  private sound: LoopHandle | null = null;
  private light: LightHandle | null = null;
  private readonly cone: THREE.Mesh;
  private readonly heat = new WeakMap<VoxelBody, number>();

  constructor(mgr: WeaponManager) {
    super(mgr);
    this.crosshair = 'dot';
    this.hip.set(0.2, -0.17, -0.4);
    const v = this.view;
    box(v, 0.078, 0.17, 0.078, 0, -0.1, 0.03, 0xd9a520, 0.5, 0.3);
    box(v, 0.05, 0.03, 0.05, 0, -0.005, 0.03, 0x2a2c30, 0.5, 0.5);
    box(v, 0.03, 0.03, 0.22, 0, 0.022, -0.08, 0xa8843c, 0.35, 0.8);
    box(v, 0.042, 0.042, 0.06, 0, 0.022, -0.21, C_STEEL, 0.4, 0.7);
    box(v, 0.02, 0.02, 0.02, 0.03, 0.03, 0.02, 0xb8322a, 0.5, 0.1);
    box(v, 0.02, 0.06, 0.012, 0, -0.03, -0.03, C_BLACK, 0.6, 0.3);
    arm(v, 0.004, -0.1, 0.045);
    this.cone = new THREE.Mesh(UNIT, new THREE.MeshBasicMaterial({ map: glow(), color: new THREE.Color(2.2, 4.2, 7), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }));
    this.cone.scale.set(0.035, 0.035, 0.16);
    this.cone.position.set(0, 0.022, -0.32);
    this.cone.visible = false;
    this.cone.frustumCulled = false;
    v.add(this.cone);
  }

  reset(): void {
    this.fuel = 1;
    this.idle = 9;
    this.extinguish();
  }

  ammoHud(): AmmoHud {
    return ammo(null, null, 'FUEL', false, 0, this.fuel, this.fuel <= 0.01 ? 'RECHARGING' : null);
  }

  override onHolster(): void {
    this.extinguish();
  }

  private extinguish(): void {
    if (!this.lit) return;
    this.lit = false;
    this.cone.visible = false;
    this.sound?.stop(0.12);
    this.sound = null;
    this.light?.release();
    this.light = null;
  }

  /** Apply one tick of heat at the point the flame touches. */
  private burn(point: THREE.Vector3, normal: THREE.Vector3, mat: number, body: VoxelBody | null): void {
    const { damage, debris, fire, particles } = this.ctx;
    const surface = MAT_SURFACE[mat];
    if (body) {
      if (body.explosive && body.fuse < 0) {
        // containers cook off after a moment instead of going up instantly
        const h = (this.heat.get(body) ?? 0) + TORCH_TICK;
        this.heat.set(body, h);
        particles.sparks(point.x, point.y, point.z, normal.x, normal.y, normal.z, 2, 3);
        if (h > 0.7) body.fuse = 0.5 + Math.random() * 0.5;
        return;
      }
      debris.damageBody(body, point.x - normal.x * 0.05, point.y - normal.y * 0.05, point.z - normal.z * 0.05, 0.24, surface === 'metal' ? 260 : 150, true);
    } else {
      damage.sphere(point.x - normal.x * 0.06, point.y - normal.y * 0.06, point.z - normal.z * 0.06, 0.24, 160, 'torch');
      if (MAT_FLAGS[mat] & F_FLAMMABLE) {
        fire.igniteAt(point.x - normal.x * 0.1, point.y - normal.y * 0.1, point.z - normal.z * 0.1);
        fire.igniteAt(point.x - normal.x * 0.1 + (Math.random() - 0.5) * 0.4, point.y - normal.y * 0.1 + (Math.random() - 0.5) * 0.4, point.z - normal.z * 0.1 + (Math.random() - 0.5) * 0.4);
      }
    }
    if (surface === 'metal') particles.sparks(point.x, point.y, point.z, normal.x, normal.y, normal.z, 3, 4.5);
    else if (Math.random() < 0.4) particles.smoke(point.x, point.y, point.z, normal.x * 0.4, 0.8, normal.z * 0.4, 0.3, 1.2, 0.25, 0.3);
  }

  update(dt: number, io: WeaponInput): void {
    const { camera, audio, renderer, particles } = this.ctx;
    const want = io.primary && this.fuel > 0;
    if (want && !this.lit) {
      this.lit = true;
      this.tick = 0;
      audio.weapon('torch_ignite');
      this.sound = audio.loop('torch', { gain: 0.8 });
      this.light = renderer.holdLight(0xffb468, 7);
    } else if (!want && this.lit) this.extinguish();
    if (io.primaryPressed && this.fuel <= 0) audio.weapon('empty');

    if (this.lit) {
      this.idle = 0;
      if (!this.mgr.unlimited) this.fuel = Math.max(0, this.fuel - dt / 22);
      else this.fuel = Math.max(0.0, this.fuel - dt / 60);
      const cam = camera.camera;
      const dir = this.mgr.aimDir(0, vDir);
      const hit = this.mgr.raycast(cam.position, dir, TORCH_RANGE);
      const reach = hit ? hit.dist : TORCH_RANGE;
      const nozzle = this.mgr.muzzleWorld(0.2, -0.15, 0.66, vA);
      const end = vB.copy(cam.position).addScaledVector(dir, reach);
      const jet = vC.copy(end).sub(nozzle);
      const len = Math.max(0.05, jet.length());
      jet.multiplyScalar(1 / len);
      for (let i = 0; i < 3; i++) {
        const s = 9 + Math.random() * 3;
        particles.flame(nozzle.x, nozzle.y, nozzle.z, jet.x * s + (Math.random() - 0.5) * 0.8, jet.y * s + (Math.random() - 0.5) * 0.8, jet.z * s + (Math.random() - 0.5) * 0.8, 0.09 + Math.random() * 0.06, Math.min(0.26, len / s), 1.1);
      }
      this.cone.visible = true;
      this.cone.scale.z = 0.14 + Math.random() * 0.06;
      this.cone.position.z = -0.24 - this.cone.scale.z / 2;
      if (hit) {
        const p = vB.copy(hit.point);
        const n = hit.normal;
        this.light?.set(vC.copy(p).addScaledVector(n, 0.12), 9 + Math.random() * 5);
        this.tick += dt;
        let guard = 0;
        while (this.tick >= TORCH_TICK && guard++ < 3) {
          this.tick -= TORCH_TICK;
          this.burn(p, n, hit.mat, hit.body);
        }
        this.sound?.setPitch(1.12);
      } else {
        this.light?.set(end, 3);
        this.sound?.setPitch(1);
      }
    } else {
      this.idle += dt;
      if (this.idle > 0.9) this.fuel = Math.min(1, this.fuel + dt / 7);
    }
    this.place(dt, this.lit ? (Math.random() - 0.5) * 0.006 : 0, 0, 0);
  }

  override updateIdle(dt: number): void {
    this.idle += dt;
    if (this.idle > 0.9) this.fuel = Math.min(1, this.fuel + dt / 7);
  }
}
