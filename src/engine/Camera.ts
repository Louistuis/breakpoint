/**
 * First-person camera rig: mouse look plus every bit of secondary motion (bob, landing
 * dip, strafe roll, recoil, trauma-based shake, sprint/aim FOV) kept in one place.
 */
import * as THREE from 'three';
import { clamp, damp } from '../utils/math';
import { settings } from '../utils/settings';

const fwd = new THREE.Vector3();

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = 0;
  /** 0..1, decays over time; shake amplitude is trauma². */
  trauma = 0;
  /** Added to the base FOV (negative while aiming, positive while sprinting). */
  fovTarget = 0;
  private fovOffset = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private dip = 0;
  private dipVel = 0;
  private roll = 0;
  private time = 0;
  /** Vertical offset that smooths stair/step climbing. */
  stepOffset = 0;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(settings.get('fov'), 1, 0.06, 1200);
    this.camera.rotation.order = 'YXZ';
  }

  look(dx: number, dy: number, scale = 1): void {
    const s = 0.0021 * settings.get('mouseSensitivity') * scale;
    this.yaw -= dx * s;
    this.pitch = clamp(this.pitch - dy * s, -1.54, 1.54);
  }

  /** Unit view direction (without shake/recoil offsets). */
  forward(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount * settings.get('cameraShake'));
  }

  /** Shake scaled by distance from an event. */
  shakeFrom(pos: { x: number; y: number; z: number }, amount: number, range: number): void {
    const p = this.camera.position;
    const d = Math.hypot(pos.x - p.x, pos.y - p.y, pos.z - p.z);
    if (d < range) this.shake(amount * (1 - d / range) ** 2);
  }

  /** Recoil: pitch up / yaw sideways in radians, recovers automatically. */
  kick(pitch: number, yaw: number): void {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
  }

  land(speed: number): void {
    this.dipVel -= Math.min(2.6, speed * 0.16);
  }

  update(dt: number, eye: THREE.Vector3, speed: number, onGround: boolean, strafe: number): void {
    this.time += dt;
    const cam = this.camera;
    // head bob follows distance travelled, not time
    const moving = onGround && speed > 0.6;
    this.bobAmp = damp(this.bobAmp, moving ? Math.min(1, speed / 5) : 0, 9, dt);
    if (moving) this.bobPhase += dt * (5.2 + speed * 0.95);
    const bobY = Math.sin(this.bobPhase * 2) * 0.028 * this.bobAmp;
    const bobX = Math.cos(this.bobPhase) * 0.02 * this.bobAmp;
    // landing spring
    this.dipVel += (-this.dip * 110 - this.dipVel * 13) * dt;
    this.dip += this.dipVel * dt;
    this.stepOffset = damp(this.stepOffset, 0, 14, dt);
    this.roll = damp(this.roll, -strafe * 0.014, 8, dt);
    this.recoilPitch = damp(this.recoilPitch, 0, 9, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, 9, dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.35);
    const s = this.trauma * this.trauma;
    const t = this.time;
    const shx = (Math.sin(t * 47.1) + Math.sin(t * 71.7 + 1.3)) * 0.5 * s;
    const shy = (Math.sin(t * 53.3 + 2.1) + Math.sin(t * 83.9)) * 0.5 * s;
    const shz = (Math.sin(t * 61.7 + 0.7) + Math.sin(t * 97.3 + 4.1)) * 0.5 * s;

    cam.rotation.set(this.pitch + this.recoilPitch + shx * 0.045, this.yaw + this.recoilYaw + shy * 0.045, this.roll + shz * 0.03);
    cam.position.copy(eye);
    cam.position.y += bobY + this.dip * 0.12 - this.stepOffset;
    this.forward(fwd);
    cam.position.x += Math.cos(this.yaw) * bobX + shy * 0.05;
    cam.position.z += -Math.sin(this.yaw) * bobX + shx * 0.05;

    this.fovOffset = damp(this.fovOffset, this.fovTarget, 10, dt);
    const fov = settings.get('fov') + this.fovOffset;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }
}
