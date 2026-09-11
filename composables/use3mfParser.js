import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { computeGroupAnalysis } from './useMeshVolume.js'

const MODEL_RE = /\.model$/i
const MESH_RE = /\.(stl|obj)$/i
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|ico)$/i
const GCODE_RE = /\.gcode$/i
const XML_RE = /\.(xml|config|rels|metadata|txt)$/i
const MAX_TEXT_BYTES = 150 * 1024 * 1024
const MAX_SCAN_CHARS = 16 * 1024 * 1024

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true
})

/**
 * Slicer weight/length lines found in G-code. These are reported by the slicer
 * itself and are far more accurate than a geometric estimate.
 */
const TEXT_PATTERNS = [
  { kind: 'weight', scope: 'total', label: 'total_weight', re: /total[_ ]?weight\s*[=:]\s*([0-9]*\.?[0-9]+)/i },
  { kind: 'weight', scope: 'total', label: 'total_filament_weight', re: /total\s+filament\s+weight\s*\[?g?\]?\s*[=:]\s*([0-9]*\.?[0-9]+)/i },
  { kind: 'weight', scope: 'total', label: 'total_filament_used_g', re: /total\s+filament\s+used\s*\[?g\]?\s*[=:]\s*([0-9]*\.?[0-9]+)/i },
  { kind: 'weight', scope: 'part', label: 'filament_used_g', re: /filament\s+used\s*\[?g\]?\s*[=:]\s*([0-9]*\.?[0-9]+)/i },
  { kind: 'weight', scope: 'part', label: 'filament_weight', re: /filament[_ ]weight\s*[=:]\s*([0-9]*\.?[0-9]+)/i },
  { kind: 'length', scope: 'total', label: 'total_filament_used_m', re: /total\s+filament\s+(?:used\s*\[?m\]?|length)\s*[=:]\s*([0-9]*\.?[0-9]+)/i },
  { kind: 'length', scope: 'part', label: 'filament_used_m', re: /filament\s+(?:used\s*\[?m\]?|length)\s*[=:]\s*([0-9]*\.?[0-9]+)/i },
  { kind: 'volume', scope: 'part', label: 'filament_used_mm3', re: /filament\s+used\s*\[?mm3?\]?\s*[=:]\s*([0-9]*\.?[0-9]+)/i }
]

/**
 * G-code comment headings that lead a whole-print duration line, e.g.
 * Prusa "estimated printing time (normal mode) = 2h 14m 31s", Cura ";TIME:21598"
 * (seconds), Bambu "; total_duration = 8071" (seconds).
 */
const TIME_HEADING_RE = /(?:^|;\s*)\s*(?:estimated\s+printing\s+time|total[_ ]?(?:duration|time)|printing\s+time|print\s+time|estimated\s+time|slice\s+time)\b/i
const TIME_CURA_RE = /TIME:([0-9]+)/i

export class ThreeMfError extends Error {
  constructor (message, code) {
    super(message)
    this.name = 'ThreeMfError'
    this.code = code
  }
}

/**
 * Analyze a .3mf File entirely in the browser.
 *
 * Returns a descriptor consumed by the UI:
 * {
 *   fileName, fileSize,
 *   mode: 'raw' | 'sliced',
 *   geometry: { volumeMm3, volumeCm3, surfaceAreaMm2, meshCount, bbox } | null,
 *   slicer:   { weightG, lengthM, volumeCm3, durationH, durationSource, source, plates, filamentTypes, colors } | null,
 *   objectCount, buildItems, meshCount, materials, plates
 * }
 */
