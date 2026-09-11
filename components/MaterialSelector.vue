<script setup>
import { MATERIALS } from '~/data/materials'

defineProps({
  modelValue: { type: String, default: 'PLA' }
})

const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <div>
    <p class="mb-2 text-sm font-medium uppercase tracking-wide text-slate-400">Filament material</p>
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <button
        v-for="material in MATERIALS"
        :key="material.id"
        type="button"
        class="rounded-xl border px-3 py-2 text-left transition-colors"
        :class="material.id === modelValue
          ? 'border-cyan-400 bg-cyan-400/10 text-cyan-200'
          : 'border-slate-600 bg-slate-800/50 text-slate-300 hover:border-slate-400'"
        @click="emit('update:modelValue', material.id)"
      >
        <span class="block font-semibold">{{ material.name }}</span>
        <span class="block text-xs opacity-70">{{ material.density }} g/cm³</span>
      </button>
    </div>
  </div>
</template>