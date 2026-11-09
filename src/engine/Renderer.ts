/**
 * Rendering pipeline: WebGL2 renderer, sky/atmosphere, sun + on-demand shadow map,
 * pooled dynamic lights, a separate first-person view-model pass and HDR post-processing
 * (bloom → tone-map/grade). Everything that costs GPU time is scalable at runtime.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { settings, type QualityPreset, type ShadowQuality } from '../utils/settings';
import { clamp } from '../utils/math';
import { createVoxelMaterials, type VoxelMaterials } from './VoxelMaterial';
import { GROUND_HEIGHT, WORLD_X, WORLD_Z } from '../world/config';

export const SUN_DIR = new THREE.Vector3(0.52, 0.56, -0.64).normalize();
const SKY_ZENITH = new THREE.Color(0x3d6aa8);
const SKY_HORIZON = new THREE.Color(0xd9c3a2);
const FOG_COLOR = new THREE.Color(0xbfb39e);

interface PooledLight {
  light: THREE.PointLight;
  life: number;
  duration: number;
  peak: number;
  held: boolean;
}

export interface LightHandle {
  set(pos: THREE.Vector3, intensity: number): void;
  release(): void;
}

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tRays: { value: null as THREE.Texture | null },
    uExposure: { value: 1.0 },
    uTime: { value: 0 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.022 },
    uTint: { value: new THREE.Vector3(0, 0, 0) },
    uAspect: { value: 1 },
    uTexel: { value: new THREE.Vector2(1, 1) },
    /** Chromatic split at the frame edge (grows with camera trauma). */
    uCA: { value: 0 },
    uSharp: { value: 0 },
    uRayColor: { value: new THREE.Vector3(0, 0, 0) },
    /** Blast shockwaves: xy = screen centre, z = ring radius (screen heights), w = strength. */
    uWave: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform sampler2D tRays;
    uniform float uExposure; uniform float uTime; uniform float uVignette; uniform float uGrain; uniform float uAspect; uniform float uCA; uniform float uSharp;
    uniform vec3 uTint; uniform vec3 uRayColor; uniform vec2 uTexel; uniform vec4 uWave[3];
    varying vec2 vUv;
    vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
    vec3 toSRGB(vec3 c){ return mix(c*12.92, 1.055*pow(max(c, vec3(0.0)), vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c)); }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      // blast shockwaves bend the image as an expanding ring of compressed air
      vec2 asp = vec2(uAspect, 1.0);
      for (int i = 0; i < 3; i++){
        vec4 w = uWave[i];
        if (w.w > 0.0){
          vec2 dv = (uv - w.xy) * asp;
          float d = length(dv) + 1e-5;
          float k = (d - w.z) / (0.03 + w.z * 0.22);
          uv += (dv / d) / asp * exp(-k * k) * w.w;
        }
      }
      vec3 c = texture2D(tDiffuse, uv).rgb;
      // contrast-adaptive sharpening keeps a reduced render resolution crisp
      if (uSharp > 0.0){
        vec3 a = texture2D(tDiffuse, uv + vec2(uTexel.x, 0.0)).rgb;
        vec3 b = texture2D(tDiffuse, uv - vec2(uTexel.x, 0.0)).rgb;
        vec3 e = texture2D(tDiffuse, uv + vec2(0.0, uTexel.y)).rgb;
        vec3 f = texture2D(tDiffuse, uv - vec2(0.0, uTexel.y)).rgb;
        vec3 mn = min(c, min(min(a, b), min(e, f)));
        vec3 mx = max(c, max(max(a, b), max(e, f)));
        c = clamp(c + (c - (a + b + e + f) * 0.25) * uSharp, mn, mx);
      }
      // lens: colour fringes towards the corners, violent while the camera is shaken
      vec2 dir = uv - 0.5;
      float ca = uCA * dot(dir, dir) * 4.0;
      if (ca > 0.0003){
        c.r = mix(c.r, texture2D(tDiffuse, uv + dir * ca).r, 0.85);
        c.b = mix(c.b, texture2D(tDiffuse, uv - dir * ca).b, 0.85);
      }
      c += texture2D(tRays, vUv).r * uRayColor;
      c *= uExposure;
      vec2 d = vUv - 0.5;
      c *= 1.0 - uVignette * smoothstep(0.25, 0.95, dot(d, d) * 2.2);
      c = aces(c);
      // gentle filmic grade: lifted warm highlights, cool shadows
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 1.08);
      c += vec3(0.012, 0.004, -0.012) * smoothstep(0.4, 1.0, l) + vec3(-0.008, 0.0, 0.012) * (1.0 - smoothstep(0.0, 0.4, l));
      c += uTint;
      c = toSRGB(c);
      c += (hash(vUv * vec2(1920.0, 1080.0) + uTime) - 0.5) * uGrain;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

