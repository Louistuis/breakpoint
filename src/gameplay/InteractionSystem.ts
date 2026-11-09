/**
 * The E key: pick up, carry and throw loose objects, shove doors, climb into vehicles.
 * Carried objects stay fully simulated (they are steered by velocity, not teleported),
 * so they knock things over and cannot be pushed through walls.
 */
import * as THREE from 'three';
import type { GameContext } from '../engine/Context';
import { clamp } from '../utils/math';
import type { VoxelBody } from '../destruction/VoxelBody';
import { VehicleDriver } from '../world/Vehicles';

const REACH = 3;
const MAX_CARRY_KG = 140;
const MAX_CARRY_RADIUS = 1.7;

const vDir = new THREE.Vector3();
const vTarget = new THREE.Vector3();
const vC = new THREE.Vector3();

export class InteractionSystem {
  held: VoxelBody | null = null;
  readonly driver: VehicleDriver;
  /** Short lock-out so the click that throws an object does not also fire the tool. */
  private lockout = 0;
  private promptKey = '';

  constructor(private readonly ctx: GameContext) {
    this.driver = new VehicleDriver(ctx);
  }

  /** True while the player's hands are not free for tools. */
  get busy(): boolean {
    return this.held !== null || this.driver.active || this.lockout > 0;
  }

  reset(): void {
    this.held = null;
    this.lockout = 0;
    this.driver.reset();
    this.prompt('', '');
  }

  private prompt(key: string, text: string): void {
    const k = key + text;
    if (k === this.promptKey) return;
    this.promptKey = k;
    this.ctx.hud.setPrompt(text ? { key, text } : null);
  }

  private grab(b: VoxelBody): void {
    this.held = b;
    b.held = true;
    b.still = 0;
    b.rb.wakeUp();
    this.ctx.player.ignore = b;
    this.ctx.audio.weapon('grab');
  }

  private release(throwIt: boolean): void {
    const b = this.held;
    if (!b) return;
    const { player, camera, audio } = this.ctx;
    this.held = null;
    b.held = false;
    player.ignore = null;
    this.lockout = 0.3;
    if (!b.alive) return;
    if (throwIt) {
      camera.forward(vDir);
      const speed = clamp(17 * Math.pow(25 / b.mass, 0.35), 5, 17);
      b.rb.setLinvel({ x: vDir.x * speed + player.velocity.x * 0.5, y: vDir.y * speed + 1.2, z: vDir.z * speed + player.velocity.z * 0.5 }, true);
      b.rb.setAngvel({ x: (Math.random() - 0.5) * 5, y: (Math.random() - 0.5) * 5, z: (Math.random() - 0.5) * 5 }, true);
      audio.weapon('throw');
      camera.kick(-0.03, 0);
    }
  }

  /** Steer the carried object towards the hold point. Called once per fixed physics step. */
  preStep(h: number): void {
    this.driver.preStep(h);
    const b = this.held;
    if (!b || !b.alive) return;
    const { player, camera, debris, grid } = this.ctx;
    camera.forward(vDir);
    let reach = 1.2 + b.radius;
    // keep the hold point on this side of walls
    if (grid.boxCollides(player.eye.x + vDir.x * reach - 0.05, player.eye.y + vDir.y * reach - 0.05, player.eye.z + vDir.z * reach - 0.05, player.eye.x + vDir.x * reach + 0.05, player.eye.y + vDir.y * reach + 0.05, player.eye.z + vDir.z * reach + 0.05)) reach *= 0.6;
    vTarget.copy(player.eye).addScaledVector(vDir, reach);
    vTarget.y -= 0.15;
    const c = debris.center(b, vC);
    const ex = vTarget.x - c.x, ey = vTarget.y - c.y, ez = vTarget.z - c.z;
    const dist = Math.hypot(ex, ey, ez);
    if (dist > 3.4) {
      this.release(false);
      return;
    }
    const gain = Math.min(14, 13 / Math.max(dist, 1e-3));
    b.rb.setLinvel({ x: ex * gain * Math.min(1, dist), y: ey * gain * Math.min(1, dist), z: ez * gain * Math.min(1, dist) }, true);
    const av = b.rb.angvel();
    b.rb.setAngvel({ x: av.x * 0.8, y: av.y * 0.8, z: av.z * 0.8 }, true);
  }

  update(dt: number): void {
    const { input, camera, weapons } = this.ctx;
    this.lockout = Math.max(0, this.lockout - dt);
    if (this.driver.active) {
      this.driver.update(dt);
      if (this.driver.active) this.prompt('E', 'Leave vehicle');
      else this.lockout = 0.3;
      return;
    }
    if (!input.active) {
      this.prompt('', '');
      return;
    }
    const held = this.held;
    if (held) {
      if (!held.alive) this.release(false);
      else if (input.buttonWasPressed(0)) this.release(true);
      else if (input.wasPressed('KeyE') || input.buttonWasPressed(2)) this.release(false);
      else this.prompt('LMB', 'Throw  ·  E drop');
      return;
    }
    camera.forward(vDir);
    const hit = weapons.raycast(camera.camera.position, vDir, REACH);
    const b = hit?.body ?? null;
    const use = input.wasPressed('KeyE');
    if (!b) {
      this.prompt('', '');
    } else if (b.kind === 'vehicle') {
      this.prompt('E', `Drive ${b.name}`);
      if (use || input.wasPressed('KeyF')) this.driver.enter(b);
    } else if (b.kind === 'door') {
      this.prompt('E', 'Push door');
      if (use && hit) {
        const j = b.mass * 3.2;
        b.rb.applyImpulseAtPoint({ x: vDir.x * j, y: 0, z: vDir.z * j }, hit.point, true);
        this.ctx.audio.impact('wood', 0.35, { pos: hit.point });
      }
    } else if (b.mass <= MAX_CARRY_KG && b.radius <= MAX_CARRY_RADIUS && !b.joint) {
      this.prompt('E', `Pick up ${b.name}`);
      if (use) this.grab(b);
    } else {
      this.prompt('', `Too heavy to lift (${Math.round(b.mass)} kg)`);
    }
  }
}
