import { VOXEL } from './Materials';
import { GROUND_Y } from '../destruction/VoxelGrid';

/** District dimensions in voxels (multiples of the 32-voxel chunk size). */
export const WORLD_NX = 448;
export const WORLD_NY = 128;
export const WORLD_NZ = 448;
/** District dimensions in metres. */
export const WORLD_X = WORLD_NX * VOXEL;
export const WORLD_Y = WORLD_NY * VOXEL;
export const WORLD_Z = WORLD_NZ * VOXEL;
/** Height of the terrain surface in metres. */
export const GROUND_HEIGHT = GROUND_Y * VOXEL;
export const GRAVITY = 18;

/** Hard resource budgets (tuned for a fanless 16 GB M3 MacBook Air). */
export const LIMITS = {
  /** Dynamic rigid bodies of any kind. */
  maxBodies: 250,
  /** Debris bodies allowed before settled ones are merged back into the world. */
  softDebrisBodies: 150,
  /** Instanced, non-Rapier fragments. */
  maxLightDebris: 1000,
  maxParticles: 2600,
  /** Voxels that may burn at the same time. */
  maxBurning: 220,
  /** Chunk meshes rebuilt per frame. */
  remeshPerFrame: 6,
} as const;
