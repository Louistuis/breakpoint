/**
 * Arcade driving for voxel vehicles. A vehicle is an ordinary destructible rigid body;
 * while someone is at the wheel its contact friction is dropped and traction, grip and
 * steering are applied as impulses, so it still rams, breaks and gets broken like any
 * other object.
 */
import * as THREE from 'three';
import type { LoopHandle } from '../audio/types';
import type { GameContext } from '../engine/Context';
import { clamp } from '../utils/math';
import { makeRayHit } from '../destruction/VoxelGrid';
import type { VoxelBody } from '../destruction/VoxelBody';
import { VOXEL } from './Materials';

const MAX_FORWARD = 14;
const MAX_REVERSE = 5.5;
const ACCEL = 12;
const BRAKE = 22;
const GRIP = 0.3;
const STEER = 1.9;
const CAMERA_DISTANCE = 6.5;

const hit = makeRayHit();
const q = new THREE.Quaternion();
const vF = new THREE.Vector3();
const vUp = new THREE.Vector3();
const vC = new THREE.Vector3();
const vLook = new THREE.Vector3();

export class VehicleDriver {
  body: VoxelBody | null = null;
  /** Signed speed along the vehicle's nose (m/s). */
  speed = 0;
  private sound: LoopHandle | null = null;
  private hadFuel = false;
  private distance = CAMERA_DISTANCE;
  private hop = 0;

  constructor(private readonly ctx: GameContext) {}

  get active(): boolean {
    return this.body !== null;
  }

  /** Flattened world-space nose direction. Returns false when the vehicle points straight up or down. */
  private heading(b: VoxelBody, out: THREE.Vector3): boolean {
    const r = b.rb.rotation();
    q.set(r.x, r.y, r.z, r.w);
    out.set(b.frontX, 0, b.frontZ).applyQuaternion(q);
    out.y = 0;
    if (out.lengthSq() < 1e-4) return false;
    out.normalize();
    return true;
  }

  enter(body: VoxelBody): void {
    const { player, camera, debris, audio } = this.ctx;
    this.body = body;
    debris.setDriven(body, true);
    player.setSeated(true);
    player.ignore = body;
    this.hadFuel = !!body.explosive;
    this.distance = CAMERA_DISTANCE;
    if (this.heading(body, vF)) camera.yaw = Math.atan2(-vF.x, -vF.z);
    camera.pitch = -0.3;
    this.sound = audio.loop('engine', { pos: debris.center(body, vC), gain: 0.6 });
    audio.weapon('grab');
  }

  /** Leave the vehicle and stand next to it. */
  exit(): void {
    const b = this.body;
    if (!b) return;
    const { player, debris, grid, camera } = this.ctx;
    this.body = null;
    this.sound?.stop(0.3);
    this.sound = null;
    player.ignore = null;
    player.setSeated(false);
    if (b.alive) debris.setDriven(b, false);
    const c = b.alive ? debris.center(b, vC) : vC.copy(player.position);
    const halfH = (b.sy * VOXEL) / 2;
    const side = (Math.min(b.sx, b.sz) * VOXEL) / 2 + 0.75;
    const along = (Math.max(b.sx, b.sz) * VOXEL) / 2 + 0.75;
    const ok = b.alive && this.heading(b, vF);
    const fx = ok ? vF.x : 1, fz = ok ? vF.z : 0;
    // left door, right door, behind, in front
    const spots: [number, number][] = [[fz * side, -fx * side], [-fz * side, fx * side], [-fx * along, -fz * along], [fx * along, fz * along]];
    for (const [ox, oz] of spots) {
      const x = c.x + ox, z = c.z + oz;
      if (!grid.raycast(x, c.y + 1.2, z, 0, -1, 0, 4.5, 0, hit)) continue;
      const y = c.y + 1.2 - hit.dist + 0.02;
      if (grid.boxCollides(x - 0.3, y + 0.05, z - 0.3, x + 0.3, y + 1.8, z + 0.3)) continue;
      player.teleport(x, y, z);
      camera.pitch = 0;
      return;
    }
    player.teleport(c.x, c.y + halfH + 0.15, c.z);
    camera.pitch = 0;
  }

  /** Drop all driving state without moving the player (environment reset). */
  reset(): void {
    this.sound?.stop(0);
    this.sound = null;
    this.body = null;
    this.speed = 0;
  }

