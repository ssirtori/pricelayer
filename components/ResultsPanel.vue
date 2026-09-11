<script setup>
import { MATERIALS } from '~/data/materials'
import printers from '~/data/printers.json'

const props = defineProps({
  analysis: { type: Object, default: null },
  material: { type: String, default: 'PLA' },
  infill: { type: Number, default: 20 },
  wallThickness: { type: Number, default: 0.5 },
  printerId: { type: String, default: '' },
  kwhRate: { type: Number, default: 0.4 },
  printTime: { type: Number, default: null },
  filamentPrice: { type: Number, default: null }
})

const emit = defineEmits([
  'update:material',
  'update:infill',
  'update:wallThickness',
  'update:printerId',
  'update:kwhRate',
  'update:printTime',
  'update:filamentPrice'
])

const density = computed(() => MATERIALS.find(m => m.id === props.material)?.density ?? MATERIALS[0].density)

// Weight reported by the slicer itself (reliable).
const slicerWeight = computed(() => props.analysis?.slicer?.weightG ?? null)

// Geometric shell-and-infill estimate:
//   outer shell (walls + top/bottom skins), surface area × wall thickness,
//   is printed solid; the interior core is filled only at infill%.
// Falls back to volume × infill% when there is no mesh or no surface area.
const geometricWeight = computed(() => {
  const geometry = props.analysis?.geometry
  if (!geometry || geometry.volumeCm3 == null) return null

  let effectiveVolume
  if (geometry.surfaceAreaMm2 > 0 && props.wallThickness > 0) {
    const shellVolume = Math.min(geometry.volumeCm3, (geometry.surfaceAreaMm2 * props.wallThickness) / 1000)
    const interior = Math.max(0, geometry.volumeCm3 - shellVolume)
    effectiveVolume = shellVolume + interior * (props.infill / 100)
  } else {
    effectiveVolume = geometry.volumeCm3 * (props.infill / 100)
  }

  return effectiveVolume * density.value
})

const primaryWeight = computed(() => slicerWeight.value ?? geometricWeight.value)
const weightBadge = computed(() => (slicerWeight.value != null ? 'slicer-reported data' : 'geometric estimate'))
const isSlicerData = computed(() => slicerWeight.value != null)

function formatNumber (value, digits = 2) {
  if (value == null || !isFinite(Number(value))) return '—'
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
}

function formatInt (value) {
  if (value == null) return '—'
  return Number(value).toLocaleString()
}

