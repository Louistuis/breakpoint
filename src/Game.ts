/**
 * Application shell: boots every system, owns the state machine
 * (loading → menu → playing ⇄ paused → results) and runs the frame loop.
 */
import * as THREE from 'three';
import { createAudio } from './audio/AudioManager';
import { CollapseDirector } from './destruction/CollapseDirector';
import { DamageSystem } from './destruction/DamageSystem';
import { DebrisManager } from './destruction/DebrisManager';
import { ExplosionSystem } from './destruction/ExplosionSystem';
import { FireSystem } from './destruction/FireSystem';
import { StructuralIntegrity, type DetachedComponent } from './destruction/StructuralIntegrity';
import { makeRayHit } from './destruction/VoxelGrid';
import { CameraRig } from './engine/Camera';
import type { GameContext } from './engine/Context';
import { Input } from './engine/Input';
import { Particles } from './engine/Particles';
import { PerformanceManager } from './engine/PerformanceManager';
import { Physics, RAPIER } from './engine/Physics';
import { Renderer, SUN_DIR } from './engine/Renderer';
import { World } from './engine/World';
import { InteractionSystem } from './gameplay/InteractionSystem';
import { ObjectiveSystem } from './gameplay/ObjectiveSystem';
import { PlayerController } from './gameplay/PlayerController';
import { WeaponManager } from './gameplay/WeaponManager';
import { CHALLENGES, type ChallengeDef, type ChallengeResult, type GameMode } from './gameplay/challenges';
import { createUI } from './ui';
import type { IUI } from './ui/types';
import { damp } from './utils/math';
import { settings } from './utils/settings';
import { WORLD_X, WORLD_Z } from './world/config';

type State = 'loading' | 'menu' | 'playing' | 'paused' | 'results';

const sunHit = makeRayHit();
const vFwd = new THREE.Vector3();
const vUp = new THREE.Vector3();

export class Game {
  readonly ctx = { mode: 'sandbox', time: 0 } as GameContext;
  private readonly ui: IUI;
  private state: State = 'loading';
  private challenge: ChallengeDef | null = null;
  private lastFrame = 0;
  private busy = false;
  private wasLocked = false;
  private unlockedFor = 0;
  private pausedAt = 0;
  private sunVis = 1;
  private menuAngle = 0.9;
  private redraw = true;
  private perfShown = false;
  private dead = false;
  private readonly components: DetachedComponent[] = [];

  static async boot(canvas: HTMLCanvasElement, root: HTMLElement): Promise<Game> {
    const game = new Game(canvas, root);
    await game.init();
    return game;
  }

  private constructor(private readonly canvas: HTMLCanvasElement, root: HTMLElement) {
    this.ui = createUI(
      root,
      {
        onStart: (mode, id) => void this.start(mode, id),
        onResume: () => this.resume(),
        onRestart: () => void this.start(this.ctx.mode, this.challenge?.id),
        onQuitToMenu: () => void this.quitToMenu(),
        onUiSound: (kind) => {
          if (kind !== 'hover') void this.ctx.audio?.unlock();
          this.ctx.audio?.ui(kind);
        },
      },
      CHALLENGES,
    );
    this.ctx.hud = this.ui.hud;
  }

