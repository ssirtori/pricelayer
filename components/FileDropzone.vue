<script setup>
const props = defineProps({
  fileName: { type: String, default: '' },
  fileSize: { type: Number, default: 0 },
  analyzing: { type: Boolean, default: false },
  error: { type: String, default: '' }
})

const emit = defineEmits(['file', 'error'])

const input = ref(null)
const dragOver = ref(false)

function formatSize (bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function acceptFile (file) {
  if (!file) return
  if (!/\.3mf$/i.test(file.name)) {
    emit('error', 'Only .3mf files are supported. Please pick a file ending in .3mf.')
    return
  }
  emit('file', file)
}

function onDrop (event) {
  event.preventDefault()
  dragOver.value = false
  if (props.analyzing) return
  acceptFile(event.dataTransfer?.files?.[0])
}

function openPicker () {
  if (props.analyzing) return
  input.value?.click()
}

function onInput (event) {
  acceptFile(event.target.files?.[0])
  event.target.value = ''
}
</script>

<template>
  <div>
    <div
      class="group relative rounded-2xl border-2 border-dashed p-8 text-center transition-colors"
      :class="[
        error ? 'border-red-400/60 bg-red-500/5' : dragOver
          ? 'border-cyan-400 bg-cyan-400/10'
          : 'border-slate-600 bg-slate-800/40 hover:border-slate-400'
      ]"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <input ref="input" type="file" accept=".3mf,application/vnd.ms-package.3dmanufacturing-3dmodel" class="hidden" @input="onInput">

      <div v-if="!analyzing" class="mx-auto flex max-w-md flex-col items-center gap-3">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 7.5L12 13l9-5.5M3 7.5v9L12 22l9-5.5v-9L12 2 3 7.5zm7.5 5.25L12 13l1.5-1.5M12 13v9" />
        </svg>
        <p class="text-lg font-semibold text-slate-100">
          Drag &amp; drop a <span class="text-cyan-300">.3mf</span> file here
        </p>
        <p class="text-sm text-slate-400">or</p>
        <button
          type="button"
          class="rounded-lg bg-cyan-500 px-5 py-2.5 text-sm font-semibold text-slate-950 shadow transition-colors hover:bg-cyan-400"
          @click="openPicker"
        >
          Browse files
        </button>
        <p class="text-xs text-slate-500">
          All processing happens locally in your browser — nothing is uploaded.
        </p>
      </div>

      <div v-else class="mx-auto flex max-w-md flex-col items-center gap-3 py-4">
        <span class="text-slate-300">
          <span class="inline-block h-8 w-8 animate-spin rounded-full border-2 border-slate-500 border-t-cyan-400 align-middle"></span>
        </span>
        <p class="text-sm font-medium text-slate-200">Reading {{ fileName }}…</p>
      </div>
    </div>

    <div v-if="fileName && !analyzing" class="mt-3 flex items-center justify-between text-sm">
      <span class="truncate font-medium text-slate-200">{{ fileName }}</span>
      <span class="ml-3 shrink-0 rounded-full bg-slate-800 px-2.5 py-0.5 text-xs text-slate-400">{{ formatSize(fileSize) }}</span>
    </div>
    <p v-if="error && !analyzing" class="mt-3 rounded-lg border border-red-400/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-200">
      {{ error }}
    </p>
  </div>
</template>