// Accepts both "0.40" and the comma-decimal "0,40"; returns null for empty input.
function parseNumber (value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(String(value).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// ------------------------------------------------------------------
// Printer & print cost
// ------------------------------------------------------------------

const printer = computed(() => {
  if (printers[props.printerId]) return printers[props.printerId]
  return Object.values(printers).find(p => p.energy?.averagePrintW || Object.keys(p.energy?.byMaterialW || {}).length > 0)
    ?? Object.values(printers)[0]
    ?? null
})
const printerPowerW = computed(() => {
  if (!printer.value) return null
  const w = printer.value.energy?.byMaterialW?.[props.material] ?? printer.value.energy?.averagePrintW
  if (Number.isFinite(Number(w)) && Number(w) > 0) return { watts: Number(w), estimated: false }
  const rated = printer.value.energy?.ratedPowerW
  if (Number.isFinite(Number(rated)) && rated > 0) {
    // Typical FDM print draw is ~8% of the rated power (matches measured
    // Bambu A1 95 W / 1300 W and Kobra X 120 W / 1450 W).
    return { watts: Math.max(20, Math.round(rated * 0.08)), estimated: true }
  }
  return null
})
const printerPowerIsEstimated = computed(() => printerPowerW.value?.estimated === true)
const printerPowerWatts = computed(() => printerPowerW.value?.watts ?? null)

const detectedTimeH = computed(() => props.analysis?.slicer?.durationH ?? null)
const printTimeOverride = computed(() => (props.printTime != null && props.printTime > 0) ? props.printTime : null)

// Slicer-detected duration wins unless the user overrides it.
const effectiveTimeH = computed(() => printTimeOverride.value ?? detectedTimeH.value)

const energyKwh = computed(() => {
  if (effectiveTimeH.value == null || printerPowerW.value == null) return null
  return (printerPowerW.value.watts * effectiveTimeH.value) / 1000
})

const energyCost = computed(() => (
  energyKwh.value != null && Number.isFinite(props.kwhRate) && props.kwhRate > 0
    ? energyKwh.value * props.kwhRate
    : null
))

// Weight used is whatever the badge shows (slicer-reported or geometric).
const weightG = computed(() => primaryWeight.value)

const materialPricePerKg = computed(() => getMaterial(props.material)?.pricePerKg ?? 0)
const effectivePricePerKg = computed(() => (props.filamentPrice != null && props.filamentPrice > 0 ? props.filamentPrice : null))

const filamentCost = computed(() => {
  if (weightG.value == null || !effectivePricePerKg.value) return null
  return (weightG.value / 1000) * effectivePricePerKg.value
})

const totalCost = computed(() => {
  if (energyCost.value == null || filamentCost.value == null) return null
  return energyCost.value + filamentCost.value
})

// Missing required inputs that block the total cost from being shown.
const missingCostInputs = computed(() => {
  const missing = []
  if (!(Number.isFinite(props.kwhRate) && props.kwhRate > 0)) missing.push('an electricity rate')
  if (!(props.filamentPrice != null && props.filamentPrice > 0)) missing.push('a filament price')
  if (effectiveTimeH.value == null) missing.push('a print duration')
  return missing
})
const missingCostText = computed(() => {
  const missing = missingCostInputs.value
  if (missing.length === 1) return missing[0]
  if (missing.length === 2) return `${missing[0]} and ${missing[1]}`
  return `${missing[0]}, ${missing[1]} and ${missing[2]}`
})
const canEstimateEnergy = computed(() => printerPowerW.value != null)

function formatHours (hours) {
  if (hours == null) return '—'
  const totalMinutes = Math.round(hours * 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function formatCost (value) {
  if (value == null || !isFinite(Number(value))) return '—'
  const abs = Math.abs(value)
  const digits = abs > 0 && abs < 0.01 ? 4 : abs < 0.1 ? 3 : 2
  return `€${Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

function getMaterial (id) {
  return MATERIALS.find(m => m.id === id) || MATERIALS[0]
}
</script>

<template>
  <div v-if="analysis" class="space-y-6">
    <!-- Printer & print cost -->
    <div v-if="analysis" class="rounded-2xl border-2 border-cyan-400/40 bg-cyan-500/10 p-6 shadow-lg shadow-cyan-500/10">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-sm font-medium uppercase tracking-wide text-cyan-300">Print cost</h2>
        <span v-if="totalCost != null" class="text-4xl font-extrabold leading-none text-cyan-50">{{ formatCost(totalCost) }}</span>
        <span v-else-if="!canEstimateEnergy" class="text-sm text-slate-500">Energy cost cannot be estimated for this printer.</span>
        <span v-else class="text-sm text-slate-500">Enter {{ missingCostText }} to see the total cost</span>
      </div>

      <div class="mt-4">
        <PrinterSelector :model-value="printerId" @update:model-value="emit('update:printerId', $event)" />
        <div class="mt-3 text-xs leading-relaxed text-slate-400">
          {{ printer.brand }} {{ printer.model }} — {{ printer.type }} · build
          {{ printer.buildVolume?.x }} × {{ printer.buildVolume?.y }} × {{ printer.buildVolume?.z }} mm ·
          <template v-if="printerPowerWatts != null">
            average draw <strong class="text-slate-300">{{ printerPowerWatts }} W</strong>
            <span v-if="printerPowerIsEstimated" class="text-slate-500">(est.)</span>.
          </template>
          <template v-else>
            <strong class="text-amber-300">average consumption not published</strong> — energy cost cannot be estimated for this printer.
          </template>
          <span class="mt-1 block text-slate-500">{{ printer.energy?.note }}</span>
        </div>
      </div>

      <div class="mt-5 grid gap-4 sm:grid-cols-3">
        <div>
          <label for="kwh-rate" class="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">
            Electricity rate
          </label>
          <div class="flex items-center gap-2">
            <input
              id="kwh-rate"
              type="number"
              min="0"
              step="0.01"
              class="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
              :value="kwhRate"
              @input="emit('update:kwhRate', parseNumber($event.target.value))"
            >
            <span class="shrink-0 text-sm text-slate-400">€/kWh</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">Required — your electricity price per kWh.</p>
        </div>

        <div>
          <label for="filament-price" class="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">
            Filament price (1 kg)
          </label>
          <div class="flex items-center gap-2">
            <input
              id="filament-price"
              type="number"
              min="0"
              step="0.5"
              class="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
              :value="filamentPrice ?? ''"
              :placeholder="String(materialPricePerKg)"
              @input="emit('update:filamentPrice', parseNumber($event.target.value))"
            >
            <span class="shrink-0 text-sm text-slate-400">€/kg</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">
            Required — usually €{{ materialPricePerKg }}/kg for {{ getMaterial(material).name }}; enter the price you actually pay.
          </p>
        </div>

        <div>
          <label for="print-time" class="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">
            Print duration
          </label>
          <div class="flex items-center gap-2">
            <input
              id="print-time"
              type="number"
              min="0"
              step="0.25"
              class="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
              :value="printTime ?? ''"
              :placeholder="detectedTimeH != null ? formatHours(detectedTimeH) : 'auto'"
              @input="emit('update:printTime', parseNumber($event.target.value))"
            >
            <span class="shrink-0 text-sm text-slate-400">h</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">
            <template v-if="detectedTimeH != null">Leave empty to use the slicer-reported time.</template>
            <template v-else>Required — no print time was detected in this file.</template>
          </p>
        </div>
      </div>

      <div class="mt-5 rounded-xl border border-cyan-400/20 bg-slate-900/50 p-4 text-sm">
        <div class="flex items-center justify-between py-1">
          <span class="text-slate-400">Print duration</span>
          <span class="font-medium text-slate-100">
            {{ formatHours(effectiveTimeH) }}
            <span v-if="detectedTimeH != null && printTimeOverride == null" class="text-xs font-normal text-slate-500">from slicer</span>
          </span>
        </div>
        <div class="flex items-center justify-between py-1">
          <span class="text-slate-400">Average energy draw</span>
          <span class="font-medium text-slate-100">
            {{ printerPowerWatts != null ? `${printerPowerWatts} W` : '—' }}
            <span v-if="printerPowerIsEstimated" class="text-xs font-normal text-slate-500">(est.)</span>
          </span>
        </div>
        <div class="flex items-center justify-between py-1">
          <span class="text-slate-400">Energy use</span>
          <span class="font-medium text-slate-100">{{ formatNumber(energyKwh, 3) }} kWh</span>
        </div>
        <div class="flex items-center justify-between py-1">
          <span class="text-slate-400">Energy cost</span>
          <span class="font-medium text-slate-100">{{ formatCost(energyCost) }}</span>
        </div>
        <div class="flex items-center justify-between py-1">
          <span class="text-slate-400">Filament cost ({{ formatNumber(effectivePricePerKg) }} €/kg)</span>
          <span class="font-medium text-slate-100">{{ formatCost(filamentCost) }}</span>
        </div>
        <div class="mt-2 flex items-center justify-between rounded-lg bg-cyan-500/15 px-3 py-2.5 font-bold ring-1 ring-cyan-400/40">
          <span class="text-sm uppercase tracking-wide text-cyan-300">Total print cost</span>
          <span class="text-xl text-cyan-50">{{ formatCost(totalCost) }}</span>
        </div>
        <p v-if="totalCost == null" class="mt-2 text-xs text-slate-500">
          <template v-if="!canEstimateEnergy">Energy cost cannot be estimated for this printer.</template>
          <template v-else>Enter {{ missingCostText }} to see the total cost.</template>
        </p>
      </div>
    </div>

    <!-- Primary weight -->
    <div class="rounded-2xl border border-slate-700 bg-slate-800/60 p-6">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-sm font-medium uppercase tracking-wide text-slate-400">
          Estimated filament weight
        </h2>
        <span
          class="rounded-full px-3 py-1 text-xs font-semibold"
          :class="isSlicerData
            ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/40'
            : 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/40'"
        >
          {{ weightBadge }}
        </span>
      </div>

      <div class="mt-3 flex items-end gap-3">
        <span class="text-6xl font-bold leading-none text-slate-50">
          {{ formatNumber(primaryWeight) }}
        </span>
        <span class="pb-1 text-xl font-medium text-slate-400">g</span>
      </div>
    </div>

    <!-- Infill + material controls (only meaningful for the geometric estimate) -->
    <div v-if="analysis.geometry" class="rounded-2xl border border-slate-700 bg-slate-800/60 p-6">
      <MaterialSelector :model-value="material" @update:model-value="emit('update:material', $event)" />

      <div class="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <div class="mb-2 flex items-center justify-between">
            <label for="wall-thickness" class="text-sm font-medium uppercase tracking-wide text-slate-400">
              Wall thickness
            </label>
            <span class="text-sm font-semibold text-slate-200">{{ formatNumber(wallThickness, 2) }} mm</span>
          </div>
          <input
            id="wall-thickness"
            type="range"
            min="0.2"
            max="1.6"
            step="0.05"
            class="w-full accent-cyan-400"
            :value="wallThickness"
            @input="emit('update:wallThickness', Number($event.target.value))"
          >
          <p class="mt-2 text-xs text-slate-500">
            Solid shell that wraps the surface — perimeter walls on vertical faces, top/bottom skin on flat faces.
          </p>
        </div>

        <div>
          <div class="mb-2 flex items-center justify-between">
            <label for="infill" class="text-sm font-medium uppercase tracking-wide text-slate-400">Infill</label>
            <span class="text-sm font-semibold text-slate-200">{{ infill }}%</span>
          </div>
          <input
            id="infill"
            type="range"
            min="0"
            max="100"
            step="5"
            class="w-full accent-cyan-400"
            :value="infill"
            @input="emit('update:infill', Number($event.target.value))"
          >
          <p class="mt-2 text-xs text-slate-500">
            Only fills the interior core — the shell is always printed solid.
          </p>
        </div>
      </div>

      <p class="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
        This geometric estimate is indicative only: shells, infill, supports and perimeters are approximated,
        not sliced. It is not a replacement for a real slicer’s precise calculation.
      </p>
    </div>
  </div>
</template>