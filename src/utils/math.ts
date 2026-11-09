export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach. */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash → [0, 1). */
export function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function hash2(x: number, y: number): number {
  return hash3(x, y, 17);
}

/** Tileable 2D value noise in [0,1]; periods are in lattice cells. */
export function valueNoise(x: number, y: number, periodX: number, periodY: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const wx = (n: number) => ((n % periodX) + periodX) % periodX;
  const wy = (n: number) => ((n % periodY) + periodY) % periodY;
  const a = hash3(wx(xi), wy(yi), seed);
  const b = hash3(wx(xi + 1), wy(yi), seed);
  const c = hash3(wx(xi), wy(yi + 1), seed);
  const d = hash3(wx(xi + 1), wy(yi + 1), seed);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const randInt = (a: number, b: number): number => Math.floor(rand(a, b + 1));

/** Fixed-capacity free-list pool for plain objects. */
export class Pool<T> {
  private free: T[] = [];
  constructor(private readonly create: () => T, private readonly capacity = 256) {}
  obtain(): T {
    return this.free.pop() ?? this.create();
  }
  release(item: T): void {
    if (this.free.length < this.capacity) this.free.push(item);
  }
}
