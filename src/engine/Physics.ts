/**
 * Rapier world wrapper.
 *
 * The whole static district is ONE voxel collider;
 * when the destruction engine removes a voxel its neighbours are exposed with O(1)
 * `setVoxel` calls, so no collision mesh is ever rebuilt.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { MAT_COLLIDE, VOXEL } from '../world/Materials';
import { GRAVITY } from '../world/config';
import { MAT_MASK, type VoxelGrid } from '../destruction/VoxelGrid';

export { RAPIER };
export type RigidBody = RAPIER.RigidBody;
export type Collider = RAPIER.Collider;

export const G_WORLD = 0x0001;
export const G_BODY = 0x0002;
export const G_PLAYER = 0x0004;
/** Small cube "feet" that large debris uses against the world instead of its full shape. */
export const G_PROBE = 0x0008;
export const interactionGroups = (membership: number, filter: number): number => ((membership & 0xffff) << 16) | (filter & 0xffff);
export const GROUPS_WORLD = interactionGroups(G_WORLD, G_BODY | G_PLAYER | G_PROBE);
export const GROUPS_PROBE = interactionGroups(G_PROBE, G_WORLD);
/** A large body's own shape: collides with other bodies and the player, not with the world. */
export const GROUPS_BODY_ONLY = interactionGroups(G_BODY, G_BODY | G_PLAYER);
export const GROUPS_BODY = interactionGroups(G_BODY, G_WORLD | G_BODY | G_PLAYER);
export const GROUPS_PLAYER = interactionGroups(G_PLAYER, G_BODY);

export const FIXED_DT = 1 / 60;

export interface ImpactEvent {
  /** userData of the two rigid bodies involved (null for the static world). */
  a: unknown;
  b: unknown;
  colliderA: Collider;
  colliderB: Collider;
  /** Newtons (peak contact force this step). */
  force: number;
}

export class Physics {
  readonly world: RAPIER.World;
  readonly events: RAPIER.EventQueue;
  private worldBody: RAPIER.RigidBody;
  private worldCollider: RAPIER.Collider | null = null;
  private grid: VoxelGrid | null = null;
  private accumulator = 0;
  /** Smoothed duration of one fixed step in milliseconds. */
  stepMs = 0;
  readonly impacts: ImpactEvent[] = [];
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  private readonly tmpCenter = { x: 0, y: 0, z: 0 };
  private readonly tmpHalf = { x: 0, y: 0, z: 0 };

