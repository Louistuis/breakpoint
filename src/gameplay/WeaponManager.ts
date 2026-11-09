/**
 * Owns the six tools, weapon switching, the first-person view-model rig (sway, bob,
 * recoil, equip animation) and the shared hit-scan / impact helpers every tool uses.
 */
import * as THREE from 'three';
import type { GameContext } from '../engine/Context';
import { clamp, damp } from '../utils/math';
import { settings } from '../utils/settings';
import { MAT_COLOR, MAT_SURFACE } from '../world/Materials';
import { makeRayHit } from '../destruction/VoxelGrid';
import { VoxelBody } from '../destruction/VoxelBody';
import type { DamageCause } from '../destruction/DamageSystem';
import type { ChallengeDef, WeaponId } from './challenges';
import { BlowtorchWeapon, ChargeWeapon, HammerWeapon, PistolWeapon, RocketWeapon, ShotgunWeapon, type Weapon } from './Weapons';

export interface Hit {
  kind: 'world' | 'body';
  point: THREE.Vector3;
  normal: THREE.Vector3;
  dist: number;
  /** Material id (world) or dominant material (body). */
  mat: number;
  body: VoxelBody | null;
}

export interface WeaponInput {
  primary: boolean;
  primaryPressed: boolean;
  secondary: boolean;
  secondaryPressed: boolean;
  reloadPressed: boolean;
}

interface Tracer {
  mesh: THREE.Mesh;
  life: number;
}

