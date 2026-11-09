/**
 * First-person character controller.
 *
 * The static world is resolved directly against the voxel grid (axis-separated sweeps
 * with step-up), which is exact, cheap and unaffected by geometry changing under the
 * player. Dynamic debris is handled by Rapier's character controller so loose objects
 * can be stood on, block the way when heavy and get shoved aside when light.
 */
import * as THREE from 'three';
import type { GameContext } from '../engine/Context';
import { GROUPS_PLAYER, RAPIER } from '../engine/Physics';
import { clamp, damp } from '../utils/math';
import { MAT_SURFACE, VOXEL } from '../world/Materials';
import { GRAVITY } from '../world/config';
import type { VoxelBody } from '../destruction/VoxelBody';

const HALF = 0.28;
const STAND = 1.8;
const CROUCH = 1.15;
const EYE_STAND = 1.64;
const EYE_CROUCH = 1.0;
const STEP = 0.44;
const WALK = 4.7;
const SPRINT = 7.4;
const SNEAK = 2.2;
const JUMP = 6.3;
const EPS = 1e-3;

const wish = new THREE.Vector3();
const delta = { x: 0, y: 0, z: 0 };

export class PlayerController {
  /** Feet position (centre of the footprint). */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly eye = new THREE.Vector3();
  onGround = false;
  crouching = false;
  sprinting = false;
  /** Horizontal speed in m/s. */
  speed = 0;
  /** -1..1 sideways input, for camera roll. */
  strafe = 0;
  /** Material id under the feet (0 in the air or on a rigid body). */
  groundMat = 0;
  /** Bodies the character controller must ignore (carried object, driven vehicle). */
  ignore: VoxelBody | null = null;
  /** Set while the player is driving; movement is suspended. */
  seated = false;
  private height = STAND;
  private eyeHeight = EYE_STAND;
  private coyote = 0;
  private jumpBuffer = 0;
  private stepDistance = 0;
  private airTime = 0;
  private readonly collider: RAPIER.Collider;
  private readonly kcc: RAPIER.KinematicCharacterController;
  private onBody = false;