  // ---------------------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------------------
  private async init(): Promise<void> {
    const { ui, ctx, canvas } = this;
    ui.hud.setVisible(false);
    ui.showLoading(0.02, 'CHECKING GRAPHICS');
    const probe = document.createElement('canvas').getContext('webgl2');
    if (!probe) {
      ui.hideLoading();
      ui.showError('WebGL 2 is not available', 'BREAKPOINT needs a browser with WebGL 2 and hardware acceleration enabled. Current versions of Chrome, Edge, Safari and Firefox all work.');
      this.dead = true;
      return;
    }
    probe.getExtension('WEBGL_lose_context')?.loseContext();

    ui.showLoading(0.05, 'STARTING PHYSICS');
    ctx.physics = await Physics.create();
    ctx.camera = new CameraRig();
    ctx.renderer = new Renderer(canvas, ctx.camera.camera);
    ctx.renderer.setWorldBounds(WORLD_X, WORLD_Z);
    ctx.input = new Input(canvas);
    ctx.audio = createAudio();
    ctx.audio.setMasterVolume(settings.get('volume'));
    ctx.particles = new Particles(ctx.renderer.scene, ctx.renderer.scene.fog as THREE.FogExp2);
    ctx.world = new World(ctx.renderer.materials);
    ctx.renderer.scene.add(ctx.world.group);
    this.resize();

    await ctx.world.generate((v, label) => ui.showLoading(0.1 + v * 0.8, label.toUpperCase()));
    ctx.grid = ctx.world.grid;
    ui.showLoading(0.93, 'RIGGING STRUCTURES');
    ctx.integrity = new StructuralIntegrity(ctx.grid);
    ctx.damage = new DamageSystem(ctx);
    ctx.collapse = new CollapseDirector(ctx);
    ctx.debris = new DebrisManager(ctx);
    ctx.explosions = new ExplosionSystem(ctx);
    ctx.fire = new FireSystem(ctx);
    ctx.player = new PlayerController(ctx);
    ctx.weapons = new WeaponManager(ctx);
    ctx.interaction = new InteractionSystem(ctx);
    ctx.objectives = new ObjectiveSystem(ctx);
    ctx.perf = new PerformanceManager(ctx);
    ctx.objectives.onFinish = (result) => this.showResults(result);
    this.setupEnvironment();
    ctx.weapons.reset(null);

    ctx.input.onLockChange = (locked) => this.onLockChange(locked);
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing' && !this.ctx.input.virtualLock) this.pause();
    });
    settings.subscribe((_s, key) => {
      if (key === null || key === 'volume') ctx.audio.setMasterVolume(settings.get('volume'));
      this.redraw = true;
    });
    this.installDebugApi();

    ui.showLoading(1, 'READY');
    this.showMenu();
    ui.hideLoading();
    this.lastFrame = performance.now();
    requestAnimationFrame(this.loop);
  }

  /** Put every dynamic system back to the state of a freshly generated district. */
  private setupEnvironment(): void {
    const c = this.ctx;
    c.interaction.reset();
    c.debris.clear();
    c.integrity.clear();
    c.collapse.clear();
    c.fire.clear();
    c.particles.clear();
    c.physics.setWorld(c.grid);
    c.explosions.reset(c.world.meta.zones);
    for (const p of c.world.meta.props) c.debris.spawnProp(p);
    for (const d of c.world.meta.doors) c.debris.spawnDoor(d);
    c.debris.freezeSpawned();
    const s = c.world.meta.spawn;
    c.player.spawn(s.x, s.y, s.z, s.yaw);
    c.perf.reset();
    c.time = 0;
    this.sunVis = 1;
    c.renderer.requestShadowUpdate();
  }

  /** Regenerate the voxel world if anything was broken, then reset all dynamic state. */
  private async rebuild(): Promise<void> {
    const { ctx, ui } = this;
    this.state = 'loading';
    if (ctx.world.dirty) {
      ui.showLoading(0, 'CLEARING THE SITE');
      await ctx.world.generate((v, label) => ui.showLoading(v, label.toUpperCase()));
      ui.hideLoading();
    }
    this.setupEnvironment();
  }

  // ---------------------------------------------------------------------------
  // state transitions
  // ---------------------------------------------------------------------------
  private showMenu(): void {
    const { ctx, ui } = this;
    this.state = 'menu';
    ctx.input.exitLock();
    ui.hud.setVisible(false);
    ui.showMainMenu();
    ctx.audio.setPaused(true);
  }

  private async start(mode: GameMode, challengeId?: string): Promise<void> {
    if (this.busy || this.dead) return;
    const { ctx, ui } = this;
    this.busy = true;
    try {
      void ctx.audio.unlock();
      // must happen inside the click that started the run
      ctx.input.requestLock();
      this.challenge = mode === 'challenge' ? (CHALLENGES.find((c) => c.id === challengeId) ?? CHALLENGES[0]) : null;
      ctx.mode = mode;
      ui.hideOverlays();
      await this.rebuild();
      ctx.weapons.reset(this.challenge);
      ctx.objectives.start(this.challenge);
      ui.hud.setModeLabel(this.challenge ? `${this.challenge.code} · ${this.challenge.title.toUpperCase()}` : 'SANDBOX');
      ui.hud.setVisible(true);
      ctx.audio.setPaused(false);
      ctx.audio.startAmbience();
      this.unlockedFor = 0;
      this.state = 'playing';
      ui.hud.toast(this.challenge ? `${this.challenge.targetName}: destroy ${Math.round(this.challenge.targetFraction * 100)} %` : 'Sandbox: everything here can be broken', 'info');
    } finally {
      this.busy = false;
    }
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    const { ctx, ui } = this;
    this.state = 'paused';
    this.pausedAt = performance.now();
    ctx.input.exitLock();
    ctx.input.reset();
    ui.hud.setVisible(false);
    ui.showPause(ctx.mode);
    ctx.audio.setPaused(true);
    this.redraw = true;
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    const { ctx, ui } = this;
    ui.hideOverlays();
    ui.hud.setVisible(true);
    ctx.audio.setPaused(false);
    this.unlockedFor = 0;
    this.state = 'playing';
    ctx.input.requestLock();
  }

  private async quitToMenu(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const { ctx, ui } = this;
      ctx.input.exitLock();
      ui.hideOverlays();
      ui.hud.setVisible(false);
      ctx.audio.stopAmbience();
      this.challenge = null;
      ctx.mode = 'sandbox';
      await this.rebuild();
      ctx.weapons.reset(null);
      ctx.objectives.start(null);
      this.showMenu();
    } finally {
      this.busy = false;
    }
  }

  private showResults(result: ChallengeResult): void {
    const { ctx, ui } = this;
    this.state = 'results';
    ctx.input.exitLock();
    ctx.input.reset();
    ui.hud.setPrompt(null);
    ui.showResults(result);
    ctx.audio.ui(result.passed ? 'success' : 'fail');
  }

  private onLockChange(locked: boolean): void {
    if (locked) {
      this.wasLocked = true;
      this.unlockedFor = 0;
      return;
    }
    // Esc (or a lost lock) while playing opens the pause menu
    if (this.state === 'playing' && !this.ctx.input.virtualLock && this.wasLocked) this.pause();
    this.wasLocked = false;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.code !== 'Escape' || e.repeat) return;
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused' && performance.now() - this.pausedAt > 450) this.resume();
  }

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.ctx.renderer.resize(w, h);
    this.redraw = true;
  }

  // ---------------------------------------------------------------------------
  // frame loop
  // ---------------------------------------------------------------------------
  private readonly loop = (now: number): void => {
    if (this.dead) return;
    requestAnimationFrame(this.loop);
    const live = this.state === 'playing' || this.state === 'results';
    const limit = !live || settings.get('lowPower') || settings.get('frameLimit') === '30' ? 1000 / 30 : settings.get('frameLimit') === '60' ? 1000 / 60 : 0;
    const elapsed = now - this.lastFrame;
    if (limit > 0 && elapsed < limit - 1.5) return;
    this.lastFrame = now;
    const dt = Math.min(elapsed / 1000, 0.1);
    const t0 = performance.now();
    try {
      this.frame(dt);
    } catch (err) {
      this.fatal(err);
      return;
    }
    if (live) this.ctx.perf.update(dt, elapsed, performance.now() - t0);
  };

  private fatal(err: unknown): void {
    this.dead = true;
    console.error('[breakpoint] fatal', err);
    this.ctx.input?.exitLock();
    this.ui.hideOverlays();
    this.ui.showError('Something broke that was not supposed to', err instanceof Error ? `${err.message}` : String(err));
  }

  private frame(dt: number): void {
    const { ctx } = this;
    switch (this.state) {
      case 'loading':
        break;
      case 'menu':
        this.menuFrame(dt);
        break;
      case 'paused':
        // nothing moves: only redraw when the canvas was resized or a setting changed
        if (this.redraw) {
          this.redraw = false;
          ctx.renderer.render(0, true, this.sunVis);
        }
        break;
      case 'playing':
      case 'results':
        this.tick(dt, true);
        break;
    }
    ctx.input.endFrame();
  }

  /** Slow aerial orbit of the district behind the main menu. */
  private menuFrame(dt: number): void {
    const { ctx } = this;
    this.menuAngle += dt * 0.03;
    const cam = ctx.camera.camera;
    const cx = WORLD_X / 2, cz = WORLD_Z / 2;
    cam.position.set(cx + Math.cos(this.menuAngle) * 66, 30, cz + Math.sin(this.menuAngle) * 66);
    cam.lookAt(cx, 3, cz);
    cam.updateMatrixWorld();
    ctx.world.update(cam.position, 500);
    ctx.particles.update(dt, cam);
    ctx.renderer.render(dt, false, 1);
  }

  /** One simulated frame of gameplay. */
  private tick(dt: number, render: boolean): void {
    const c = this.ctx;
    const { input, player, camera, weapons, interaction, physics, debris, integrity, world, renderer } = c;
    c.time += dt;

    if (this.state === 'playing') {
      // the pointer lock can be refused (no gesture, embedded frame): fall back to the pause menu
      if (!input.active) {
        this.unlockedFor += dt;
        if (this.unlockedFor > 0.75) {
          this.pause();
          return;
        }
      }
      if (input.wasPressed('F3')) settings.set('showPerf', !settings.get('showPerf'));
    }
    if (input.active) camera.look(input.mouseDX, input.mouseDY, 1 - weapons.ads * 0.45);

    player.update(dt);
    interaction.update(dt);
    weapons.suppressed = interaction.busy;
    weapons.update(dt);

    physics.step(dt, c.perf.level >= 4 ? 2 : 3, (h) => {
      debris.preStep();
      interaction.preStep(h);
    });
    debris.handleImpacts();

    // structure: whatever lost its support becomes rigid bodies
    this.components.length = 0;
    integrity.solve(c.perf.level >= 2 ? 2.5 : 4, this.components);
    for (const comp of this.components) debris.spawnFromComponent(comp);
    c.collapse.update(dt);
    c.explosions.update(dt);
    c.fire.update(dt);
    debris.update(dt, player.eye);

    if (player.position.y < -20) {
      const s = world.meta.spawn;
      player.teleport(s.x, s.y + 0.05, s.z);
    }

    world.update(player.eye, settings.get('renderDistance'), c.perf.level >= 3 ? 4 : 6);
    c.particles.update(dt, camera.camera);
    camera.update(dt, player.eye, player.speed, player.onGround, player.strafe);
    const cam = camera.camera;
    cam.getWorldDirection(vFwd);
    vUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
    c.audio.setListener(cam.position, vFwd, vUp);
    c.audio.update(dt);
    if (this.state === 'playing') c.objectives.update(dt);

    if (settings.get('showPerf')) {
      const p = c.perf.hud(dt);
      if (p) c.hud.setPerf(p);
      this.perfShown = true;
    } else if (this.perfShown) {
      this.perfShown = false;
      c.hud.setPerf(null);
    }

    if (!render) return;
    // is the player standing in direct sunlight? (lights the first-person model)
    const lit = !c.grid.raycast(cam.position.x, cam.position.y, cam.position.z, SUN_DIR.x, SUN_DIR.y, SUN_DIR.z, 45, 0, sunHit);
    this.sunVis = damp(this.sunVis, lit ? 1 : 0, 6, dt);
    const moving = debris.awake > 0 || debris.light.active > 0 || world.remeshedThisFrame > 0;
    renderer.chroma = camera.trauma;
    renderer.render(dt, moving, this.sunVis);
  }

  // ---------------------------------------------------------------------------
  // automation / diagnostics (used by the QA scripts; harmless in normal play)
  // ---------------------------------------------------------------------------
  private installDebugApi(): void {
    const c = this.ctx;
    const api = {
      game: this,
      ctx: c,
      THREE,
      RAPIER,
      state: () => this.state,
      /** Accept input without pointer lock (automation). */
      auto: (on = true) => {
        c.input.virtualLock = on;
        return on;
      },
      start: (mode: GameMode = 'sandbox', id?: string) => this.start(mode, id),
      menu: () => this.quitToMenu(),
      /** Run the simulation for a number of seconds at a fixed 60 Hz, independent of the display. */
      advance: (seconds: number) => {
        const n = Math.max(1, Math.round(seconds * 60));
        let worst = 0;
        const t0 = performance.now();
        for (let i = 0; i < n && (this.state === 'playing' || this.state === 'results'); i++) {
          const s = performance.now();
          this.tick(1 / 60, i === n - 1);
          c.input.endFrame();
          worst = Math.max(worst, performance.now() - s);
        }
        return { frames: n, avgMs: (performance.now() - t0) / n, worstMs: worst };
      },
      tp: (x: number, y: number, z: number, yaw?: number, pitch?: number) => {
        c.player.teleport(x, y, z);
        if (yaw !== undefined) c.camera.yaw = yaw;
        if (pitch !== undefined) c.camera.pitch = pitch;
      },
      look: (yaw: number, pitch: number) => {
        c.camera.yaw = yaw;
        c.camera.pitch = pitch;
      },
      stats: () => {
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        const info = c.renderer.gl.info;
        return {
          state: this.state,
          fps: Math.round(c.perf.fps),
          frameMs: +c.perf.frameMs.toFixed(2),
          worstMs: +c.perf.worstMs.toFixed(1),
          cpuMs: +c.perf.cpuMs.toFixed(2),
          physicsMs: +c.physics.stepMs.toFixed(2),
          level: c.perf.level,
          renderScale: c.renderer.getRenderScale(),
          bodies: c.debris.bodies.length,
          awake: c.debris.awake,
          lightDebris: c.debris.light.active,
          particles: c.particles.count,
          burning: c.fire.burning,
          removed: c.grid.removedTotal,
          cracked: c.grid.damage.size,
          pendingSeeds: c.integrity.pending,
          pendingRemesh: c.world.pendingRemesh,
          collapses: c.debris.collapses,
          failures: c.collapse.failures,
          explosions: c.explosions.count,
          chunks: c.world.chunkCount,
          worldTriangles: c.world.triangles,
          drawCalls: info.render.calls,
          triangles: info.render.triangles,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          heapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
          pos: [+c.player.position.x.toFixed(2), +c.player.position.y.toFixed(2), +c.player.position.z.toFixed(2)],
          onGround: c.player.onGround,
          weapon: c.weapons.current.id,
        };
      },
      /** Render real frames back to back and wait for the GPU each time (works in a throttled tab). */
      bench: (frames = 60) => {
        const gl = c.renderer.gl.getContext();
        let worst = 0;
        const t0 = performance.now();
        for (let i = 0; i < frames && this.state === 'playing'; i++) {
          const s = performance.now();
          this.tick(1 / 60, true);
          c.input.endFrame();
          gl.finish();
          worst = Math.max(worst, performance.now() - s);
        }
        const avg = (performance.now() - t0) / frames;
        return { frames, avgMs: +avg.toFixed(2), worstMs: +worst.toFixed(1), fps: Math.round(1000 / avg), pixels: `${this.canvas.width}x${this.canvas.height}` };
      },
      /** Save the current view as previews/<name>.png through the dev server. */
      shot: async (name: string) => {
        if (this.state === 'menu') this.menuFrame(0);
        else c.renderer.render(0, true, this.sunVis);
        const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, 'image/png'));
        if (!blob) return 'no image';
        const res = await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
        return res.ok ? res.text() : `failed: ${res.status}`;
      },
    };
    (window as unknown as { __bp: typeof api }).__bp = api;
  }
}