export async function use3mfParser (file) {
  let zip
  try {
    zip = await JSZip.loadAsync(file)
  } catch {
    throw new ThreeMfError(
      'This file could not be opened as a 3MF package. It may be corrupted or not a real .3mf file.',
      'invalid-archive'
    )
  }

  const entries = Object.values(zip.files).filter(entry => !entry.dir)
  if (entries.length === 0) {
    throw new ThreeMfError('This 3MF archive is empty.', 'empty')
  }

  const modelEntries = entries.filter(entry => MODEL_RE.test(entry.name))
  const slicer = await scanSlicerData(zip, entries)

  const result = {
    fileName: file.name,
    fileSize: file.size,
    mode: 'raw',
    geometry: null,
    slicer,
    objectCount: 0,
    buildItems: 0,
    meshCount: 0,
    materials: [],
    plates: slicer.plates
  }

  if (modelEntries.length > 0) {
    const primary = await findPrimaryModel(zip, modelEntries)
    if (primary) {
      const xmlText = await primary.file.async('text').catch(() => '')
      const meta = extractModelMeta(xmlText)
      result.objectCount = meta.objectCount
      result.buildItems = meta.buildItems
      result.materials = meta.materials

      try {
        const buffer = await file.arrayBuffer()
        const group = new ThreeMFLoader().parse(buffer)
        const analysis = computeGroupAnalysis(group)
        if (analysis.meshCount > 0 && analysis.volumeMm3 > 0) {
          result.geometry = analysis
          result.meshCount = analysis.meshCount
        }
      } catch {
        // Keep going: slicer metadata may still be usable on its own.
      }
    }
  }

  // Fall back to slicer-reported colours as "detected materials".
  if (result.materials.length === 0 && slicer.colors.length > 0) {
    result.materials = slicer.colors.map(color => ({ name: 'Slicer filament', color }))
  }

  const hasGeometry = !!result.geometry
  const hasSlicerData = slicer.hasData

  if (!hasGeometry && !hasSlicerData) {
    throw new ThreeMfError(
      'No readable mesh was found in this 3MF file, and no slicer-reported filament data could be detected.',
      'no-data'
    )
  }

  result.mode = slicer.weightG != null || slicer.lengthM != null || slicer.volumeCm3 != null ? 'sliced' : 'raw'
  return result
}

/* ------------------------------------------------------------------ */
/* Mesh + model metadata                                              */
/* ------------------------------------------------------------------ */

/**
 * Locate the model part that carries the <build> (the assembled scene).
 * Prefers the conventional path, then the package relationship, then a
 * content sniff for <build>.
 */
async function findPrimaryModel (zip, modelEntries) {
  const exact = modelEntries.find(entry => entry.name.toLowerCase() === '3d/3dmodel.model')
  if (exact) return { file: exact }

  const relsEntry = Object.values(zip.files)
    .find(entry => !entry.dir && entry.name.toLowerCase() === '_rels/.rels')
  if (relsEntry) {
    try {
      const rels = await relsEntry.async('text')
      const match = /Target="([^"]+\.model)"/i.exec(rels)
      if (match) {
        const target = match[1].replace(/^\//, '').toLowerCase()
        const linked = modelEntries.find(entry => entry.name.toLowerCase() === target)
        if (linked) return { file: linked }
      }
    } catch {
      // ignore and fall through
    }
  }

  for (const entry of modelEntries) {
    try {
      const head = await entry.async('text')
      if (/<build[\s>]/i.test(head)) return { file: entry }
    } catch {
      // ignore
    }
  }

  return modelEntries[0] ? { file: modelEntries[0] } : null
}

/**
 * Extract detected base materials / colour groups and the object counts from
 * the model XML using the native DOMParser (namespace-safe).
 */
function extractModelMeta (xmlText) {
  const out = { materials: [], objectCount: 0, buildItems: 0 }
  if (!xmlText || typeof DOMParser === 'undefined') return out

  let doc
  try {
    doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  } catch {
    return out
  }
  if (!doc || doc.getElementsByTagName('parsererror').length > 0) return out

  const seen = new Set()
  const pushMaterial = (name, color) => {
    const normalized = normalizeColor(color)
    const key = `${name || ''}|${normalized}`
    if (seen.has(key)) return
    seen.add(key)
    out.materials.push({ name: name || '', color: normalized })
  }

  doc.querySelectorAll('basematerials').forEach((group) => {
    group.querySelectorAll('base').forEach((base) => {
      pushMaterial(base.getAttribute('name'), base.getAttribute('displaycolor'))
    })
  })
  doc.querySelectorAll('colorgroup').forEach((group) => {
    group.querySelectorAll('color').forEach((color) => {
      pushMaterial(color.getAttribute('name'), color.getAttribute('color'))
    })
  })

  const build = doc.querySelector('build')
  if (build) {
    out.buildItems = Array.from(build.children).filter(el => el.localName === 'item').length
  }
  const resources = doc.querySelector('resources')
  if (resources) {
    out.objectCount = Array.from(resources.children).filter(el => el.localName === 'object').length
  }

  return out
}

/* ------------------------------------------------------------------ */
/* Slicer-reported metadata                                           */
/* ------------------------------------------------------------------ */

