/**
 * Shared GPU materials for all voxel geometry (world chunks, debris bodies, props).
 * A single texture array holds one procedural layer per material; UVs are derived from
 * the object-space voxel position so no UV attribute is needed and greedy quads tile
 * correctly.
 */
import * as THREE from 'three';
import { buildMaterialAtlas, buildMaterialParams, MAT_COUNT, TEX_PERIOD, TEX_SIZE } from '../world/Materials';
import type { MeshData } from '../destruction/VoxelMesher';

export interface VoxelMaterials {
  opaque: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  atlas: THREE.DataArrayTexture;
  dispose(): void;
}

export function createVoxelMaterials(anisotropy: number): VoxelMaterials {
  const atlas = new THREE.DataArrayTexture(buildMaterialAtlas(), TEX_SIZE, TEX_SIZE, MAT_COUNT);
  atlas.format = THREE.RGBAFormat;
  atlas.type = THREE.UnsignedByteType;
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.wrapS = atlas.wrapT = THREE.RepeatWrapping;
  atlas.magFilter = THREE.NearestFilter;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;
  atlas.anisotropy = anisotropy;
  atlas.needsUpdate = true;
  const params = buildMaterialParams();

  const opaque = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  opaque.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlas = { value: atlas };
    shader.uniforms.uMatParams = { value: params };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aData;\nvarying vec3 vVoxPos;\nvarying vec3 vVoxNrm;\nvarying vec3 vVoxData;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvVoxPos = position;\nvVoxNrm = normal;\nvVoxData = aData.xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
uniform vec3 uMatParams[${MAT_COUNT}];
varying vec3 vVoxPos;
varying vec3 vVoxNrm;
varying vec3 vVoxData;`,
      )
      .replace(
        '#include <map_fragment>',
        `vec3 voxAbsN = abs(vVoxNrm);
vec2 voxUv = voxAbsN.x > 0.5 ? vVoxPos.zy : (voxAbsN.y > 0.5 ? vVoxPos.xz : vVoxPos.xy);
float voxLayer = floor(vVoxData.x + 0.5);
vec4 voxTex = texture(uAtlas, vec3(voxUv / ${TEX_PERIOD.toFixed(1)}, voxLayer));
vec3 voxParams = uMatParams[int(voxLayer)];
float voxAo = vVoxData.y / 255.0;
float voxDmg = vVoxData.z / 255.0;
diffuseColor.rgb *= voxTex.rgb;
if (voxDmg > 0.01) {
  vec3 q = floor(vVoxPos * 8.0 - vVoxNrm * 0.5);
  float h = fract(sin(dot(q, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float crack = step(1.0 - voxDmg * 0.45, h);
  diffuseColor.rgb *= mix(1.0, 0.3, crack) * (1.0 - voxDmg * 0.25);
}`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(voxParams.x * voxTex.a, 0.04, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = voxParams.y;')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += voxTex.rgb * voxParams.z;')
      .replace(
        '#include <aomap_fragment>',
        `float voxOcc = mix(0.34, 1.0, voxAo * voxAo);
reflectedLight.indirectDiffuse *= voxOcc;
reflectedLight.indirectSpecular *= voxOcc;
reflectedLight.directDiffuse *= mix(0.72, 1.0, voxAo);`,
      );
  };
  opaque.customProgramCacheKey = () => 'bp-voxel-opaque';

  const glass = new THREE.MeshStandardMaterial({
    color: 0x9fd0d8,
    roughness: 0.04,
    metalness: 0.0,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    envMapIntensity: 2.2,
  });
  glass.onBeforeCompile = (shader) => {
    // Fresnel: glass turns opaque and mirror-like at grazing angles.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
float glassFres = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 3.0);
gl_FragColor.a = mix(0.2, 0.88, glassFres);`,
    );
  };
  glass.customProgramCacheKey = () => 'bp-voxel-glass';

  return {
    opaque,
    glass,
    atlas,
    dispose() {
      atlas.dispose();
      opaque.dispose();
      glass.dispose();
    },
  };
}

/** Wrap mesher output in a BufferGeometry. Bounds are supplied by the caller (voxel units). */
export function geometryFromMesh(md: MeshData, sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(md.positions, 3, false));
  g.setAttribute('normal', new THREE.BufferAttribute(md.normals, 3, true));
  g.setAttribute('aData', new THREE.BufferAttribute(md.data, 4, false));
  g.setIndex(new THREE.BufferAttribute(md.indices, 1));
  const cx = ox + sx / 2;
  const cy = oy + sy / 2;
  const cz = oz + sz / 2;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(ox, oy, oz), new THREE.Vector3(ox + sx, oy + sy, oz + sz));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), Math.sqrt(sx * sx + sy * sy + sz * sz) / 2);
  return g;
}
