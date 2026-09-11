import * as THREE from 'three'

/**
 * Volume of a closed triangle mesh via the divergence theorem.
 *
 * For every triangle (a, b, c) the scalar triple product
 *     a · (b × c) / 6
 * is the SIGNED volume of the tetrahedron spanned by that triangle and the
 * world origin. Summing it over the whole surface makes tetrahedra on opposite
 * sides of the origin cancel out, so the absolute total equals the volume
 * enclosed by the mesh. The result is exact for a closed, consistently wound
 * triangulation and does not depend on where the origin sits.
 *
 * Reasons this can be slightly off in practice:
 *  - open / self-intersecting meshes (the cancellation is incomplete)
 *  - duplicated or flipped triangles
 *
 * 3MF coordinates are defined in millimetres, so the returned value is in mm³.
 * Divide by 1000 for cm³.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Matrix4|null} matrixWorld transform applied to each vertex
 * @returns {number} enclosed volume in mm³
 */
export function computeMeshVolume (geometry, matrixWorld = null) {
  const position = geometry.getAttribute('position')
  if (!position) return 0

  const index = geometry.index
  const triangleCount = index ? index.count / 3 : position.count / 3
  if (!triangleCount) return 0

  let volume = 0
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const cross = new THREE.Vector3()

  for (let i = 0; i < triangleCount; i++) {
    const ia = index ? index.getX(i * 3) : i * 3
    const ib = index ? index.getX(i * 3 + 1) : i * 3 + 1
    const ic = index ? index.getX(i * 3 + 2) : i * 3 + 2

    a.fromBufferAttribute(position, ia)
    b.fromBufferAttribute(position, ib)
    c.fromBufferAttribute(position, ic)

    if (matrixWorld) {
      a.applyMatrix4(matrixWorld)
      b.applyMatrix4(matrixWorld)
      c.applyMatrix4(matrixWorld)
    }

    cross.crossVectors(b, c)
    volume += a.dot(cross)
  }

  return Math.abs(volume) / 6
}

/**
 * Surface area of a triangle mesh in mm² (half the cross product norm of each
 * triangle). The estimate model uses it to separate the solid outer shell
 * (perimeter walls + top/bottom skins) from the infilled interior.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Matrix4|null} matrixWorld
 * @returns {number} surface area in mm²
 */
export function computeMeshSurfaceArea (geometry, matrixWorld = null) {
  const position = geometry.getAttribute('position')
  if (!position) return 0

  const index = geometry.index
  const triangleCount = index ? index.count / 3 : position.count / 3
  if (!triangleCount) return 0

  let area = 0
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const cross = new THREE.Vector3()

  for (let i = 0; i < triangleCount; i++) {
    const ia = index ? index.getX(i * 3) : i * 3
    const ib = index ? index.getX(i * 3 + 1) : i * 3 + 1
    const ic = index ? index.getX(i * 3 + 2) : i * 3 + 2

    a.fromBufferAttribute(position, ia)
    b.fromBufferAttribute(position, ib)
    c.fromBufferAttribute(position, ic)

    if (matrixWorld) {
      a.applyMatrix4(matrixWorld)
      b.applyMatrix4(matrixWorld)
      c.applyMatrix4(matrixWorld)
    }

    ab.subVectors(b, a)
    ac.subVectors(c, a)
    cross.crossVectors(ab, ac)
    area += cross.length()
  }

  return area / 2
}

/**
 * Walk a loaded three.js 3MF Group, summing mesh volumes and measuring the
 * overall axis-aligned bounding box (in millimetres).
 *
 * 3MFLoader bakes the 3MF build/component transforms onto each object's local
 * matrix, so world matrices are required to get correct geometry.
 *
 * @param {THREE.Object3D} group result of ThreeMFLoader().parse()
 * @returns {{ volumeMm3:number, volumeCm3:number, surfaceAreaMm2:number, meshCount:number, bbox:null|{x:number,y:number,z:number} }}
 */
export function computeGroupAnalysis (group) {
  group.updateMatrixWorld(true)

  let volumeMm3 = 0
  let surfaceAreaMm2 = 0
  let meshCount = 0

  group.traverse((object) => {
    if (!object.isMesh || !object.geometry) return
    volumeMm3 += computeMeshVolume(object.geometry, object.matrixWorld)
    surfaceAreaMm2 += computeMeshSurfaceArea(object.geometry, object.matrixWorld)
    meshCount++
  })

  const box = new THREE.Box3().setFromObject(group)
  const size = new THREE.Vector3()
  box.getSize(size)

  const valid = meshCount > 0 && isFinite(size.x) && (box.max.x - box.min.x) >= 0

  return {
    volumeMm3,
    volumeCm3: volumeMm3 / 1000,
    surfaceAreaMm2,
    meshCount,
    bbox: valid ? { x: size.x, y: size.y, z: size.z } : null
  }
}