/**
 * Scan every text-ish part of the archive for filament weight/length/volume.
 * Different slicers use different files and field names:
 *  - Bambu Studio / OrcaSlicer: Metadata/slice_info.config (XML) +
 *    Metadata/plate_N.gcode ("; total_weight = ..." / "; filament used [g] = ...")
 *  - PrusaSlicer: sliced G-code comments ("; filament used [g] = ...")
 * We collect candidates per file and then pick the single best source so the
 * same value is never counted twice.
 */
async function scanSlicerData (zip, entries) {
  const buckets = { weights: [], lengths: [], volumes: [], times: [], types: new Set(), colors: new Set() }
  let plates = 0

  for (const entry of entries) {
    const name = entry.name
    const lower = name.toLowerCase()

    if (MODEL_RE.test(lower) || IMAGE_RE.test(lower) || MESH_RE.test(lower)) continue

    const isGcode = GCODE_RE.test(lower)
    const isXml = XML_RE.test(lower)
    if (!isGcode && !isXml) continue
    if (typeof entry._data?.uncompressedSize === 'number' && entry._data.uncompressedSize > MAX_TEXT_BYTES) continue

    let text
    try {
      text = await entry.async('text')
    } catch {
      continue
    }
    if (!text) continue

    if (/plate_\d+\.gcode$/i.test(name)) plates++

    if (isXml) {
      for (const pair of extractPairsFromXml(text)) {
        classifyPair(pair, name, buckets)
      }
    }
    for (const candidate of extractFromText(text, name)) {
      if (candidate.kind === 'weight') buckets.weights.push(candidate)
      else if (candidate.kind === 'length') buckets.lengths.push(candidate)
      else if (candidate.kind === 'volume') buckets.volumes.push(candidate)
    }
    for (const candidate of extractTimeFromText(text, name)) {
      buckets.times.push(candidate)
    }
  }

  const weightPick = pickBestSource(groupByFile(buckets.weights))
  const lengthPick = pickBestSource(groupByFile(buckets.lengths))
  const volumePick = pickBestSource(groupByFile(buckets.volumes))
  const durationPick = pickBestDuration(groupByFile(buckets.times))

  const slicer = {
    weightG: weightPick ? round(weightPick.value, 3) : null,
    lengthM: lengthPick ? round(lengthPick.value, 3) : null,
    volumeCm3: volumePick ? round(volumePick.value / 1000, 3) : null,
    durationH: durationPick ? round(durationPick.value / 3600, 3) : null,
    durationSource: durationPick?.file ?? null,
    source: weightPick?.file || lengthPick?.file || volumePick?.file || null,
    plates,
    filamentTypes: [...buckets.types],
    colors: [...buckets.colors]
  }
  slicer.hasData = slicer.weightG != null || slicer.lengthM != null || slicer.volumeCm3 != null ||
    slicer.filamentTypes.length > 0 || plates > 0

  return slicer
}

/**
 * Parse Bambu/Orca style XML (`<metadata key="weight" value="12.34"/>` and
 * `<filament used_g="12.34" used_m="4.05" type="PLA" color="#fff"/>`) as well
 * as generic attribute/value pairs.
 */
function extractPairsFromXml (text) {
  const pairs = []
  let doc
  try {
    doc = xmlParser.parse(text)
  } catch {
    return pairs
  }

  const visit = (node) => {
    if (node == null) return
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (typeof node !== 'object') return

    // key/value style metadata (Bambu Studio / OrcaSlicer slice_info.config)
    const key = node['@_key'] ?? node['@_name']
    const value = node['@_value']
    if (key != null && value != null && typeof value !== 'object') {
      pairs.push({ key: String(key), value: String(value) })
    }

    for (const [rawKey, rawValue] of Object.entries(node)) {
      if (rawKey.startsWith('@_')) {
        const attr = rawKey.slice(2)
        if (typeof rawValue === 'string' || typeof rawValue === 'number') {
          pairs.push({ key: attr, value: String(rawValue) })
        }
      } else if (rawValue && typeof rawValue === 'object') {
        visit(rawValue)
      }
    }
  }

  visit(doc)
  return pairs
}

