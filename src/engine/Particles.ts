/**
 * Pooled GPU-instanced billboard particles. Two fixed-capacity layers (alpha-blended
 * smoke/dust, additive fire/sparks) → two draw calls regardless of particle count.
 * Smoke puffs are shaded as lit spheres so overlapping billboards read as volume.
 */
import * as THREE from 'three';
import { GRAVITY, LIMITS } from '../world/config';
import { SUN_DIR } from './Renderer';

export const P_ALPHA = 0;
export const P_ADD = 1;

class Layer {
  count = 0;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  readonly s0: Float32Array;
  readonly s1: Float32Array;
  readonly grav: Float32Array;
  readonly drag: Float32Array;
  readonly seed: Float32Array;
  readonly col: Float32Array;
  readonly iPos: THREE.InstancedBufferAttribute;
  readonly iCol: THREE.InstancedBufferAttribute;
  readonly iMisc: THREE.InstancedBufferAttribute;
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.InstancedBufferGeometry;

  constructor(readonly capacity: number, material: THREE.ShaderMaterial) {
    const f = () => new Float32Array(capacity);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.life = f(); this.maxLife = f(); this.s0 = f(); this.s1 = f();
    this.grav = f(); this.drag = f(); this.seed = f();
    this.col = new Float32Array(capacity * 4);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.iCol = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.iMisc = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.iPos.setUsage(THREE.DynamicDrawUsage);
    this.iCol.setUsage(THREE.DynamicDrawUsage);
    this.iMisc.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.iPos);
    g.setAttribute('iCol', this.iCol);
    g.setAttribute('iMisc', this.iMisc);
    g.instanceCount = 0;
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  add(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, r: number, g: number, b: number, a: number, grav: number, drag: number): void {
    let i = this.count;
    if (i >= this.capacity) {
      // full: overwrite a random particle rather than refusing new effects
      i = (Math.random() * this.capacity) | 0;
    } else this.count++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.maxLife[i] = life; this.s0[i] = s0; this.s1[i] = s1;
    this.grav[i] = grav; this.drag[i] = drag; this.seed[i] = Math.random();
    const c = i * 4;
    this.col[c] = r; this.col[c + 1] = g; this.col[c + 2] = b; this.col[c + 3] = a;
  }

  update(dt: number): void {
    const { px, py, pz, vx, vy, vz, life, maxLife, s0, s1, grav, drag, seed, col } = this;
    const pos = this.iPos.array as Float32Array;
    const icol = this.iCol.array as Float32Array;
    const misc = this.iMisc.array as Float32Array;
    let n = this.count;
    for (let i = 0; i < n; ) {
      life[i] -= dt;
      if (life[i] <= 0) {
        n--;
        if (i !== n) {
          px[i] = px[n]; py[i] = py[n]; pz[i] = pz[n];
          vx[i] = vx[n]; vy[i] = vy[n]; vz[i] = vz[n];
          life[i] = life[n]; maxLife[i] = maxLife[n]; s0[i] = s0[n]; s1[i] = s1[n];
          grav[i] = grav[n]; drag[i] = drag[n]; seed[i] = seed[n];
          col[i * 4] = col[n * 4]; col[i * 4 + 1] = col[n * 4 + 1]; col[i * 4 + 2] = col[n * 4 + 2]; col[i * 4 + 3] = col[n * 4 + 3];
        }
        continue;
      }
      const k = Math.max(0, 1 - drag[i] * dt);
      vx[i] *= k; vz[i] *= k;
      vy[i] = vy[i] * k - grav[i] * GRAVITY * dt;
      px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
      const t = 1 - life[i] / maxLife[i];
      const o = i * 4;
      pos[o] = px[i]; pos[o + 1] = py[i]; pos[o + 2] = pz[i];
      pos[o + 3] = s0[i] + (s1[i] - s0[i]) * (1 - (1 - t) * (1 - t));
      icol[o] = col[o]; icol[o + 1] = col[o + 1]; icol[o + 2] = col[o + 2]; icol[o + 3] = col[o + 3];
      misc[i * 2] = seed[i];
      misc[i * 2 + 1] = t;
      i++;
    }
    this.count = n;
    this.geometry.instanceCount = n;
    if (n > 0) {
      this.iPos.clearUpdateRanges(); this.iPos.addUpdateRange(0, n * 4); this.iPos.needsUpdate = true;
      this.iCol.clearUpdateRanges(); this.iCol.addUpdateRange(0, n * 4); this.iCol.needsUpdate = true;
      this.iMisc.clearUpdateRanges(); this.iMisc.addUpdateRange(0, n * 2); this.iMisc.needsUpdate = true;
    }
  }
}