  constructor(private readonly ctx: GameContext) {
    const world = ctx.physics.world;
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule((STAND - 2 * HALF) / 2, HALF).setCollisionGroups(GROUPS_PLAYER).setFriction(0));
    this.kcc = world.createCharacterController(0.03);
    this.kcc.setSlideEnabled(true);
    this.kcc.enableAutostep(0.45, 0.12, true);
    this.kcc.disableSnapToGround();
    this.kcc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((65 * Math.PI) / 180);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(85);
  }

  spawn(x: number, y: number, z: number, yaw: number): void {
    this.position.set(x, y + 0.02, z);
    this.velocity.set(0, 0, 0);
    this.crouching = false;
    this.height = STAND;
    this.eyeHeight = EYE_STAND;
    this.setSeated(false);
    this.ignore = null;
    this.ctx.camera.yaw = yaw;
    this.ctx.camera.pitch = 0;
    this.syncCollider();
    this.updateEye(0);
  }

  private collides(x: number, y: number, z: number, h = this.height): boolean {
    return this.ctx.grid.boxCollides(x - HALF, y, z - HALF, x + HALF, y + h, z + HALF);
  }

  /** Move along one axis by less than a voxel, snapping to the voxel face on contact. */
  private moveAxis(axis: 0 | 1 | 2, d: number): boolean {
    if (d === 0) return false;
    const p = this.position;
    const nx = p.x + (axis === 0 ? d : 0);
    const ny = p.y + (axis === 1 ? d : 0);
    const nz = p.z + (axis === 2 ? d : 0);
    if (!this.collides(nx, ny, nz)) {
      p.set(nx, ny, nz);
      return false;
    }
    if (axis === 1) {
      if (d < 0) p.y = (Math.floor(ny / VOXEL) + 1) * VOXEL + EPS;
      else p.y = Math.floor((ny + this.height) / VOXEL) * VOXEL - this.height - EPS;
    } else if (axis === 0) {
      if (d < 0) p.x = (Math.floor((nx - HALF) / VOXEL) + 1) * VOXEL + HALF + EPS;
      else p.x = Math.floor((nx + HALF) / VOXEL) * VOXEL - HALF - EPS;
    } else if (d < 0) p.z = (Math.floor((nz - HALF) / VOXEL) + 1) * VOXEL + HALF + EPS;
    else p.z = Math.floor((nz + HALF) / VOXEL) * VOXEL - HALF - EPS;
    return true;
  }

  /** Horizontal sub-step with automatic step-up over ledges up to STEP high. */
  private moveHorizontal(dx: number, dz: number): void {
    const p = this.position;
    const sx = p.x, sy = p.y, sz = p.z;
    const bx = this.moveAxis(0, dx);
    const bz = this.moveAxis(2, dz);
    if (!(bx || bz) || !(this.onGround || this.coyote > 0)) return;
    const ax = p.x, az = p.z;
    // try again from a raised position
    let raised = 0;
    p.set(sx, sy, sz);
    while (raised < STEP - 1e-6) {
      const inc = Math.min(0.11, STEP - raised);
      if (this.collides(p.x, p.y + inc, p.z)) break;
      p.y += inc;
      raised += inc;
    }
    if (raised < 0.05) {
      p.set(ax, sy, az);
      return;
    }
    this.moveAxis(0, dx);
    this.moveAxis(2, dz);
    let drop = raised + 0.02;
    while (drop > 0) {
      const inc = Math.min(0.15, drop);
      if (this.moveAxis(1, -inc)) break;
      drop -= inc;
    }
    const gained = (p.x - sx) ** 2 + (p.z - sz) ** 2 - ((ax - sx) ** 2 + (az - sz) ** 2);
    const climbed = p.y - sy;
    if (gained > 1e-6 && climbed > 0.01) {
      this.ctx.camera.stepOffset += climbed;
    } else {
      p.set(ax, sy, az);
    }
  }

  private syncCollider(): void {
    this.collider.setTranslation({ x: this.position.x, y: this.position.y + this.height / 2, z: this.position.z });
  }

  private updateEye(dt: number): void {
    const target = this.crouching ? EYE_CROUCH : EYE_STAND;
    this.eyeHeight = dt > 0 ? damp(this.eyeHeight, target, 14, dt) : target;
    this.eye.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** Sit in (or leave) a vehicle: the body stops colliding and moving on its own. */
  setSeated(seated: boolean): void {
    this.seated = seated;
    this.collider.setEnabled(!seated);
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.strafe = 0;
    this.sprinting = false;
    if (seated) this.onGround = false;
  }

  /** Knock-back from an explosion. */
  applyBlast(pos: THREE.Vector3, radius: number, push: number): void {
    if (this.seated) return;
    const cx = this.position.x - pos.x, cy = this.position.y + 0.9 - pos.y, cz = this.position.z - pos.z;
    const d = Math.hypot(cx, cy, cz);
    if (d > radius) return;
    const f = (1 - d / radius) ** 2 * push * 0.85;
    const inv = 1 / (d + 0.1);
    this.velocity.x += cx * inv * f;
    this.velocity.y += Math.max(0.2, cy * inv) * f * 0.7 + f * 0.15;
    this.velocity.z += cz * inv * f;
    this.onGround = false;
    this.coyote = 0;
  }

  update(dt: number): void {
    const { input, camera, grid, audio } = this.ctx;
    if (this.seated) {
      this.velocity.set(0, 0, 0);
      this.syncCollider();
      return;
    }
    const p = this.position;
    const v = this.velocity;

    // rubble may have been merged into the world on top of us: climb out
    if (this.collides(p.x, p.y, p.z)) {
      for (let up = 0.1; up <= 2.6; up += 0.1) {
        if (!this.collides(p.x, p.y + up, p.z)) {
          p.y += up;
          v.y = Math.max(v.y, 0);
          break;
        }
      }
    }

    // --- intent
    const f = (input.down('KeyW') || input.down('ArrowUp') ? 1 : 0) - (input.down('KeyS') || input.down('ArrowDown') ? 1 : 0);
    const s = (input.down('KeyD') || input.down('ArrowRight') ? 1 : 0) - (input.down('KeyA') || input.down('ArrowLeft') ? 1 : 0);
    this.strafe = s;
    const wantCrouch = input.down('ControlLeft') || input.down('KeyC');
    if (wantCrouch && !this.crouching) {
      this.crouching = true;
      this.height = CROUCH;
      this.collider.setHalfHeight((CROUCH - 2 * HALF) / 2);
    } else if (!wantCrouch && this.crouching && !this.collides(p.x, p.y, p.z, STAND)) {
      this.crouching = false;
      this.height = STAND;
      this.collider.setHalfHeight((STAND - 2 * HALF) / 2);
    }
    this.sprinting = input.down('ShiftLeft') && f > 0 && !this.crouching;
    const top = this.crouching ? SNEAK : this.sprinting ? SPRINT : WALK;
    const sin = Math.sin(camera.yaw), cos = Math.cos(camera.yaw);
    wish.set(-sin * f + cos * s, 0, -cos * f - sin * s);
    if (wish.lengthSq() > 0) wish.normalize();

    // --- horizontal velocity
    const grounded = this.onGround;
    const accel = grounded ? 58 : 13;
    const tx = wish.x * top, tz = wish.z * top;
    if (grounded || wish.lengthSq() > 0) {
      let dvx = tx - v.x, dvz = tz - v.z;
      if (!grounded) {
        // air control: steer, but do not brake momentum gained from blasts
        const along = v.x * wish.x + v.z * wish.z;
        if (along > top) {
          dvx = 0;
          dvz = 0;
        }
      }
      const dl = Math.hypot(dvx, dvz);
      const maxStep = accel * dt;
      if (dl > maxStep) {
        dvx *= maxStep / dl;
        dvz *= maxStep / dl;
      }
      v.x += dvx;
      v.z += dvz;
    }

    // --- jumping and gravity
    if (input.wasPressed('Space')) this.jumpBuffer = 0.12;
    this.jumpBuffer -= dt;
    this.coyote = grounded ? 0.1 : this.coyote - dt;
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      v.y = JUMP;
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.onGround = false;
      audio.footstep(this.surface(), 0.9);
    }
    v.y = Math.max(-45, v.y - GRAVITY * dt);

    // --- dynamic bodies first (Rapier character controller), then the voxel world
    delta.x = v.x * dt;
    delta.y = v.y * dt;
    delta.z = v.z * dt;
    this.syncCollider();
    const ignore = this.ignore?.rb.handle;
    this.kcc.computeColliderMovement(this.collider, delta, RAPIER.QueryFilterFlags.EXCLUDE_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS_PLAYER, ignore === undefined ? undefined : (c) => c.parent()?.handle !== ignore);
    const m = this.kcc.computedMovement();
    const bodyGround = this.kcc.computedGrounded() && v.y <= 0;
    if (Math.abs(m.x - delta.x) > 1e-5) v.x = m.x / dt;
    if (Math.abs(m.z - delta.z) > 1e-5) v.z = m.z / dt;
    if (bodyGround) v.y = 0;

    const fallSpeed = -v.y;
    const wasGround = this.onGround;
    const startX = p.x, startZ = p.z;
    const total = Math.max(Math.abs(m.x), Math.abs(m.y), Math.abs(m.z));
    const steps = Math.max(1, Math.ceil(total / 0.15));
    let hitFloor = false;
    for (let i = 0; i < steps; i++) {
      this.moveHorizontal(m.x / steps, m.z / steps);
      if (this.moveAxis(1, m.y / steps)) {
        if (m.y < 0) hitFloor = true;
        v.y = 0;
      }
    }
    // standing still on a ledge: probe just below the feet
    if (!hitFloor && v.y <= 0 && this.collides(p.x, p.y - 0.03, p.z)) hitFloor = true;
    this.onBody = bodyGround && !hitFloor;
    this.onGround = hitFloor || bodyGround;
    // walls stop horizontal velocity
    if (Math.abs(p.x - (startX + m.x)) > 0.02) v.x *= 0.5;
    if (Math.abs(p.z - (startZ + m.z)) > 0.02) v.z *= 0.5;

    // --- feedback
    this.speed = Math.hypot(v.x, v.z);
    if (this.onGround) {
      this.groundMat = this.onBody ? 0 : grid.matAtWorld(p.x, p.y - 0.06, p.z);
      if (!wasGround && this.airTime > 0.18) {
        const impact = clamp(fallSpeed / 14, 0.15, 1.3);
        camera.land(fallSpeed);
        audio.land(this.surface(), impact);
        this.stepDistance = 0;
      }
      this.airTime = 0;
      this.stepDistance += this.speed * dt;
      const stride = this.sprinting ? 2.6 : this.crouching ? 1.5 : 2.1;
      if (this.stepDistance > stride) {
        this.stepDistance = 0;
        audio.footstep(this.surface(), this.crouching ? 0.3 : this.sprinting ? 1 : 0.6);
      }
    } else {
      this.airTime += dt;
      this.groundMat = 0;
    }
    camera.fovTarget = this.sprinting && this.speed > WALK + 0.5 ? 5 : 0;
    this.syncCollider();
    this.updateEye(dt);
  }

  private surface() {
    return this.groundMat ? MAT_SURFACE[this.groundMat] : ('concrete' as const);
  }

  /** Place the player explicitly (vehicle exit, automated tests). */
  teleport(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.syncCollider();
    this.updateEye(0);
  }
}
