/**
 * A free rigid body made of voxels: detached structure, a fracture fragment, a prop,
 * a vehicle or a hinged door. Owns a small voxel grid, its render meshes and a Rapier
 * rigid body whose colliders approximate the voxels with a handful of primitives.
 */
import * as THREE from 'three';
import type { RigidBody } from '../engine/Physics';
import type { ExplosiveSpec } from '../world/Props';

export type BodyKind = 'debris' | 'prop' | 'vehicle' | 'door';

export class VoxelBody {
  private static nextId = 1;
  readonly id = VoxelBody.nextId++;
  kind: BodyKind = 'debris';
  name = 'debris';
  /** Solid voxels. */
  count = 0;
  /** kg (already includes massScale). */
  mass = 1;
  massScale = 1;
  /** Most common material id. */
  dominant = 0;
  rb!: RigidBody;
  /** Scene node; local units are voxels. */
  readonly group = new THREE.Group();
  opaque: THREE.Mesh | null = null;
  glass: THREE.Mesh | null = null;
  /** Texture phase so the surface pattern does not jump when a piece detaches. */
  texOff: [number, number, number] = [0, 0, 0];
  /** How many times this lineage has already fractured. */
  generation = 0;
  age = 0;
  /** Seconds spent nearly motionless. */
  still = 0;
  /** Settling: heavily damped until it moves again, so the solver can put it to sleep. */
  calm = false;
  explosive: ExplosiveSpec | null = null;
  explosiveHp = 0;
  /** Seconds until detonation once triggered; negative = not armed. */
  fuse = -1;
  /** Voxels changed: mesh/colliders must be rebuilt (and the body possibly split). */
  dirty = false;
  alive = true;
  held = false;
  driven = false;
  /** Bounding radius in metres. */
  radius = 0.5;
  /** Linear velocity before the current physics step (for break-through impacts). */
  pvx = 0;
  pvy = 0;
  pvz = 0;
  /** False for hinged doors, which must swing through their own frame. */
  worldCollide = true;
  joint: unknown = null;
  /** Grid index of the jamb voxel a door hangs from (-1 = none). */
  hingeVoxel = -1;
  fractureCooldown = 0;
  /** Vehicles: horizontal unit vector (body-local) pointing out of the bonnet. */
  frontX = -1;
  frontZ = 0;

  constructor(public vox: Uint8Array, public sx: number, public sy: number, public sz: number) {}
}