const VERT = /* glsl */ `
attribute vec4 iPos; attribute vec4 iCol; attribute vec2 iMisc;
varying vec2 vUv; varying vec4 vCol; varying vec2 vMisc; varying float vDepth;
void main(){
  vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0);
  float rot = iMisc.x * 6.2831 + (iMisc.x - 0.5) * iMisc.y * 2.4;
  float cs = cos(rot), sn = sin(rot);
  vec2 c = position.xy;
  mv.xy += vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * iPos.w;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy * 2.0; vCol = iCol; vMisc = iMisc; vDepth = -mv.z;
}`;

const FRAG_ALPHA = /* glsl */ `
uniform vec3 uSunView; uniform vec3 uFogColor; uniform float uFogDensity;
varying vec2 vUv; varying vec4 vCol; varying vec2 vMisc; varying float vDepth;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
void main(){
  float n = noise(vUv * 2.6 + vMisc.x * 37.0);
  float r2 = dot(vUv, vUv) + (n - 0.5) * 0.55;
  if (r2 > 1.0) discard;
  float t = vMisc.y;
  float fade = min(1.0, t * 9.0) * pow(1.0 - t, 1.3);
  float alpha = vCol.a * fade * smoothstep(1.0, 0.2, r2);
  vec3 nrm = normalize(vec3(vUv, sqrt(max(0.0, 1.0 - dot(vUv, vUv)))));
  float lit = 0.5 + 0.5 * max(dot(nrm, uSunView), 0.0) + 0.14 * nrm.y;
  vec3 c = vCol.rgb * lit * (0.82 + n * 0.36);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
  gl_FragColor = vec4(mix(c, uFogColor, fog), alpha * (1.0 - fog * 0.6));
}`;

const FRAG_ADD = /* glsl */ `
varying vec2 vUv; varying vec4 vCol; varying vec2 vMisc; varying float vDepth;
void main(){
  float r = length(vUv);
  if (r > 1.0) discard;
  float t = vMisc.y;
  float core = pow(1.0 - r, 1.6);
  vec3 c = mix(vCol.rgb, vCol.rgb * vec3(1.0, 0.32, 0.08), t);
  gl_FragColor = vec4(c * core * vCol.a * (1.0 - t) * (1.0 - t), 1.0);
}`;

