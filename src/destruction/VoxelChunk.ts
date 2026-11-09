/**
 * Render-side state of one 32³ chunk: its opaque and glass meshes. Voxel data lives in
 * the VoxelGrid; a chunk is only a unit of meshing, culling and dirty tracking.
 */
import * as THREE from 'three';
import { VOXEL } from '../world/Materials';
import { geometryFromMesh, type VoxelMaterials } from '../engine/VoxelMaterial';
import { CHUNK } from './VoxelGrid';
import type { MeshData, VolumeMesh } from './VoxelMesher';

export class VoxelChunk {
  opaque: THREE.Mesh | null = null;
  glass: THREE.Mesh | null = null;
  readonly center = new THREE.Vector3();
  triangles = 0;

  constructor(readonly index: number, readonly cx: number, readonly cy: number, readonly cz: number) {
    this.center.set((cx + 0.5) * CHUNK * VOXEL, (cy + 0.5) * CHUNK * VOXEL, (cz + 0.5) * CHUNK * VOXEL);
  }

  private makeMesh(md: MeshData, material: THREE.Material, glass: boolean): THREE.Mesh {
    const mesh = new THREE.Mesh(geometryFromMesh(md, CHUNK, CHUNK, CHUNK), material);
    mesh.position.set(this.cx * CHUNK * VOXEL, this.cy * CHUNK * VOXEL, this.cz * CHUNK * VOXEL);
    mesh.scale.setScalar(VOXEL);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.castShadow = !glass;
    mesh.receiveShadow = !glass;
    if (glass) mesh.renderOrder = 2;
    return mesh;
  }

  /** Replace the chunk's meshes. Old GPU buffers are released immediately. */
  setMesh(vm: VolumeMesh | null, materials: VoxelMaterials, parent: THREE.Object3D): void {
    this.dispose(parent);
    if (!vm) return;
    if (vm.opaque) {
      this.opaque = this.makeMesh(vm.opaque, materials.opaque, false);
      parent.add(this.opaque);
      this.triangles += vm.opaque.indices.length / 3;
    }
    if (vm.glass) {
      this.glass = this.makeMesh(vm.glass, materials.glass, true);
      parent.add(this.glass);
      this.triangles += vm.glass.indices.length / 3;
    }
  }

  setVisible(v: boolean): void {
    if (this.opaque) this.opaque.visible = v;
    if (this.glass) this.glass.visible = v;
  }

  dispose(parent: THREE.Object3D): void {
    for (const m of [this.opaque, this.glass]) {
      if (!m) continue;
      parent.remove(m);
      m.geometry.dispose();
    }
    this.opaque = this.glass = null;
    this.triangles = 0;
  }
}
