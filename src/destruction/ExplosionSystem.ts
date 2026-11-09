/**
 * Explosions: voxel damage, radial impulses on rigid bodies and fragments, chain
 * reactions through explosive props and fuel installations, plus the light, smoke,
 * shockwave, camera shake and layered audio that sell the blast.
 */
import * as THREE from 'three';
import type { GameContext } from '../engine/Context';
import { clamp } from '../utils/math';
import { F_FLAMMABLE, MAT_FLAGS, VOXEL } from '../world/Materials';
import type { ExplosiveZone } from '../world/WorldGenerator';
import type { VoxelBody } from './VoxelBody';

export interface BlastSpec {
  /** Metres. */
  radius: number;
  /** Peak voxel damage at the centre. */
  power: number;
  /** Velocity change (m/s) given to a ~60 kg object at the centre. */
  push: number;
}

/** scale ≈ 0.4 gas cylinder · 0.5 fuel drum · 0.7 charge · 1.0 rocket · 1.25 fuel tank */
export function blastFromScale(scale: number): BlastSpec {
  return { radius: 1.5 + 2.4 * scale, power: 420 + 1500 * scale, push: 7 + 11 * scale };
}

interface Queued {
  x: number;
  y: number;
  z: number;
  scale: number;
  delay: number;
}

interface Recent {
  x: number;
  y: number;
  z: number;
  spec: BlastSpec;
  ttl: number;
}

interface Zone extends ExplosiveZone {
  alive: boolean;
  cx: number;
  cy: number;
  cz: number;
}

interface Wave {
  mesh: THREE.Mesh;
  life: number;
  radius: number;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

export class ExplosionSystem {
  private queue: Queued[] = [];
  private recent: Recent[] = [];
  private zones: Zone[] = [];
  private waves: Wave[] = [];
  /** Explosions since the last reset. */
  count = 0;
  /** Blasts already resolved during the current tick. */
  private firedThisTick = 0;
  /** Notified after every blast (planted charges use this to detonate sympathetically). */
  readonly listeners: ((x: number, y: number, z: number, radius: number) => void)[] = [];