function classifyPair (pair, fileName, buckets) {
  const rawKey = String(pair.key ?? '').trim()
  const rawValue = String(pair.value ?? '').trim()
  if (!rawKey || !rawValue) return

  const key = rawKey.toLowerCase().replace(/\s+/g, '_')

  if (/^(type|filament_type|material)$/.test(key) && /^[a-z0-9 +._-]{1,24}$/i.test(rawValue)) {
    buckets.types.add(rawValue)
    return
  }
  if (/color|colour/.test(key) && /^#?[0-9a-f]{6}/i.test(rawValue)) {
    buckets.colors.add(normalizeColor(rawValue))
    return
  }
  if (/time|prediction/.test(key)) {
    const seconds = toSeconds(rawValue)
    if (seconds != null) {
      buckets.times.push({ value: seconds, scope: 'total', file: fileName, key })
    }
    return
  }
  if (/time|prediction|date/.test(key) && !/weight|length/.test(key)) return

  if (/weight/.test(key) && !/length/.test(key)) {
    const grams = toGrams(rawValue, key)
    if (grams != null) {
      buckets.weights.push({ value: grams, scope: /total|weight/.test(key) ? 'total' : 'part', file: fileName, key })
    }
    return
  }
  if (/(^|_)used_g($|_)|(^|_)grams?($|_)|(^|_)g($|_)/.test(key) && !/mm3|volume/.test(key)) {
    const grams = toGrams(rawValue, key)
    if (grams != null) {
      buckets.weights.push({ value: grams, scope: 'part', file: fileName, key })
    }
    return
  }
  if (/(^|_)used_mm($|_)|(^|_)mm($|_)/.test(key)) {
    const meters = toMeters(rawValue, 'mm')
    if (meters != null) {
      buckets.lengths.push({ value: meters, scope: 'part', file: fileName, key })
    }
    return
  }
  if (/(^|_)used_m($|_)|(^|_)m($|_)|length|meter|metre/.test(key) && !/weight|time/.test(key)) {
    const meters = toMeters(rawValue, /mm/.test(key) ? 'mm' : 'm')
    if (meters != null) {
      buckets.lengths.push({ value: meters, scope: /total|length/.test(key) ? 'total' : 'part', file: fileName, key })
    }
    return
  }
  if (/volume|mm3|mm\^3/.test(key)) {
    const match = /(-?[0-9]*\.?[0-9]+)/.exec(rawValue)
    const value = match ? parseFloat(match[1]) : NaN
    if (isFinite(value) && value > 0) {
      buckets.volumes.push({ value, scope: 'part', file: fileName, key })
    }
  }
}