/**
 * Screen-space light shafts: marches from every pixel towards the sun through the HDR
 * frame and gathers whatever is brighter than the scene should be (the sun and its halo),
 * so anything standing in front of the sun casts visible beams. Runs at quarter resolution.
 */
class LightShaftPass extends Pass {
  readonly target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
  readonly uniforms = {
    tDiffuse: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1 },
    uSeed: { value: 0 },
  };
  /** Set per frame; the pass is skipped entirely at 0. */
  strength = 0;
  private readonly quad: FullScreenQuad;

  constructor() {
    super();
    this.needsSwap = false;
    this.quad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        depthTest: false,
        depthWrite: false,
        vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uAspect; uniform float uSeed; varying vec2 vUv;
          void main(){
            const int N = 24;
            vec2 delta = (uSun - vUv) * (0.94 / float(N));
            // interleaved-gradient offset: breaks up banding without visible grain after upsampling
            float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
            vec2 uv = vUv + delta * ign * 0.6;
            float acc = 0.0;
            float w = 1.0;
            for (int i = 0; i < N; i++){
              float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
              vec3 c = texture2D(tDiffuse, uv).rgb;
              float l = dot(c, vec3(0.299, 0.587, 0.114));
              float near = 1.0 - smoothstep(0.0, 0.5, length((uv - uSun) * vec2(uAspect, 1.0)));
              acc += min(max(l - 1.45, 0.0), 2.5) * near * w * inside;
              w *= 0.955;
              uv += delta;
            }
            gl_FragColor = vec4(vec3(acc / float(N)), 1.0);
          }`,
      }),
    );
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(Math.max(2, Math.round(width / 4)), Math.max(2, Math.round(height / 4)));
    this.uniforms.uAspect.value = width / Math.max(1, height);
  }

  override render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    if (this.strength <= 0.002) return;
    this.uniforms.tDiffuse.value = read.texture;
    this.uniforms.uSeed.value = (this.uniforms.uSeed.value + 0.37) % 10;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.target.dispose();
    this.quad.dispose();
  }
}

interface Shockwave {
  pos: THREE.Vector3;
  life: number;
  duration: number;
  radius: number;
}

const vProj = new THREE.Vector3();

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** First-person weapon scene, rendered over the world with its own depth range. */
  readonly viewScene = new THREE.Scene();
  readonly viewCamera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly viewSun: THREE.DirectionalLight;
  readonly viewHemi: THREE.HemisphereLight;
  readonly viewFlash: THREE.PointLight;
  readonly materials: VoxelMaterials;
  private composer!: EffectComposer;
  private worldPass!: RenderPass;
  private viewPass!: RenderPass;
  private bloom!: UnrealBloomPass;
  private finalPass!: ShaderPass;
  private shafts!: LightShaftPass;
  private readonly shockwaves: Shockwave[] = [0, 1, 2].map(() => ({ pos: new THREE.Vector3(), life: 0, duration: 1, radius: 1 }));
  /** 0..1 camera trauma, drives the chromatic split (set by the game every frame). */
  chroma = 0;
  /** Cleared by the performance manager when the expensive screen effects have to go. */
  fxAllowed = true;
  private lights: PooledLight[] = [];
  private shadowDirty = true;
  private shadowTick = 0;
  /** Render a shadow map only every N-th frame while things are moving (set by the performance manager). */
  shadowInterval = 1;
  private width = 1;
  private height = 1;
  /** Resolution scale chosen in the settings. */
  private userScale = 1;
  /** Extra reduction applied by the performance manager under load. */
  private adaptScale = 1;
  /** Canvas pixels per CSS pixel actually in use. */
  private pixelRatio = 1;
  private pixelBudget = 0;
  private msaa = 0;
  private sky: THREE.Mesh;
  private time = 0;
  bloomAllowed = true;

  constructor(readonly canvas: HTMLCanvasElement, readonly camera: THREE.PerspectiveCamera) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.gl.shadowMap.autoUpdate = false;
    this.gl.info.autoReset = false;
    this.gl.setClearColor(FOG_COLOR, 1);

    this.materials = createVoxelMaterials(Math.min(4, this.gl.capabilities.getMaxAnisotropy()));

    this.scene.fog = new THREE.FogExp2(FOG_COLOR.getHex(), 0.005);
    this.sky = this.buildSky();
    this.scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffe0b8, 3.4);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    const sc = this.sun.shadow.camera;
    sc.left = -70;
    sc.right = 70;
    sc.top = 70;
    sc.bottom = -70;
    sc.near = 10;
    sc.far = 260;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xa8c0e6, 0x57504a, 1.05);
    this.scene.add(this.hemi);

    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xffa040, 0, 18, 2);
      light.castShadow = false;
      this.scene.add(light);
      this.lights.push({ light, life: 0, duration: 1, peak: 0, held: false });
    }

    this.viewHemi = new THREE.HemisphereLight(0xb8c8e0, 0x4a4540, 1.2);
    this.viewSun = new THREE.DirectionalLight(0xffe0b8, 2.6);
    this.viewFlash = new THREE.PointLight(0xffb060, 0, 3, 2);
    this.viewScene.add(this.viewHemi, this.viewSun, this.viewSun.target, this.viewFlash);

    this.buildEnvironment();
    this.buildBackdrop();
    this.buildComposer();
    this.applyQuality();
    settings.subscribe((_s, key) => {
      if (key === null || key === 'quality' || key === 'shadows' || key === 'bloom' || key === 'resolutionScale' || key === 'lowPower') this.applyQuality();
    });
  }

  /** Centre the sun's shadow frustum on the district. */
  setWorldBounds(sizeX: number, sizeZ: number): void {
    const cx = sizeX / 2;
    const cz = sizeZ / 2;
    this.sun.target.position.set(cx, 4, cz);
    this.sun.position.copy(this.sun.target.position).addScaledVector(SUN_DIR, 130);
    const r = Math.hypot(sizeX, sizeZ) / 2 + 6;
    const sc = this.sun.shadow.camera;
    sc.left = -r;
    sc.right = r;
    sc.top = r;
    sc.bottom = -r;
    sc.updateProjectionMatrix();
    this.sun.target.updateMatrixWorld();
    this.requestShadowUpdate();
  }

  private buildSky(): THREE.Mesh {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uZenith: { value: SKY_ZENITH }, uHorizon: { value: SKY_HORIZON }, uSun: { value: SUN_DIR }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSun; uniform float uTime; varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
        float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p){ float a = 0.5; float s = 0.0; for (int i = 0; i < 5; i++){ s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
        void main(){
          vec3 d = normalize(vDir);
          float h = max(d.y, 0.0);
          vec3 c = mix(uHorizon, uZenith, pow(h, 0.48));
          c = mix(c, uHorizon * 0.82, smoothstep(0.0, -0.25, d.y));
          float s = max(dot(d, uSun), 0.0);
          c += vec3(1.0, 0.72, 0.42) * (pow(s, 6.0) * 0.28 + pow(s, 60.0) * 0.6);
          // drifting cumulus deck: fbm coverage, lit from the sun side, silver lining towards the sun
          vec2 uv = d.xz / (d.y + 0.14) * 1.7 + uTime * vec2(0.006, 0.002);
          float cov = fbm(uv);
          float dens = smoothstep(0.5, 0.7, cov) * smoothstep(0.0, 0.16, d.y);
          float toward = fbm(uv + uSun.xz * 0.16);
          float lit = clamp(0.62 + (cov - toward) * 2.4, 0.0, 1.0);
          vec3 cloud = mix(vec3(0.5, 0.52, 0.6), vec3(1.0, 0.95, 0.86), lit);
          cloud += vec3(1.0, 0.78, 0.5) * pow(s, 10.0) * (1.0 - dens * 0.5) * 0.9;
          c = mix(c, cloud, dens * 0.88);
          // the disc itself, dimmed where cloud covers it
          c += vec3(1.0, 0.92, 0.78) * smoothstep(0.9993, 0.9997, s) * 14.0 * (1.0 - dens * 0.85);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mat);
    mesh.scale.setScalar(900);
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    mesh.matrixAutoUpdate = true;
    return mesh;
  }

  /** Image-based ambient light and glass/metal reflections, baked once from the sky. */
  private buildEnvironment(): void {
    const envScene = new THREE.Scene();
    const sky = this.sky.clone();
    sky.scale.setScalar(50);
    envScene.add(sky);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 24), new THREE.MeshBasicMaterial({ color: 0x4a4640 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1;
    envScene.add(ground);
    const pmrem = new THREE.PMREMGenerator(this.gl);
    const rt = pmrem.fromScene(envScene, 0.02, 0.1, 100);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.5;
    this.viewScene.environment = rt.texture;
    this.viewScene.environmentIntensity = 0.7;
    pmrem.dispose();
    (ground.material as THREE.Material).dispose();
    ground.geometry.dispose();
  }

  /** Hazy skyline and an endless ground plane so the district never ends in a void. */
  private buildBackdrop(): void {
    // Four strips around the playable area: a single plane would show through craters.
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x55534f, roughness: 1 });
    const strip = (x0: number, z0: number, x1: number, z1: number) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), groundMat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set((x0 + x1) / 2, GROUND_HEIGHT - 0.02, (z0 + z1) / 2);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scene.add(mesh);
    };
    const far = 800;
    strip(-far, -far, WORLD_X + far, 0.05);
    strip(-far, WORLD_Z - 0.05, WORLD_X + far, WORLD_Z + far);
    strip(-far, 0.05, 0.05, WORLD_Z - 0.05);
    strip(WORLD_X - 0.05, 0.05, WORLD_X + far, WORLD_Z - 0.05);

    const count = 90;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6f7480, roughness: 1 });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + rnd() * 0.06;
      const dist = 120 + rnd() * 170;
      const w = 12 + rnd() * 26;
      const d = 12 + rnd() * 26;
      const tall = rnd() > 0.82;
      const h = tall ? 40 + rnd() * 60 : 8 + rnd() * 22;
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * 0.5);
      m.compose(new THREE.Vector3(45 + Math.cos(ang) * dist, 1.5 + h / 2, 45 + Math.sin(ang) * dist), q, new THREE.Vector3(w, h, d));
      inst.setMatrixAt(i, m);
      col.setHSL(0.6, 0.05, 0.3 + rnd() * 0.14);
      inst.setColorAt(i, col);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = false;
    inst.receiveShadow = false;
    inst.frustumCulled = false;
    this.scene.add(inst);
  }

  private buildComposer(): void {
    const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: this.msaa, depthBuffer: true });
    this.composer = new EffectComposer(this.gl, target);
    this.worldPass = new RenderPass(this.scene, this.camera);
    this.viewPass = new RenderPass(this.viewScene, this.viewCamera);
    this.viewPass.clear = false;
    this.viewPass.clearDepth = true;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.42, 0.55, 1.0);
    this.shafts?.dispose();
    this.shafts = new LightShaftPass();
    this.finalPass = new ShaderPass(FinalShader);
    this.finalPass.uniforms.tRays.value = this.shafts.target.texture;
    this.composer.addPass(this.worldPass);
    // before the view model, so the weapon in your hands does not cast (or emit) shafts
    this.composer.addPass(this.shafts);
    this.composer.addPass(this.viewPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.finalPass);
  }

  /** Apply the user's quality settings (resolution scale is applied through setRenderScale). */
  applyQuality(): void {
    const q: QualityPreset = settings.get('quality');
    const low = settings.get('lowPower');
    const shadows: ShadowQuality = low && settings.get('shadows') === 'high' ? 'medium' : settings.get('shadows');
    const size = shadows === 'high' ? 4096 : shadows === 'medium' ? 2048 : 1024;
    this.sun.castShadow = shadows !== 'off';
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    const msaa = q === 'low' || low ? 0 : q === 'medium' ? 2 : 4;
    if (msaa !== this.msaa) {
      this.msaa = msaa;
      const old = this.composer;
      this.buildComposer();
      old.dispose();
      this.resize(this.width, this.height, true);
    }
    if (this.budget() !== this.pixelBudget) this.resize(this.width, this.height, true);
    this.bloom.enabled = settings.get('bloom') && this.bloomAllowed && !(low && q === 'low');
    this.bloom.strength = q === 'high' ? 0.5 : 0.42;
    this.finalPass.uniforms.uGrain.value = q === 'low' ? 0 : 0.022;
    this.requestShadowUpdate();
  }

  setBloomAllowed(allowed: boolean): void {
    if (this.bloomAllowed === allowed) return;
    this.bloomAllowed = allowed;
    this.bloom.enabled = settings.get('bloom') && allowed;
  }

  /**
   * Resolution: `user` is the fraction of native pixels asked for in the settings, `adapt`
   * a further reduction under load. Reallocates render targets, so call sparingly.
   */
  setRenderScale(user: number, adapt = 1): void {
    user = clamp(user, 0.3, 1);
    adapt = clamp(adapt, 0.4, 1);
    if (Math.abs(user - this.userScale) < 0.02 && Math.abs(adapt - this.adaptScale) < 0.02) return;
    this.userScale = user;
    this.adaptScale = adapt;
    this.resize(this.width, this.height, true);
  }

  /** Fraction of the display's native resolution currently rendered. */
  getRenderScale(): number {
    return this.pixelRatio / Math.min(window.devicePixelRatio || 1, 2);
  }

  /**
   * Most pixels the 3D view may render, whatever the window size: a 5-megapixel Retina
   * window would otherwise cost four times a 1080p one for no visible gain (the final
   * pass sharpens the upscale) and heats a fanless laptop for nothing.
   */
  private budget(): number {
    const q: QualityPreset = settings.get('quality');
    return (q === 'low' ? 1.5e6 : q === 'medium' ? 2.4e6 : 3.4e6) * (settings.get('lowPower') ? 0.75 : 1);
  }

  resize(width: number, height: number, force = false): void {
    if (!force && width === this.width && height === this.height) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.pixelBudget = this.budget();
    const cap = Math.sqrt(this.pixelBudget / (this.width * this.height));
    const ratio = Math.max(0.35, Math.min(dpr * this.userScale, cap) * this.adaptScale);
    this.pixelRatio = ratio;
    this.gl.setPixelRatio(ratio);
    this.gl.setSize(this.width, this.height, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = this.camera.aspect;
    this.viewCamera.updateProjectionMatrix();
    this.finalPass.uniforms.uAspect.value = this.camera.aspect;
    (this.finalPass.uniforms.uTexel.value as THREE.Vector2).set(1 / Math.max(1, this.width * ratio), 1 / Math.max(1, this.height * ratio));
  }

  /** Screen-space refraction ring for a blast at a world position (radius in metres at full size). */
  shockwave(pos: THREE.Vector3, radius: number): void {
    let slot = this.shockwaves[0];
    for (const w of this.shockwaves) if (w.life < slot.life) slot = w;
    slot.pos.copy(pos);
    slot.radius = radius;
    slot.duration = 0.5;
    slot.life = 0.5;
  }

  requestShadowUpdate(): void {
    this.shadowDirty = true;
  }

  /** Short-lived light (muzzle flash, explosion). Steals the dimmest pooled light when all are busy. */
  flash(pos: THREE.Vector3, color: number, intensity: number, radius: number, duration: number): void {
    let best: PooledLight | null = null;
    for (const l of this.lights) {
      if (l.held) continue;
      if (!best || l.light.intensity < best.light.intensity) best = l;
    }
    if (!best || best.light.intensity > intensity) return;
    best.light.position.copy(pos);
    best.light.color.setHex(color);
    best.light.intensity = intensity;
    best.light.distance = radius;
    best.peak = intensity;
    best.life = duration;
    best.duration = duration;
  }

  /** Reserve a pooled light for a sustained effect (blowtorch, fire). Returns null when none is free. */
  holdLight(color: number, radius: number): LightHandle | null {
    const slot = this.lights.find((l) => !l.held && l.life <= 0);
    if (!slot) return null;
    slot.held = true;
    slot.light.color.setHex(color);
    slot.light.distance = radius;
    slot.light.intensity = 0;
    return {
      set: (pos, intensity) => {
        slot.light.position.copy(pos);
        slot.light.intensity = intensity;
      },
      release: () => {
        slot.held = false;
        slot.light.intensity = 0;
        slot.life = 0;
      },
    };
  }

  /** Screen tint added after tone-mapping (explosion flash warmth). */
  setTint(r: number, g: number, b: number): void {
    (this.finalPass.uniforms.uTint.value as THREE.Vector3).set(r, g, b);
  }

  render(dt: number, anythingMoving: boolean, sunVisibility: number): void {
    this.time += dt;
    for (const l of this.lights) {
      if (l.held || l.life <= 0) continue;
      l.life -= dt;
      const t = Math.max(0, l.life / l.duration);
      l.light.intensity = l.peak * t * t;
    }
    if (this.viewFlash.intensity > 0) this.viewFlash.intensity = Math.max(0, this.viewFlash.intensity - dt * 160);

    // The view-model lives in camera space: bring the sun direction into it and dim it in shade.
    const local = this.viewSun.position.copy(SUN_DIR).transformDirection(this.camera.matrixWorldInverse);
    this.viewSun.position.copy(local).multiplyScalar(5);
    this.viewSun.intensity = 0.2 + 1.5 * sunVisibility;
    this.viewHemi.intensity = 0.95 + 0.35 * sunVisibility;

    this.sky.position.copy(this.camera.position);
    if (this.sun.castShadow) {
      this.shadowTick++;
      if (this.shadowDirty || (anythingMoving && this.shadowTick % this.shadowInterval === 0)) {
        this.gl.shadowMap.needsUpdate = true;
        this.shadowDirty = false;
      }
    }
    const fu = this.finalPass.uniforms;
    fu.uTime.value = this.time % 97;
    (this.sky.material as THREE.ShaderMaterial).uniforms.uTime.value = this.time;
    const quality = settings.get('quality');
    const fancy = quality !== 'low' && !settings.get('lowPower') && this.fxAllowed;
    const cam = this.camera;
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);

    // light shafts: only while the sun is in front of the camera
    let rays = 0;
    if (fancy) {
      const e = cam.matrixWorld.elements;
      const facing = -(e[8] * SUN_DIR.x + e[9] * SUN_DIR.y + e[10] * SUN_DIR.z);
      if (facing > 0.08) {
        vProj.copy(SUN_DIR).multiplyScalar(500).add(cam.position).project(cam);
        this.shafts.uniforms.uSun.value.set(vProj.x * 0.5 + 0.5, vProj.y * 0.5 + 0.5);
        rays = clamp((facing - 0.08) / 0.35, 0, 1) * (quality === 'high' ? 1 : 0.85);
      }
    }
    this.shafts.strength = rays;
    (fu.uRayColor.value as THREE.Vector3).set(1.0, 0.8, 0.55).multiplyScalar(rays * 0.7);

    // shockwaves
    const waves = fu.uWave.value as THREE.Vector4[];
    for (let i = 0; i < waves.length; i++) {
      const w = this.shockwaves[i];
      waves[i].w = 0;
      if (w.life <= 0) continue;
      w.life -= dt;
      vProj.copy(w.pos).applyMatrix4(cam.matrixWorldInverse);
      const depth = -vProj.z;
      if (w.life <= 0 || depth < 0.4) continue;
      const t = 1 - w.life / w.duration;
      vProj.copy(w.pos).project(cam);
      const fade = (1 - t) * (1 - t);
      waves[i].set(vProj.x * 0.5 + 0.5, vProj.y * 0.5 + 0.5, (w.radius * (0.15 + 0.85 * t)) / (2 * depth * tanHalf), 0.034 * fade * clamp(14 / depth, 0.12, 1.5));
    }
    fu.uCA.value = (quality === 'low' ? 0 : 0.0016) + this.chroma * this.chroma * 0.022;
    fu.uSharp.value = quality === 'low' ? 0 : this.getRenderScale() < 0.95 ? 0.55 : 0.3;
    this.gl.info.reset();
    this.composer.render(dt);
  }

  dispose(): void {
    this.shafts.dispose();
    this.composer.dispose();
    this.materials.dispose();
    this.gl.dispose();
  }
}