  /** Apply drive forces. Called once per fixed physics step. */
  preStep(h: number): void {
    const b = this.body;
    if (!b || !b.alive) return;
    const { input, debris, grid } = this.ctx;
    const rb = b.rb;
    if (!this.heading(b, vF)) return;
    vUp.set(0, 1, 0).applyQuaternion(q);
    const rx = -vF.z, rz = vF.x;
    const v = rb.linvel();
    const vf = v.x * vF.x + v.z * vF.z;
    const vs = v.x * rx + v.z * rz;
    this.speed = vf;
    const on = input.active;
    const throttle = on ? (input.down('KeyW') || input.down('ArrowUp') ? 1 : 0) - (input.down('KeyS') || input.down('ArrowDown') ? 1 : 0) : 0;
    const steer = on ? (input.down('KeyD') || input.down('ArrowRight') ? 1 : 0) - (input.down('KeyA') || input.down('ArrowLeft') ? 1 : 0) : 0;
    const handbrake = on && input.down('Space');
    const c = debris.center(b, vC);
    const halfH = (b.sy * VOXEL) / 2;
    const grounded = vUp.y > 0.55 && grid.raycast(c.x, c.y, c.z, 0, -1, 0, halfH + 0.4, 0, hit);
    if (!grounded) return;
    if (rb.isSleeping()) {
      if (throttle === 0 && steer === 0) return;
      rb.wakeUp();
    }
    let dvf: number;
    if (handbrake) dvf = -vf * clamp(7 * h, 0, 1);
    else if (throttle > 0) dvf = vf < MAX_FORWARD ? (vf < -0.5 ? BRAKE : ACCEL) * h : 0;
    else if (throttle < 0) dvf = vf > -MAX_REVERSE ? -(vf > 0.5 ? BRAKE : ACCEL * 0.7) * h : 0;
    else dvf = -vf * clamp(1.4 * h, 0, 1);
    const dvs = -vs * (handbrake ? 0.06 : GRIP);
    const m = rb.mass();
    rb.applyImpulse({ x: (vF.x * dvf + rx * dvs) * m, y: 0, z: (vF.z * dvf + rz * dvs) * m }, true);
    const av = rb.angvel();
    const target = -steer * STEER * clamp(vf / 5, -1, 1);
    rb.setAngvel({ x: av.x * 0.9, y: av.y + (target - av.y) * 0.22, z: av.z * 0.9 }, true);

    // kerbs and low rubble: hop over anything knee-high that blocks the bumper
    this.hop -= h;
    if (throttle !== 0 && this.hop <= 0 && Math.abs(vf) < 4) {
      const reach = (Math.max(b.sx, b.sz) * VOXEL) / 2 + 0.3;
      const px = c.x + vF.x * reach * throttle, pz = c.z + vF.z * reach * throttle;
      const bottom = c.y - halfH;
      if (grid.solidAt(px, bottom + 0.12, pz) && !grid.solidAt(px, bottom + 0.62, pz)) {
        this.hop = 0.45;
        rb.applyImpulse({ x: 0, y: m * 2.7, z: 0 }, true);
      }
    }
  }

  /** Camera, engine note and bail-out. Called once per frame. */
  update(dt: number): void {
    const b = this.body;
    if (!b) return;
    const { input, player, camera, debris, grid } = this.ctx;
    if (!b.alive || b.kind !== 'vehicle' || (this.hadFuel && !b.explosive) || input.wasPressed('KeyE') || input.wasPressed('KeyF')) {
      this.exit();
      return;
    }
    const c = debris.center(b, vC);
    const halfH = (b.sy * VOXEL) / 2;
    player.position.set(c.x, c.y - halfH, c.z);
    // orbit camera: the mouse looks around, the vehicle stays in frame
    camera.pitch = clamp(camera.pitch, -1.2, 0.35);
    camera.forward(vLook);
    const px = c.x, py = c.y + 0.9, pz = c.z;
    let d = CAMERA_DISTANCE;
    if (grid.raycast(px, py, pz, -vLook.x, -vLook.y, -vLook.z, CAMERA_DISTANCE + 0.4, 0, hit)) d = Math.max(1.2, hit.dist - 0.4);
    this.distance = d < this.distance ? d : this.distance + (d - this.distance) * Math.min(1, dt * 5);
    player.eye.set(px - vLook.x * this.distance, py - vLook.y * this.distance, pz - vLook.z * this.distance);
    if (this.sound) {
      this.sound.setPos(c);
      this.sound.setPitch(0.75 + Math.min(1.2, Math.abs(this.speed) / 11));
      this.sound.setGain(0.5 + Math.min(0.5, Math.abs(this.speed) / 20), 0.1);
    }
  }
}