  /** The fixed body the static world hangs off (joint anchor for hinged doors). */
  get staticBody(): RAPIER.RigidBody {
    return this.worldBody;
  }

  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = FIXED_DT;
    this.world.numSolverIterations = 4;
    this.events = new RAPIER.EventQueue(true);
    this.worldBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  }

  /**
   * (Re)create the static voxel collider from a freshly generated grid. Every solid voxel
   * is inserted, not just the surface: the shape stores one state byte per cell of its
   * domain either way, buried voxels are skipped by the narrow phase as "interior", and
   * nothing can ever fall through a shell.
   */
  setWorld(grid: VoxelGrid): void {
    if (this.worldCollider) this.world.removeCollider(this.worldCollider, false);
    this.worldCollider = null;
    this.grid = grid;
    // The collider deliberately has no parent body and explicit (zero) mass properties:
    // otherwise every voxel edit makes Rapier re-integrate the mass of every voxel on the
    // next step, which costs ~100 ms per shot.
    const desc = RAPIER.ColliderDesc.voxels(grid.collectSolid(), { x: VOXEL, y: VOXEL, z: VOXEL })
      .setCollisionGroups(GROUPS_WORLD)
      .setFriction(0.85)
      .setRestitution(0.02)
      .setMassProperties(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    this.worldCollider = this.world.createCollider(desc);
    const collider = this.worldCollider;
    const { data, strideZ, strideY } = grid;
    grid.hooks = {
      removed: (x, y, z) => collider.setVoxel(x, y, z, false),
      added: (x, y, z) => {
        if (MAT_COLLIDE[data[x + strideZ * z + strideY * y] & MAT_MASK]) collider.setVoxel(x, y, z, true);
      },
    };
    // One warm-up step builds the broad-phase structures during loading instead of on the first shot.
    this.world.step(this.events);
    this.impacts.length = 0;
  }

  /**
   * Advance the simulation with a fixed timestep. At most `maxSteps` steps run per frame;
   * under heavy load the simulation slows down instead of spiralling.
   */
  step(dt: number, maxSteps: number, preStep?: (h: number) => void): number {
    this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * (maxSteps + 0.5));
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < maxSteps) {
      if (preStep) preStep(FIXED_DT);
      const t0 = performance.now();
      this.world.step(this.events);
      this.stepMs += (performance.now() - t0 - this.stepMs) * 0.1;
      this.accumulator -= FIXED_DT;
      steps++;
      this.events.drainContactForceEvents((ev) => {
        const c1 = this.world.getCollider(ev.collider1());
        const c2 = this.world.getCollider(ev.collider2());
        if (!c1 || !c2) return;
        this.impacts.push({ a: c1.parent()?.userData ?? null, b: c2.parent()?.userData ?? null, colliderA: c1, colliderB: c2, force: ev.maxForceMagnitude() });
      });
    }
    return steps;
  }

  /** World-space contact point between two colliders, if they are touching. */
  contactPoint(a: Collider, b: Collider, out: { x: number; y: number; z: number }): boolean {
    let found = false;
    this.world.contactPair(a, b, (manifold) => {
      if (found) return;
      const n = manifold.numSolverContacts();
      if (n > 0) {
        const p = manifold.solverContactPoint(0);
        if (p) {
          out.x = p.x;
          out.y = p.y;
          out.z = p.z;
          found = true;
        }
      }
    });
    return found;
  }

  /** Nearest dynamic/kinematic body along a ray (the static world is handled by the voxel DDA). */
  castRayBodies(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, exclude?: RigidBody | null): RAPIER.RayColliderIntersection | null {
    const r = this.ray;
    r.origin.x = ox;
    r.origin.y = oy;
    r.origin.z = oz;
    r.dir.x = dx;
    r.dir.y = dy;
    r.dir.z = dz;
    return this.world.castRayAndGetNormal(r, maxDist, true, RAPIER.QueryFilterFlags.EXCLUDE_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, interactionGroups(0xffff, G_BODY), undefined, exclude ?? undefined);
  }

  /** Invoke `cb` once per rigid body whose colliders overlap the given world-space box. */
  forEachBodyInBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, cb: (body: RigidBody) => void): void {
    const c = this.tmpCenter;
    const h = this.tmpHalf;
    c.x = (minX + maxX) / 2;
    c.y = (minY + maxY) / 2;
    c.z = (minZ + maxZ) / 2;
    h.x = (maxX - minX) / 2;
    h.y = (maxY - minY) / 2;
    h.z = (maxZ - minZ) / 2;
    const seen = new Set<number>();
    this.world.collidersWithAabbIntersectingAabb(c, h, (collider) => {
      const body = collider.parent();
      if (body && !body.isFixed() && !seen.has(body.handle)) {
        seen.add(body.handle);
        cb(body);
      }
      return true;
    });
  }

  /** Wake sleeping bodies around a region whose support may have just been destroyed. */
  wakeRegion(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
    this.forEachBodyInBox(minX, minY, minZ, maxX, maxY, maxZ, (b) => {
      if (b.isSleeping()) b.wakeUp();
    });
  }

  /** Remove every rigid body except the static world (environment reset). */
  clearBodies(keep: (body: RigidBody) => boolean): void {
    const doomed: RigidBody[] = [];
    this.world.forEachRigidBody((b) => {
      if (b.handle !== this.worldBody.handle && !keep(b)) doomed.push(b);
    });
    for (const b of doomed) this.world.removeRigidBody(b);
    this.impacts.length = 0;
  }
}
