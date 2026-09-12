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

/* ------------------------------------------------------------------ */
/* Streaming mesh extraction                                         */
/* ------------------------------------------------------------------ */

// three's 3MFLoader reads each .model part as a single JS string, which V8
// caps at ~512 MB ("Cannot create a string longer than 0x1fffffe8
// characters"). For meshes larger than that we scan the raw XML byte stream
// in chunks and never build the whole string. Only <vertex>/<triangle> and
// the structural <object>/<component> tags are matched; everything else
// (including <metadata> text that may contain stray ">") is skipped.
const STREAM_CARRY = 1024
const STREAM_CHUNK = 1 << 20
const STREAM_TAG_RE = /<object\b[^>]*\/?>|<\/object>|<component\b[^>]*\/>|<vertex\b[^>]*\/>|<triangle\b[^>]*\/>/g

function growable (Construct, initial = 1 << 16) {
  let buffer = new Construct(initial)
  let length = 0
  return {
    get length () { return length },
    push (value) {
      if (length === buffer.length) {
        const next = new Construct(buffer.length * 2)
        next.set(buffer)
        buffer = next
      }
      buffer[length++] = value
    },
    push3 (a, b, c) {
      this.push(a)
      this.push(b)
      this.push(c)
    },
    snapshot () {
      return buffer.slice(0, length)
    }
  }
}

function streamAttrNum (text, name) {
  const match = new RegExp(`\\b${name}="(-?[0-9.]+(?:[eE][-+]?[0-9]+)?)"`).exec(text)
  return match ? parseFloat(match[1]) : null
}

function streamAttrTransform (text) {
  const match = /\btransform="([^"]+)"/.exec(text)
  if (!match) return null
  const nums = match[1].trim().split(/\s+/).map(Number)
  if (nums.length !== 12 && nums.length !== 16) return null
  const matrix = new THREE.Matrix4()
  if (nums.length === 16) matrix.set(
    nums[0], nums[4], nums[8], nums[12],
    nums[1], nums[5], nums[9], nums[13],
    nums[2], nums[6], nums[10], nums[14],
    nums[3], nums[7], nums[11], nums[15]
  )
  else matrix.set(
    nums[0], nums[3], nums[6], nums[9],
    nums[1], nums[4], nums[7], nums[10],
    nums[2], nums[5], nums[8], nums[11],
    0, 0, 0, 1
  )
  return matrix
}

/**
 * Extract every object's mesh from a .model part without materialising the
 * full XML as a JS string.
 *
 * @param {object} entry a JSZip entry with async('nodebuffer')
 * @returns {Promise<Map<number,{positions:Float32Array,triangles:Uint32Array,transform:THREE.Matrix4|null,components:Array}>>}
 */
export async function streamMeshObjects (entry) {
  const bytes = await entry.async('nodebuffer')
  const decoder = new TextDecoder('utf-8')
  const objects = new Map()
  let current = null
  let carry = ''

  const scan = (text) => {
    let cut = 0
    for (const match of text.matchAll(STREAM_TAG_RE)) {
      const tag = match[0]
      cut = Math.max(cut, match.index + tag.length)

      if (tag === '</object>') {
        current = null
        continue
      }
      if (tag.startsWith('<object ')) {
        const id = streamAttrNum(tag, 'id')
        if (tag.endsWith('/>') || id == null) continue
        current = {
          positions: growable(Float32Array),
          triangles: growable(Uint32Array),
          transform: streamAttrTransform(tag),
          components: []
        }
        objects.set(id, current)
        continue
      }
      if (tag.startsWith('<vertex ')) {
        if (!current) continue
        current.positions.push3(
          streamAttrNum(tag, 'x'),
          streamAttrNum(tag, 'y'),
          streamAttrNum(tag, 'z')
        )
        continue
      }
      if (tag.startsWith('<triangle ')) {
        if (!current) continue
        current.triangles.push3(
          streamAttrNum(tag, 'v1'),
          streamAttrNum(tag, 'v2'),
          streamAttrNum(tag, 'v3')
        )
        continue
      }
      if (tag.startsWith('<component ')) {
        if (!current) continue
        const objectId = streamAttrNum(tag, 'objectid')
        if (objectId == null) continue
        const path = /(?:\bp:)?path="([^"]*)"/.exec(tag)
        current.components.push({
          objectId,
          path: path ? path[1] : null,
          transform: streamAttrTransform(tag)
        })
      }
    }
    // Everything after the last complete tag is partial/non-tag text and must
    // be carried to the next chunk verbatim, so a tag split across the chunk
    // boundary is never lost. If a window has no complete tag at all (e.g. a
    // long <metadata> body), fall back to keeping a bounded tail.
    if (cut > 0) return text.slice(cut)
    return text.slice(Math.max(0, text.length - STREAM_CARRY))
  }

  for (let offset = 0; offset < bytes.length; offset += STREAM_CHUNK) {
    carry = scan(carry + decoder.decode(bytes.subarray(offset, offset + STREAM_CHUNK), { stream: true }))
  }
  carry = scan(carry + decoder.decode())

  for (const object of objects.values()) {
    object.positions = object.positions.snapshot()
    object.triangles = object.triangles.snapshot()
  }
  return objects
}

