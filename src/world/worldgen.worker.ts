/// <reference lib="webworker" />
/**
 * World-generation worker: builds the voxel district, removes anything left floating,
 * extracts the collision surface and meshes every chunk, then transfers all buffers to
 * the main thread without copying. Keeps the multi-hundred-millisecond start-up / reset
 * cost off the UI thread; it is idle (terminated) during play.
 */
import { CHUNK, VoxelGrid } from '../destruction/VoxelGrid';
import { chunkPad, fillChunkPad, meshVolume, type VolumeMesh } from '../destruction/VoxelMesher';
import { StructuralIntegrity } from '../destruction/StructuralIntegrity';
import { MAT_HP } from './Materials';
import { WORLD_NX, WORLD_NY, WORLD_NZ } from './config';
import { generateWorld, type WorldMeta } from './WorldGenerator';

export interface WorldGenRequest {
  seed: number;
}
export interface ChunkMeshPacket {
  index: number;
  mesh: VolumeMesh;
}
export type WorldGenMessage =
  | { type: 'progress'; value: number; label: string }
  | { type: 'done'; nx: number; ny: number; nz: number; data: Uint8Array; surface: Int32Array; meta: WorldMeta; chunks: ChunkMeshPacket[]; floating: number; ms: number };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<WorldGenRequest>) => {
  const t0 = performance.now();
  const post = (m: WorldGenMessage, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);
  post({ type: 'progress', value: 0.05, label: 'SURVEYING DISTRICT' });
  const grid = new VoxelGrid(WORLD_NX, WORLD_NY, WORLD_NZ);
  const meta = generateWorld(grid, e.data.seed);
  post({ type: 'progress', value: 0.3, label: 'CHECKING STRUCTURES' });
  const floating = new StructuralIntegrity(grid).removeFloating();
  const surface = new Int32Array(0);
  const chunks: ChunkMeshPacket[] = [];
  const transfer: Transferable[] = [grid.data.buffer, surface.buffer];
  const total = grid.cnx * grid.cny * grid.cnz;
  let done = 0;
  for (let cy = 0; cy < grid.cny; cy++)
    for (let cz = 0; cz < grid.cnz; cz++)
      for (let cx = 0; cx < grid.cnx; cx++) {
        const { solid } = fillChunkPad(grid, cx, cy, cz, MAT_HP);
        if (solid > 0) {
          const mesh = meshVolume(chunkPad, null, CHUNK, CHUNK, CHUNK);
          for (const part of [mesh.opaque, mesh.glass]) {
            if (part) transfer.push(part.positions.buffer, part.normals.buffer, part.data.buffer, part.indices.buffer);
          }
          if (mesh.opaque || mesh.glass) chunks.push({ index: grid.chunkIndex(cx, cy, cz), mesh });
        }
        if (++done % 64 === 0) post({ type: 'progress', value: 0.4 + 0.55 * (done / total), label: 'MESHING DISTRICT' });
      }
  post({ type: 'done', nx: grid.nx, ny: grid.ny, nz: grid.nz, data: grid.data, surface, meta, chunks, floating, ms: performance.now() - t0 }, transfer);
};