const voxelHit = makeRayHit();
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class WeaponManager {
  readonly weapons: Weapon[];
  index = 1;
  private previous = 0;
  /** 0 = holstered, 1 = ready. */
  private equip = 0;
  private pending = -1;
  /** View-model root (camera space). */
  readonly rig = new THREE.Group();
  private readonly swayPos = new THREE.Vector2();
  private bob = 0;
  /** 0..1 aiming down sights. */
  ads = 0;
  /** Decaying inaccuracy from firing. */
  bloom = 0;
  private readonly tracers: Tracer[] = [];
  private readonly hit: Hit = { kind: 'world', point: new THREE.Vector3(), normal: new THREE.Vector3(), dist: 0, mat: 0, body: null };
  /** Explosives spent this run (charges detonated + rockets fired). */
  explosivesUsed = 0;
  private hudAmmoKey = '';
  /** True while tools are disabled (carrying an object, driving). */
  suppressed = false;

  constructor(readonly ctx: GameContext) {
    this.weapons = [new HammerWeapon(this), new PistolWeapon(this), new ShotgunWeapon(this), new ChargeWeapon(this), new RocketWeapon(this), new BlowtorchWeapon(this)];
    for (const w of this.weapons) {
      w.view.visible = false;
      this.rig.add(w.view);
    }
    ctx.renderer.viewScene.add(this.rig);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 10; i++) {
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      mesh.visible = false;
      mesh.frustumCulled = false;
      ctx.renderer.scene.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }
    ctx.hud.setWeapons(this.weapons.map((w, i) => ({ id: w.id, name: w.name, key: i + 1 })));
  }

  get current(): Weapon {
    return this.weapons[this.index];
  }

  byId<T extends Weapon>(id: WeaponId): T {
    return this.weapons.find((w) => w.id === id) as T;
  }

  /** True when ammunition should not be consumed. */
  get unlimited(): boolean {
    return this.ctx.mode === 'sandbox' && settings.get('unlimitedAmmo');
  }

  /** Reset all tools for a new run. */
  reset(challenge: ChallengeDef | null): void {
    for (const w of this.weapons) w.reset(challenge ? challenge.loadout : null);
    this.explosivesUsed = 0;
    this.index = 1;
    this.previous = 0;
    this.pending = -1;
    this.equip = 0;
    this.ads = 0;
    for (const w of this.weapons) w.view.visible = false;
    this.current.view.visible = true;
    this.ctx.hud.selectWeapon(this.index);
    this.hudAmmoKey = '';
  }

  select(i: number): void {
    if (i < 0 || i >= this.weapons.length || i === this.index || i === this.pending) return;
    this.pending = i;
    this.ctx.audio.weapon('switch');
    this.ctx.hud.selectWeapon(i);
  }

  // -------------------------------------------------------------------------
  // shared combat helpers
  // -------------------------------------------------------------------------
  /** Nearest thing along a ray: static voxels or a rigid body. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, skipMask = 0): Hit | null {
    const { grid, physics, player } = this.ctx;
    const h = this.hit;
    let found = false;
    let best = maxDist;
    if (grid.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist, skipMask, voxelHit)) {
      found = true;
      best = voxelHit.dist;
      h.kind = 'world';
      h.dist = voxelHit.dist;
      h.mat = voxelHit.mat;
      h.body = null;
      h.normal.set(voxelHit.nx, voxelHit.ny, voxelHit.nz);
      h.point.copy(origin).addScaledVector(dir, voxelHit.dist);
    }
    const r = physics.castRayBodies(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, best, player.ignore?.rb ?? null);
    if (r) {
      const body = r.collider.parent()?.userData;
      if (body instanceof VoxelBody && body.alive) {
        found = true;
        h.kind = 'body';
        h.dist = r.timeOfImpact;
        h.mat = body.dominant;
        h.body = body;
        h.normal.set(r.normal.x, r.normal.y, r.normal.z);
        h.point.copy(origin).addScaledVector(dir, r.timeOfImpact);
      }
    }
    return found ? h : null;
  }

  /**
   * Apply a hit: destroy voxels, push bodies, and play the material's impact feedback.
   * Returns the number of voxels destroyed.
   */
  impact(hit: Hit, dir: THREE.Vector3, radius: number, power: number, cause: DamageCause, impulse: number, loud = 1): number {
    const { damage, debris, particles, audio } = this.ctx;
    const p = hit.point;
    let removed = 0;
    let mat = hit.mat;
    if (hit.kind === 'world') {
      removed = damage.sphere(p.x - hit.normal.x * 0.08, p.y - hit.normal.y * 0.08, p.z - hit.normal.z * 0.08, radius, power, cause, dir);
      if (removed && damage.lastMat) mat = damage.lastMat;
    } else if (hit.body) {
      const b = hit.body;
      removed = debris.damageBody(b, p.x - hit.normal.x * 0.06, p.y - hit.normal.y * 0.06, p.z - hit.normal.z * 0.06, radius, power);
      if (b.alive) {
        if (b.joint && impulse > 900) debris.releaseDoor(b);
        // light objects must not be launched into orbit by a bullet
        const j = Math.min(impulse, b.mass * (cause === 'melee' ? 11 : 4.5));
        b.rb.applyImpulseAtPoint({ x: dir.x * j, y: dir.y * j + j * 0.08, z: dir.z * j }, p, true);
      }
    }
    const surface = MAT_SURFACE[mat];
    const r = MAT_COLOR[mat * 3], g = MAT_COLOR[mat * 3 + 1], b = MAT_COLOR[mat * 3 + 2];
    particles.puff(p.x, p.y, p.z, hit.normal.x, hit.normal.y, hit.normal.z, r, g, b, cause === 'melee' ? 5 : 3, cause === 'melee' ? 0.4 : 0.24);
    if (surface === 'metal') particles.sparks(p.x, p.y, p.z, hit.normal.x, hit.normal.y, hit.normal.z, removed ? 6 : 10, 5);
    if (loud > 0) audio.impact(surface, clamp((power / 160) * loud, 0.15, 1.3), { pos: p });
    if (removed > 0) this.ctx.hud.hitMarker(clamp(removed / 12, 0.25, 1));
    return removed;
  }

  /** Short additive streak from the muzzle to the impact point. */
  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const t = this.tracers.find((x) => x.life <= 0);
    if (!t) return;
    const len = from.distanceTo(to);
    if (len < 1.5) return;
    t.mesh.position.copy(from).lerp(to, 0.5);
    t.mesh.scale.set(0.018, 0.018, len);
    t.mesh.lookAt(to);
    t.mesh.visible = true;
    t.life = 0.07;
  }

  /** World-space position of a point in front of the camera (view-model offsets are approximate). */
  muzzleWorld(right: number, up: number, forward: number, out: THREE.Vector3): THREE.Vector3 {
    const cam = this.ctx.camera.camera;
    // the view model is drawn with its own narrower FOV: rescale so the point lines up on screen
    const k = Math.tan((cam.fov * Math.PI) / 360) / Math.tan((this.ctx.renderer.viewCamera.fov * Math.PI) / 360);
    return out.set(right * k, up * k, -forward).applyQuaternion(cam.quaternion).add(cam.position);
  }

  /** Ray direction with angular spread (radians). */
  aimDir(spread: number, out: THREE.Vector3): THREE.Vector3 {
    const cam = this.ctx.camera.camera;
    out.set(0, 0, -1).applyQuaternion(cam.quaternion);
    if (spread > 0) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread;
      tmp.crossVectors(out, UP).normalize();
      tmp2.crossVectors(tmp, out);
      out.addScaledVector(tmp, Math.cos(a) * r).addScaledVector(tmp2, Math.sin(a) * r).normalize();
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // per-frame
  // -------------------------------------------------------------------------
  update(dt: number): void {
    const { input, camera, hud, player } = this.ctx;
    const active = input.active && !this.suppressed;

    if (input.active && !this.suppressed) {
      for (let i = 0; i < 6; i++) if (input.wasPressed(`Digit${i + 1}`)) this.select(i);
      if (input.wheel !== 0) this.select((this.index + Math.sign(input.wheel) + this.weapons.length) % this.weapons.length);
      if (input.wasPressed('KeyQ')) this.select(this.previous);
    }
    // holster → swap → raise
    const lowering = this.pending >= 0 || this.suppressed;
    this.equip = clamp(this.equip + (lowering ? -dt * 6.5 : dt * 5.5), 0, 1);
    if (this.pending >= 0 && this.equip <= 0) {
      this.current.onHolster();
      this.current.view.visible = false;
      this.previous = this.index;
      this.index = this.pending;
      this.pending = -1;
      this.current.view.visible = true;
      this.current.onEquip();
      this.hudAmmoKey = '';
    }

    const w = this.current;
    const ready = this.equip >= 0.95 && this.pending < 0 && active;
    const io: WeaponInput = {
      primary: ready && input.buttonDown(0),
      primaryPressed: ready && input.buttonWasPressed(0),
      secondary: ready && input.buttonDown(2),
      secondaryPressed: ready && input.buttonWasPressed(2),
      reloadPressed: ready && input.wasPressed('KeyR'),
    };
    const wantAds = io.secondary && w.canAim;
    this.ads = damp(this.ads, wantAds ? 1 : 0, 14, dt);
    this.bloom = Math.max(0, this.bloom - dt * 2.4);
    w.update(dt, io);
    // background tools keep simulating their projectiles / placed charges
    for (const other of this.weapons) if (other !== w) other.updateIdle(dt);
    if (this.ads > 0.01) camera.fovTarget -= 14 * this.ads;

    // --- view-model rig motion
    const sx = clamp(-input.mouseDX * 0.00035, -0.03, 0.03);
    const sy = clamp(input.mouseDY * 0.00035, -0.03, 0.03);
    this.swayPos.x = damp(this.swayPos.x, sx, 9, dt);
    this.swayPos.y = damp(this.swayPos.y, sy, 9, dt);
    if (player.onGround && player.speed > 0.5) this.bob += dt * (5 + player.speed);
    const bobAmt = clamp(player.speed / 6, 0, 1) * (1 - this.ads * 0.8) * (player.onGround ? 1 : 0.2);
    const drop = (1 - this.equip) ** 2;
    this.rig.position.set(this.swayPos.x + Math.cos(this.bob) * 0.006 * bobAmt, this.swayPos.y - drop * 0.42 + Math.abs(Math.sin(this.bob)) * 0.008 * bobAmt - clamp(player.velocity.y, -6, 6) * 0.004, 0);
    this.rig.rotation.set(drop * 0.7 + this.swayPos.y * 1.6, this.swayPos.x * -2.2, this.swayPos.x * -1.4);

    // --- tracers
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, t.life / 0.07) * 0.8;
      if (t.life <= 0) t.mesh.visible = false;
    }

    // --- HUD
    hud.setCrosshair(this.suppressed ? 'dot' : w.crosshair, this.suppressed ? 0 : w.spreadPx() * (1 - this.ads * 0.6) + this.bloom * 26 + clamp(player.speed, 0, 8) * 0.9);
    const a = w.ammoHud();
    const key = `${this.index}|${a.mag}|${a.reserve}|${a.reloading}|${Math.round(a.reloadProgress * 20)}|${a.gauge === null ? '' : Math.round(a.gauge * 50)}|${a.detail}`;
    if (key !== this.hudAmmoKey) {
      this.hudAmmoKey = key;
      hud.setAmmo(a);
    }
  }
}