/**
 * Volume, surface area and bounding box of a triangle mesh in *world*
 * coordinates, measured without allocating per-vertex vectors. `positions`
 * is a flat (x,y,z, …) Float32Array and `triangles` a flat Uint32Array of
 * vertex indices, both as produced by `streamMeshObjects`. `matrix` is the
 * instance's composed world matrix; `unitScale` converts the model's unit to
 * millimetres when it is not millimeter.
 *
 * @returns {{volume:number, area:number, min:{x,y,z}, max:{x,y,z}}}
 */
export function accumulateMeshMeasurement (positions, triangles, matrix, unitScale = 1) {
  const e = matrix.elements
  const triangleCount = triangles.length / 3
  let volume = 0
  let area = 0
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity

  for (let t = 0; t < triangleCount; t++) {
    const i0 = triangles[t * 3] * 3
    const i1 = triangles[t * 3 + 1] * 3
    const i2 = triangles[t * 3 + 2] * 3

    const px = positions[i0]
    const py = positions[i0 + 1]
    const pz = positions[i0 + 2]
    const ax = (e[0] * px + e[4] * py + e[8] * pz + e[12]) * unitScale
    const ay = (e[1] * px + e[5] * py + e[9] * pz + e[13]) * unitScale
    const az = (e[2] * px + e[6] * py + e[10] * pz + e[14]) * unitScale

    const qx = positions[i1]
    const qy = positions[i1 + 1]
    const qz = positions[i1 + 2]
    const bx = (e[0] * qx + e[4] * qy + e[8] * qz + e[12]) * unitScale
    const by = (e[1] * qx + e[5] * qy + e[9] * qz + e[13]) * unitScale
    const bz = (e[2] * qx + e[6] * qy + e[10] * qz + e[14]) * unitScale

    const rx = positions[i2]
    const ry = positions[i2 + 1]
    const rz = positions[i2 + 2]
    const cx = (e[0] * rx + e[4] * ry + e[8] * rz + e[12]) * unitScale
    const cy = (e[1] * rx + e[5] * ry + e[9] * rz + e[13]) * unitScale
    const cz = (e[2] * rx + e[6] * ry + e[10] * rz + e[14]) * unitScale

    const vx = by * cz - bz * cy
    const vy = bz * cx - bx * cz
    const vz = bx * cy - by * cx
    volume += ax * vx + ay * vy + az * vz

    const ux = bx - ax
    const uy = by - ay
    const uz = bz - az
    const wx = cx - ax
    const wy = cy - ay
    const wz = cz - az
    const nx = uy * wz - uz * wy
    const ny = uz * wx - ux * wz
    const nz = ux * wy - uy * wx
    area += Math.hypot(nx, ny, nz)

    if (ax < minX) minX = ax
    if (ay < minY) minY = ay
    if (az < minZ) minZ = az
    if (bx < minX) minX = bx
    if (by < minY) minY = by
    if (bz < minZ) minZ = bz
    if (cx < minX) minX = cx
    if (cy < minY) minY = cy
    if (cz < minZ) minZ = cz
    if (ax > maxX) maxX = ax
    if (ay > maxY) maxY = ay
    if (az > maxZ) maxZ = az
    if (bx > maxX) maxX = bx
    if (by > maxY) maxY = by
    if (bz > maxZ) maxZ = bz
    if (cx > maxX) maxX = cx
    if (cy > maxY) maxY = cy
    if (cz > maxZ) maxZ = cz
  }

  return {
    volume: Math.abs(volume) / 6,
    area: area / 2,
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ }
  }
}
