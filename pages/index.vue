<script setup>
import { use3mfParser } from '~/composables/use3mfParser'
import printers from '~/data/printers.json'

const file = ref(null)
const analyzing = ref(false)
const error = ref('')
const analysis = ref(null)
const material = ref('PLA')
const infill = ref(20)
const wallThickness = ref(0.5)
const printerId = ref(
  Object.values(printers).find(p => p.energy?.averagePrintW || Object.keys(p.energy?.byMaterialW || {}).length > 0)?.id
  ?? Object.keys(printers)[0]
  ?? ''
)
const kwhRate = ref(0.4)
const printTimeHours = ref(null)
const filamentPrice = ref(null)

async function handleFile (upcomingFile) {
  error.value = ''
  analysis.value = null
  file.value = upcomingFile
  analyzing.value = true

  try {
    analysis.value = await use3mfParser(upcomingFile)
  } catch (err) {
    analysis.value = null
    error.value = err?.message || 'Something went wrong while analyzing this file.'
  } finally {
    analyzing.value = false
  }
}

function clearFile () {
  file.value = null
  analysis.value = null
  error.value = ''
}
</script>

<template>
  <main class="mx-auto w-full max-w-3xl px-4 py-10 sm:py-16">
    <header class="mb-8 text-center">
      <p class="mb-2 text-xs font-semibold uppercase tracking-widest text-cyan-400">PriceLayer</p>
      <h1 class="text-3xl font-bold text-slate-50 sm:text-4xl">
        How much does your print cost?
      </h1>
      <p class="mx-auto mt-3 max-w-lg text-sm text-slate-400">
        Upload a <strong class="text-slate-300">.3mf</strong> file to estimate filament weight, energy use and total print price — all computed locally in your browser.
      </p>
    </header>

    <FileDropzone
      :file-name="file?.name || ''"
      :file-size="file?.size || 0"
      :analyzing="analyzing"
      :error="error"
      @file="handleFile"
      @error="error = $event"
    />

    <div v-if="analyzing" class="mt-8 text-center text-sm text-slate-400">
      Extracting mesh geometry and scanning slicer metadata…
    </div>

    <div v-if="analysis && !analyzing" class="mt-8">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h2 class="text-lg font-semibold text-slate-100">Analysis results</h2>
        <button
          type="button"
          class="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-400 hover:text-slate-100"
          @click="clearFile"
        >
          Analyze another file
        </button>
      </div>

      <ResultsPanel
        :analysis="analysis"
        v-model:material="material"
        v-model:infill="infill"
        v-model:wallThickness="wallThickness"
        v-model:printerId="printerId"
        v-model:kwhRate="kwhRate"
        v-model:printTime="printTimeHours"
        v-model:filamentPrice="filamentPrice"
      />
    </div>

    <footer class="mt-12 border-t border-slate-800 pt-6 text-center text-xs leading-relaxed text-slate-500">
      <p>
        Geometric estimates are <strong class="text-slate-400">indicative only</strong> and do not replace a real slicer's
        precise calculation — shells, infill and perimeters are approximated, and supports are not modelled.
      </p>
      <p class="mt-1">
        Files never leave your device: everything runs client-side.
      </p>
    </footer>
  </main>
</template>