export class Particles {
  readonly alpha: Layer;
  readonly add: Layer;
  /** 0..1 multiplier applied to emission counts (performance manager). */
  density = 1;
  private readonly alphaMat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, fog: THREE.FogExp2) {
    this.alphaMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG_ALPHA,
      uniforms: { uSunView: { value: new THREE.Vector3() }, uFogColor: { value: fog.color }, uFogDensity: { value: fog.density } },
      transparent: true,
      depthWrite: false,
    });
    const addMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG_ADD, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const alphaCap = Math.floor(LIMITS.maxParticles * 0.62);
    this.alpha = new Layer(alphaCap, this.alphaMat);
    this.add = new Layer(LIMITS.maxParticles - alphaCap, addMat);
    this.alpha.mesh.renderOrder = 5;
    this.add.mesh.renderOrder = 6;
    scene.add(this.alpha.mesh, this.add.mesh);
  }

  get count(): number {
    return this.alpha.count + this.add.count;
  }

  update(dt: number, camera: THREE.Camera): void {
    (this.alphaMat.uniforms.uSunView.value as THREE.Vector3).copy(SUN_DIR).transformDirection(camera.matrixWorldInverse);
    this.alpha.update(dt);
    this.add.update(dt);
  }

  clear(): void {
    this.alpha.count = 0;
    this.add.count = 0;
    this.alpha.geometry.instanceCount = 0;
    this.add.geometry.instanceCount = 0;
  }

  private n(count: number): number {
    const c = count * this.density;
    const whole = Math.floor(c);
    return whole + (Math.random() < c - whole ? 1 : 0);
  }

  /** Dust/pulverised material in the colour of what broke. */
  dust(x: number, y: number, z: number, r: number, g: number, b: number, count: number, spread: number, speed: number, size = 0.5): void {
    const n = this.n(count);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const s = Math.sqrt(1 - u * u);
      const v = speed * (0.3 + Math.random() * 0.7);
      this.alpha.add(
        x + (Math.random() - 0.5) * spread, y + (Math.random() - 0.5) * spread, z + (Math.random() - 0.5) * spread,
        Math.cos(a) * s * v, Math.abs(u) * v * 0.7 + 0.2, Math.sin(a) * s * v,
        0.9 + Math.random() * 1.3, size * 0.5, size * (1.6 + Math.random()),
        r * 0.75 + 0.2, g * 0.75 + 0.2, b * 0.75 + 0.2, 0.34 + Math.random() * 0.2, 0.03, 2.6,
      );
    }
  }

  /** Directional dust jet (bullet impact). */
  puff(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, count: number, size = 0.3): void {
    const n = this.n(count);
    for (let i = 0; i < n; i++) {
      const v = 1.2 + Math.random() * 2.6;
      this.alpha.add(
        x, y, z,
        nx * v + (Math.random() - 0.5) * 1.6, ny * v + (Math.random() - 0.5) * 1.6 + 0.3, nz * v + (Math.random() - 0.5) * 1.6,
        0.5 + Math.random() * 0.7, size * 0.5, size * (1.5 + Math.random()),
        r * 0.75 + 0.2, g * 0.75 + 0.2, b * 0.75 + 0.2, 0.4, 0.05, 3.4,
      );
    }
  }

  smoke(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, shade: number, alpha: number): void {
    if (Math.random() > this.density + 0.25) return;
    this.alpha.add(x, y, z, vx, vy, vz, life, size * 0.45, size * (1.7 + Math.random() * 0.9), shade, shade, shade * 1.03, alpha, -0.035, 0.9);
  }

  spark(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r = 3.2, g = 1.9, b = 0.7): void {
    this.add.add(x, y, z, vx, vy, vz, life, size, size * 0.4, r, g, b, 1, 0.55, 0.6);
  }

  sparks(x: number, y: number, z: number, nx: number, ny: number, nz: number, count: number, speed: number): void {
    const n = this.n(count);
    for (let i = 0; i < n; i++) {
      const v = speed * (0.35 + Math.random() * 0.65);
      this.spark(x, y, z, nx * v + (Math.random() - 0.5) * speed * 0.9, ny * v + (Math.random() - 0.5) * speed * 0.9 + 0.6, nz * v + (Math.random() - 0.5) * speed * 0.9, 0.25 + Math.random() * 0.45, 0.05 + Math.random() * 0.05);
    }
  }

  flame(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, intensity = 1): void {
    this.add.add(x, y, z, vx, vy, vz, life, size, size * 0.3, 2.6 * intensity, 1.25 * intensity, 0.32 * intensity, 1, -0.12, 1.4);
  }

  /** Fireball + rising smoke column + sparks. */
  explosion(x: number, y: number, z: number, radius: number): void {
    const fire = this.n(26 + radius * 9);
    for (let i = 0; i < fire; i++) {
      const a = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const s = Math.sqrt(1 - u * u);
      const v = radius * (1.4 + Math.random() * 3.4);
      this.add.add(x, y, z, Math.cos(a) * s * v, u * v * 0.8 + radius * 0.8, Math.sin(a) * s * v, 0.28 + Math.random() * 0.42, radius * 0.35, radius * (0.9 + Math.random() * 0.8), 3.6, 1.7, 0.45, 1, -0.05, 3.8);
    }
    const smoke = this.n(20 + radius * 8);
    for (let i = 0; i < smoke; i++) {
      const a = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const s = Math.sqrt(1 - u * u);
      const v = radius * (0.6 + Math.random() * 2.2);
      const shade = 0.1 + Math.random() * 0.2;
      this.alpha.add(
        x + Math.cos(a) * s * radius * 0.3, y + Math.abs(u) * radius * 0.3, z + Math.sin(a) * s * radius * 0.3,
        Math.cos(a) * s * v, Math.abs(u) * v * 0.9 + 1.2, Math.sin(a) * s * v,
        2.2 + Math.random() * 2.6, radius * 0.5, radius * (1.3 + Math.random() * 1.2), shade, shade, shade, 0.5 + Math.random() * 0.2, -0.03, 1.5,
      );
    }
    this.sparks(x, y, z, 0, 0.6, 0, 22 + radius * 6, 9 + radius * 3);
  }
}