function extractFromText (text, fileName) {
  const out = []
  const seen = new Set()

  let sample = text
  if (sample.length > MAX_SCAN_CHARS) {
    sample = `${sample.slice(0, MAX_SCAN_CHARS - 4_000_000)}\n${sample.slice(-4_000_000)}`
  }

  for (const rawLine of sample.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    for (const pattern of TEXT_PATTERNS) {
      const match = pattern.re.exec(line)
      if (!match) continue
      const value = parseFloat(match[1])
      if (!isFinite(value) || value <= 0) continue
      const dedupe = `${pattern.kind}|${pattern.scope}|${value}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      out.push({ value, kind: pattern.kind, scope: pattern.scope, file: fileName, key: pattern.label })
    }
  }

  return out
}

/**
 * Scan for whole-print duration headings in G-code ("estimated printing time",
 * "total_duration", Cura ";TIME:…"). Values are normalised to seconds.
 */
function extractTimeFromText (text, fileName) {
  const out = []
  const seen = new Set()
  let sample = text
  if (sample.length > MAX_SCAN_CHARS) {
    sample = `${sample.slice(0, MAX_SCAN_CHARS - 4_000_000)}\n${sample.slice(-4_000_000)}`
  }

  for (const rawLine of sample.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    let candidateText = null
    if (TIME_CURA_RE.test(line)) {
      candidateText = line.slice(line.search(TIME_CURA_RE) + 5).trim()
    } else if (TIME_HEADING_RE.test(line)) {
      const split = line.search(/[=:]/)
      candidateText = split >= 0 ? line.slice(split + 1).trim() : line.trim()
    }
    if (!candidateText) continue

    const seconds = toSeconds(candidateText, fileName)
    if (seconds == null) continue
    const dedupe = `${fileName}|${seconds}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    out.push({ value: seconds, scope: 'total', file: fileName, key: 'time' })
  }

  return out
}

function groupByFile (candidates) {
  const map = new Map()
  for (const candidate of candidates) {
    if (!map.has(candidate.file)) map.set(candidate.file, [])
    map.get(candidate.file).push(candidate)
  }
  return map
}

/**
 * Pick the most trustworthy single file, then total its candidates. Within one
 * file "total" candidates win over per-part ones so plate weight and per
 * filament usage in the same file are not double counted.
 */
function pickBestSource (byFile) {
  let best = null
  for (const [file, candidates] of byFile) {
    const totals = candidates.filter(candidate => candidate.scope === 'total')
    const chosen = totals.length > 0 ? totals : candidates
    const value = chosen.reduce((sum, candidate) => sum + candidate.value, 0)
    if (!(value > 0)) continue
    const rank = fileRank(file)
    if (!best || rank > best.rank || (rank === best.rank && value > best.value)) {
      best = { value, file, rank }
    }
  }
  return best
}

function fileRank (file) {
  const lower = file.toLowerCase()
  if (lower.includes('slice_info')) return 4
  if (GCODE_RE.test(lower)) return 3
  if (lower.endsWith('.config')) return 2
  return 1
}

/**
 * Pick a print duration. slice_info.config holds the whole-project total and
 * wins outright (taking its largest timed value); otherwise the per-plate
 * G-code totals are summed, one per file.
 */
function pickBestDuration (byFile) {
  const entries = [...byFile.entries()]
  if (entries.length === 0) return null

  const slice = entries.filter(([file]) => file.toLowerCase().includes('slice_info'))
  if (slice.length > 0) {
    const value = Math.max(...slice.flatMap(([, candidates]) => candidates.map(candidate => candidate.value)))
    return { value, file: slice[0][0] }
  }

  let total = 0
  let file = null
  for (const [candidatesFile, candidates] of entries) {
    const value = Math.max(...candidates.map(candidate => candidate.value))
    total += value
    file = candidatesFile
  }
  return total > 0 ? { value: total, file } : null
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function toGrams (raw, key = '') {
  const match = /(-?[0-9]*\.?[0-9]+)\s*(kg|mg|g)?/i.exec(raw)
  if (!match) return null
  let value = parseFloat(match[1])
  if (!isFinite(value) || value <= 0) return null
  const unit = (match[2] || (/(^|_)kg($|_)/.test(key) ? 'kg' : 'g')).toLowerCase()
  if (unit === 'kg') value *= 1000
  else if (unit === 'mg') value /= 1000
  return value
}

function toMeters (raw, defaultUnit = 'm') {
  const match = /(-?[0-9]*\.?[0-9]+)\s*(mm|cm|m)?/i.exec(raw)
  if (!match) return null
  let value = parseFloat(match[1])
  if (!isFinite(value) || value <= 0) return null
  const unit = (match[2] || defaultUnit || 'm').toLowerCase()
  if (unit === 'mm') value /= 1000
  else if (unit === 'cm') value /= 100
  return value
}

/**
 * Parse a print duration into seconds. Accepts human formats ("2h 14m 31s",
 * "45 minutes", "1:30:00"), Cura "TIME:<seconds>", and bare numbers which are
 * treated as seconds — the Bambu/Orca slice_info "time" and gcode
 * "total_duration" convention. Values under a minute are dropped to avoid
 * junk like Orca's zeroed "first_layer_time" being mistaken for the total.
 */
function toSeconds (raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null

  const pieces = { h: 0, m: 0, s: 0 }
  let matched = false
  const unitRe = { h: /([0-9]*\.?[0-9]+)\s*(?:h(?:ou?rs?)?)/i, m: /([0-9]*\.?[0-9]+)\s*(?:m(?:i?n(?:ute)?s?)?)/i, s: /([0-9]*\.?[0-9]+)\s*(?:s(?:ec(?:ond)?s?)?)/i }
  for (const [unit, re] of Object.entries(unitRe)) {
    const match = re.exec(text)
    if (match) {
      pieces[unit] += parseFloat(match[1])
      matched = true
    }
  }
  if (matched) {
    const total = pieces.h * 3600 + pieces.m * 60 + pieces.s
    return total >= 60 ? total : null
  }

  const colon = /^\s*([0-9]+):([0-9]{1,2})(?::([0-9]{1,2}))?\s*$/.exec(text)
  if (colon) {
    const total = parseInt(colon[1]) * 3600 + parseInt(colon[2]) * 60 + (colon[3] ? parseInt(colon[3]) : 0)
    return total >= 60 ? total : null
  }

  const number = /^\s*([0-9]*\.?[0-9]+)\s*$/.exec(text)
  if (number) {
    const value = parseFloat(number[1])
    return value >= 60 ? value : null
  }

  return null
}

function normalizeColor (value) {
  if (!value) return ''
  const trimmed = String(value).trim()
  if (/^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(trimmed)) {
    return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  }
  return trimmed
}

function round (value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
