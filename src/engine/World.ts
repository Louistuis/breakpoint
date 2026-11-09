/**
 * The voxel world as the rest of the engine sees it: owns the grid, the chunk meshes and
 * the (re)generation pipeline. Only chunks flagged dirty by the grid are re-meshed, a
 * few per frame, nearest to the player first.
 */
import * as THREE from 'three';
import { CHUNK, VoxelGrid } from '../destruction/VoxelGrid';
import { VoxelChunk } from '../destruction/VoxelChunk';
import { chunkDamagePad, chunkPad, fillChunkPad, meshVolume } from '../destruction/VoxelMesher';
import { MAT_HP } from '../world/Materials';
import { LIMITS } from '../world/config';
import { WORLD_SEED, type WorldMeta } from '../world/WorldGenerator';
import type { WorldGenMessage } from '../world/worldgen.worker';
import type { VoxelMaterials } from './VoxelMaterial';

export class World {
  grid!: VoxelGrid;
  meta!: WorldMeta;
  surface!: Int32Array;
  readonly group = new THREE.Group();
  private chunks: (VoxelChunk | null)[] = [];
  /** True once any voxel has changed since the last (re)generation. */
  modified = false;
  remeshedThisFrame = 0;
  chunkCount = 0;
  triangles = 0;
  private generatedVersion = 0;

  constructor(private readonly materials: VoxelMaterials) {
    this.group.matrixAutoUpdate = false;
  }

  /** Generate (or regenerate) the district in a worker and build its meshes. */
  generate(onProgress: (value: number, label: string) => void): Promise<{ floating: number; ms: number }> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../world/worldgen.worker.ts', import.meta.url), { type: 'module' });
      worker.onerror = (err) => {
        worker.terminate();
        reject(new Error(err.message || 'world generation failed'));
      };
      worker.onmessage = (e: MessageEvent<WorldGenMessage>) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          onProgress(msg.value, msg.label);
          return;
        }
        worker.terminate();
        this.disposeChunks();
        if (this.grid && this.grid.data.length === msg.data.length) {
          // reset: keep the same grid object so every system's reference stays valid
          this.grid.data.set(msg.data);
          this.grid.damage.clear();
          this.grid.dirtyChunks.length = 0;
          this.grid.chunkDirty.fill(0);
          this.grid.removedTotal = 0;
          this.grid.version++;
        } else {
          this.grid = new VoxelGrid(msg.nx, msg.ny, msg.nz, msg.data);
        }
        this.meta = msg.meta;
        this.surface = msg.surface;
        const g = this.grid;
        this.chunks = new Array(g.cnx * g.cny * g.cnz).fill(null);
        for (const packet of msg.chunks) {
          const chunk = this.chunkAt(packet.index);
          chunk.setMesh(packet.mesh, this.materials, this.group);
        }
        this.recount();
        this.modified = false;
        this.generatedVersion = g.version;
        onProgress(1, 'READY');
        resolve({ floating: msg.floating, ms: msg.ms });
      };
      worker.postMessage({ seed: WORLD_SEED });
    });
  }

  private chunkAt(index: number): VoxelChunk {
    let c = this.chunks[index];
    if (!c) {
      const g = this.grid;
      const cx = index % g.cnx;
      const cz = Math.floor(index / g.cnx) % g.cnz;
      const cy = Math.floor(index / (g.cnx * g.cnz));
      c = new VoxelChunk(index, cx, cy, cz);
      this.chunks[index] = c;
    }
    return c;
  }

  private recount(): void {
    let n = 0;
    let t = 0;
    for (const c of this.chunks) {
      if (c && (c.opaque || c.glass)) {
        n++;
        t += c.triangles;
      }
    }
    this.chunkCount = n;
    this.triangles = t;
  }

  /**
   * Re-mesh dirty chunks (nearest first, bounded per frame) and apply render-distance
   * culling. Returns the number of chunks rebuilt.
   */
  update(viewer: THREE.Vector3, renderDistance: number, budget: number = LIMITS.remeshPerFrame, maxMs = 5): number {
    const g = this.grid;
    if (g.version !== this.generatedVersion) this.modified = true;
    const dirty = g.dirtyChunks;
    let rebuilt = 0;
    if (dirty.length > 0) {
      if (dirty.length > budget) {
        // nearest chunks first so the hole in front of the player appears immediately
        const dist = (index: number) => {
          const cx = index % g.cnx;
          const cz = Math.floor(index / g.cnx) % g.cnz;
          const cy = Math.floor(index / (g.cnx * g.cnz));
          const dx = (cx + 0.5) * CHUNK * 0.2 - viewer.x;
          const dy = (cy + 0.5) * CHUNK * 0.2 - viewer.y;
          const dz = (cz + 0.5) * CHUNK * 0.2 - viewer.z;
          return dx * dx + dy * dy + dz * dz;
        };
        dirty.sort((a, b) => dist(b) - dist(a));
      }
      const started = performance.now();
      // bounded by count and by time: a big blast spreads its re-meshing over a few frames
      while (dirty.length > 0 && rebuilt < budget && (rebuilt === 0 || performance.now() - started < maxMs)) {
        const index = dirty.pop()!;
        g.chunkDirty[index] = 0;
        const chunk = this.chunkAt(index);
        const { solid, hasDamage } = fillChunkPad(g, chunk.cx, chunk.cy, chunk.cz, MAT_HP);
        chunk.setMesh(solid > 0 ? meshVolume(chunkPad, hasDamage ? chunkDamagePad : null, CHUNK, CHUNK, CHUNK) : null, this.materials, this.group);
        rebuilt++;
      }
      this.recount();
    }
    this.remeshedThisFrame = rebuilt;
    // distance culling (chunk streaming of GPU work; voxel data itself is only ~26 MB)
    const r = renderDistance + CHUNK * 0.2;
    const r2 = r * r;
    for (const c of this.chunks) {
      if (!c || (!c.opaque && !c.glass)) continue;
      const dx = c.center.x - viewer.x;
      const dz = c.center.z - viewer.z;
      c.setVisible(dx * dx + dz * dz < r2);
    }
    return rebuilt;
  }

  /** True when the voxel data differs from a freshly generated district (holes, cracks, rubble). */
  get dirty(): boolean {
    return this.grid.version !== this.generatedVersion || this.grid.damage.size > 0;
  }

  get pendingRemesh(): number {
    return this.grid ? this.grid.dirtyChunks.length : 0;
  }

  private disposeChunks(): void {
    for (const c of this.chunks) c?.dispose(this.group);
    this.chunks = [];
  }

  dispose(): void {
    this.disposeChunks();
  }
}