  constructor(private readonly ctx: GameContext) {
    const geo = new THREE.SphereGeometry(1, 20, 12);
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffe2c0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide, fog: false }));
      mesh.visible = false;
      mesh.renderOrder = 7;
      ctx.renderer.scene.add(mesh);
      this.waves.push({ mesh, life: 0, radius: 1 });
    }
  }

  /** Register the static explosive installations of a freshly generated world. */
  reset(zones: ExplosiveZone[]): void {
    this.queue.length = 0;
    this.recent.length = 0;
    this.count = 0;
    this.firedThisTick = 0;
    this.zones = zones.map((z) => ({
      ...z,
      alive: true,
      cx: ((z.min[0] + z.max[0] + 1) / 2) * VOXEL,
      cy: ((z.min[1] + z.max[1] + 1) / 2) * VOXEL,
      cz: ((z.min[2] + z.max[2] + 1) / 2) * VOXEL,
    }));
    for (const w of this.waves) w.mesh.visible = false;
    this.ctx.debris.onBodyCreated = (b) => this.pushFresh(b);
  }

  /** Detonate after a delay (chain reactions never all fire in the same frame). */
  schedule(x: number, y: number, z: number, scale: number, delay: number): void {
    this.queue.push({ x, y, z, scale, delay });
  }

  /** A voxel of stored fuel was destroyed: the installation it belongs to goes up. */
  zoneVoxelDestroyed(x: number, y: number, z: number): void {
    for (const zone of this.zones) {
      if (!zone.alive) continue;
      if (x < zone.min[0] || x > zone.max[0] || y < zone.min[1] || y > zone.max[1] || z < zone.min[2] || z > zone.max[2]) continue;
      zone.alive = false;
      this.schedule(zone.cx, zone.cy, zone.cz, zone.power, 0.06 + Math.random() * 0.12);
    }
  }

  detonateBody(body: VoxelBody): void {
    if (!body.alive || !body.explosive) return;
    const c = this.ctx.debris.center(body, tmp).clone();
    const scale = body.explosive.power;
    body.explosive = null;
    if (body.kind === 'vehicle') {
      // a burning wreck stays behind
      this.explode(c.x, c.y, c.z, scale);
      return;
    }
    this.ctx.debris.removeBody(body);
    this.explode(c.x, c.y, c.z, scale);
  }

  /**
   * Detonate now. A blast is the most expensive single event in the game (thousands of
   * voxels, a structural check, new rigid bodies), so only one resolves per tick: any
   * further ones asked for in the same tick go off on the following frames, which reads
   * as a ripple rather than a freeze.
   */
  explode(x: number, y: number, z: number, scale: number): void {
    if (this.firedThisTick > 0) {
      this.queue.push({ x, y, z, scale, delay: 0 });
      return;
    }
    this.firedThisTick++;
    const { damage, debris, particles, audio, renderer, camera, player, hud, fire, perf, grid } = this.ctx;
    const spec = blastFromScale(scale);
    const R = spec.radius;
    this.count++;
    tmp.set(x, y, z);
    perf.noteDestruction(clamp(scale, 0.3, 1));

    // --- presentation
    particles.explosion(x, y, z, R * 0.42);
    renderer.flash(tmp, 0xffa648, 220 * scale + 60, R * 7, 0.55);
    renderer.shockwave(tmp, R * 3.2);
    audio.explosion(tmp, scale);
    camera.shakeFrom(tmp, 0.55 + scale * 0.75, 38 + R * 9);
    const wave = this.waves.find((w) => w.life <= 0) ?? this.waves[0];
    wave.mesh.position.set(x, y, z);
    wave.mesh.visible = true;
    wave.life = 0.28;
    wave.radius = R * 1.9;
    const pd = player.eye.distanceTo(tmp);
    if (pd < R * 5) hud.flash(clamp(1.1 - pd / (R * 5), 0, 1) * clamp(scale + 0.3, 0, 1));

    // --- static world
    damage.sphere(x, y, z, R, spec.power, 'explosion');

    // --- rigid bodies: damage, shove, chain
    debris.forEachNear(x, y, z, R * 1.9, (b, d) => {
      if (!b.alive) return;
      if (d < R * 1.2 + b.radius) debris.damageBody(b, x, y, z, R, spec.power * 0.55);
      if (b.explosive && d < R * 1.5 + b.radius && b.fuse < 0) b.fuse = 0.08 + Math.random() * 0.22 + d * 0.02;
      this.push(b, x, y, z, spec, 1);
    });
    debris.light.impulse(x, y, z, R * 2.2, spec.push * 1.1);
    player.applyBlast(tmp, R * 2.1, spec.push);

    // --- fuel installations caught in the blast
    for (const zone of this.zones) {
      if (!zone.alive) continue;
      const d = Math.hypot(zone.cx - x, zone.cy - y, zone.cz - z);
      if (d < R * 0.95) {
        zone.alive = false;
        this.schedule(zone.cx, zone.cy, zone.cz, zone.power, 0.1 + Math.random() * 0.2);
      }
    }

    // --- set fire to whatever flammable material survived at the rim
    const tries = Math.round(26 * clamp(scale, 0.4, 1.3));
    for (let k = 0; k < tries; k++) {
      const a = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const s = Math.sqrt(1 - u * u);
      const rr = R * (0.55 + Math.random() * 0.6);
      const fx = x + Math.cos(a) * s * rr, fy = y + u * rr, fz = z + Math.sin(a) * s * rr;
      const m = grid.matAtWorld(fx, fy, fz);
      if (m && MAT_FLAGS[m] & F_FLAMMABLE) fire.igniteAt(fx, fy, fz);
    }
    this.recent.push({ x, y, z, spec, ttl: 0.35 });
    for (const l of this.listeners) l(x, y, z, R);
  }

  private push(b: VoxelBody, x: number, y: number, z: number, spec: BlastSpec, gain: number): void {
    const c = this.ctx.debris.center(b, tmp2);
    let dx = c.x - x, dy = c.y - y, dz = c.z - z;
    const d = Math.hypot(dx, dy, dz);
    const reach = spec.radius * 1.9 + b.radius;
    if (d > reach) return;
    const f = (1 - d / reach) ** 2;
    const inv = 1 / (d + 0.05);
    dx *= inv;
    dy = dy * inv * 0.8 + 0.35;
    dz *= inv;
    // light objects fly, heavy ones lurch
    const dv = spec.push * f * gain * clamp(Math.pow(60 / b.mass, 0.36), 0.12, 2.4);
    if (dv < 0.2) return;
    if (b.joint && dv > 3) this.ctx.debris.releaseDoor(b);
    const J = dv * b.mass;
    const off = b.radius * 0.35;
    b.rb.applyImpulseAtPoint({ x: dx * J, y: dy * J, z: dz * J }, { x: c.x - dx * off + (Math.random() - 0.5) * off, y: c.y - off * 0.5, z: c.z - dz * off + (Math.random() - 0.5) * off }, true);
  }

  /** Debris created a moment after a blast (by the structural solver) still gets thrown. */
  private pushFresh(b: VoxelBody): void {
    if (b.kind !== 'debris') return;
    for (const r of this.recent) this.push(b, r.x, r.y, r.z, r.spec, 0.7);
  }

  update(dt: number): void {
    for (const q of this.queue) q.delay -= dt;
    // oldest due blast first, one per tick
    if (this.firedThisTick === 0) {
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i];
        if (q.delay > 0) continue;
        this.queue.splice(i, 1);
        this.explode(q.x, q.y, q.z, q.scale);
        break;
      }
    }
    this.firedThisTick = 0;
    for (let i = this.recent.length - 1; i >= 0; i--) {
      this.recent[i].ttl -= dt;
      if (this.recent[i].ttl <= 0) this.recent.splice(i, 1);
    }
    for (const w of this.waves) {
      if (w.life <= 0) continue;
      w.life -= dt;
      const t = 1 - Math.max(0, w.life) / 0.28;
      w.mesh.scale.setScalar(0.3 + w.radius * t);
      (w.mesh.material as THREE.MeshBasicMaterial).opacity = 0.34 * (1 - t) * (1 - t);
      if (w.life <= 0) w.mesh.visible = false;
    }
  }
}
