import type { Vec3Like } from './types';

/** Speed of sound in air, m/s. */
export const SPEED_OF_SOUND = 343;
/** Distance (m) at which a spatial voice plays at unity gain. */
export const REF_DISTANCE = 2.5;
/** Air-absorption cutoff of a source right next to the listener. */
export const AIR_OPEN_HZ = 20000;

const AIR_FLOOR_HZ = 240;
const MAX_PROPAGATION_DELAY = 1.5;
const PANNER_POOL_LIMIT = 32;
const EPSILON = 1e-6;

export function isPoint(v: Vec3Like | null | undefined): v is Vec3Like {
  return v != null && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Older engines only expose the deprecated setPosition()/setOrientation() setters. */
function hasPositionParams(node: AudioListener | PannerNode): boolean {
  return typeof (node as { positionX?: AudioParam }).positionX?.value === 'number';
}

function hasOrientationParams(listener: AudioListener): boolean {
  return typeof (listener as { forwardX?: AudioParam }).forwardX?.value === 'number';
}

/**
 * Listener state plus the helpers a spatial voice needs: pooled equal-power panners,
 * the distance attenuation they apply, propagation delay and air absorption.
 *
 * Usable before an AudioContext exists: the listener pose is remembered and applied on attach().
 */
export class SpatialAudio {
  private ctx: BaseAudioContext | null = null;
  private listenerParams = false;
  private readonly pool: PannerNode[] = [];

  private px = 0;
  private py = 0;
  private pz = 0;
  private fx = 0;
  private fy = 0;
  private fz = -1;
  private ux = 0;
  private uy = 1;
  private uz = 0;

  attach(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    this.pool.length = 0;
    this.listenerParams = hasPositionParams(ctx.listener) && hasOrientationParams(ctx.listener);
    this.applyListener();
  }

  setListener(pos: Vec3Like, forward: Vec3Like, up: Vec3Like): void {
    if (isPoint(pos)) {
      this.px = pos.x;
      this.py = pos.y;
      this.pz = pos.z;
    }
    if (isPoint(forward) && isPoint(up)) {
      const fl = Math.hypot(forward.x, forward.y, forward.z);
      const ul = Math.hypot(up.x, up.y, up.z);
      if (fl > EPSILON && ul > EPSILON) {
        const fx = forward.x / fl;
        const fy = forward.y / fl;
        const fz = forward.z / fl;
        const ux = up.x / ul;
        const uy = up.y / ul;
        const uz = up.z / ul;
        // forward ∥ up leaves the panner's azimuth undefined; keep the last good basis instead.
        const cx = fy * uz - fz * uy;
        const cy = fz * ux - fx * uz;
        const cz = fx * uy - fy * ux;
        if (cx * cx + cy * cy + cz * cz > EPSILON) {
          this.fx = fx;
          this.fy = fy;
          this.fz = fz;
          this.ux = ux;
          this.uy = uy;
          this.uz = uz;
        }
      }
    }
    this.applyListener();
  }

  distanceTo(pos: Vec3Like): number {
    return Math.hypot(pos.x - this.px, pos.y - this.py, pos.z - this.pz);
  }

  /** Gain the inverse distance model applies at `distance` for a given rolloff factor. */
  attenuation(distance: number, rolloff: number): number {
    return REF_DISTANCE / (REF_DISTANCE + rolloff * (Math.max(distance, REF_DISTANCE) - REF_DISTANCE));
  }

  /** Seconds sound needs to travel `distance` metres. */
  propagationDelay(distance: number): number {
    return Math.min(distance / SPEED_OF_SOUND, MAX_PROPAGATION_DELAY);
  }

  /**
   * Low-pass cutoff modelling air absorption. `reach` is the distance (m) at which the cutoff
   * has halved; small values make a source go dull quickly (explosions), large ones keep it crisp.
   */
  airCutoff(distance: number, reach: number): number {
    const x = distance / Math.max(reach, 0.01);
    return Math.max(AIR_FLOOR_HZ, AIR_OPEN_HZ / (1 + x * x));
  }

  /** Writes a point `distance` metres from the listener at compass `bearing` (radians) into `out`. */
  placeAround(out: Vec3Like, bearing: number, distance: number, lift: number): Vec3Like {
    out.x = this.px + Math.cos(bearing) * distance;
    out.y = this.py + lift;
    out.z = this.pz + Math.sin(bearing) * distance;
    return out;
  }

  /** Takes a configured panner from the pool. Returns null until a context is attached. */
  acquire(pos: Vec3Like, rolloff: number): PannerNode | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    let panner = this.pool.pop();
    if (!panner) {
      panner = ctx.createPanner();
      // Equal-power is a couple of multiplies per sample; HRTF would convolve every voice.
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = REF_DISTANCE;
      panner.maxDistance = 10000;
    }
    panner.rolloffFactor = rolloff;
    this.move(panner, pos);
    return panner;
  }

  move(panner: PannerNode, pos: Vec3Like): void {
    if (!isPoint(pos)) return;
    if (hasPositionParams(panner)) {
      panner.positionX.value = pos.x;
      panner.positionY.value = pos.y;
      panner.positionZ.value = pos.z;
    } else {
      panner.setPosition(pos.x, pos.y, pos.z);
    }
  }

  /** Disconnects a panner and returns it to the pool. */
  release(panner: PannerNode): void {
    panner.disconnect();
    if (this.pool.length < PANNER_POOL_LIMIT) this.pool.push(panner);
  }

  private applyListener(): void {
    const listener = this.ctx?.listener;
    if (!listener) return;
    if (this.listenerParams) {
      listener.positionX.value = this.px;
      listener.positionY.value = this.py;
      listener.positionZ.value = this.pz;
      listener.forwardX.value = this.fx;
      listener.forwardY.value = this.fy;
      listener.forwardZ.value = this.fz;
      listener.upX.value = this.ux;
      listener.upY.value = this.uy;
      listener.upZ.value = this.uz;
    } else {
      listener.setPosition(this.px, this.py, this.pz);
      listener.setOrientation(this.fx, this.fy, this.fz, this.ux, this.uy, this.uz);
    }
  }
}
