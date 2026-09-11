<script setup>
import printers from '~/data/printers.json'

const props = defineProps({
  modelValue: { type: String, default: '' }
})

const emit = defineEmits(['update:modelValue'])

const all = computed(() => Object.values(printers))
const brands = computed(() => [...new Set(all.value.map(p => p.brand))])

const selected = computed(() => all.value.find(p => p.id === props.modelValue))

const selectedBrand = computed(() => selected.value?.brand ?? brands.value[0] ?? '')
const selectedModels = computed(() => all.value.filter(p => p.brand === selectedBrand.value))

function pickBrand (brand) {
  const first = all.value.find(p => p.brand === brand)
  emit('update:modelValue', first ? first.id : props.modelValue)
}

function pickPrinter (id) {
  emit('update:modelValue', id)
}
</script>

<template>
  <div class="grid grid-cols-2 gap-4">
    <div>
      <label for="printer-brand" class="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">
        Brand
      </label>
      <select
        id="printer-brand"
        class="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
        :value="selectedBrand"
        @change="pickBrand($event.target.value)"
      >
        <option v-for="brand in brands" :key="brand" :value="brand">{{ brand }}</option>
      </select>
    </div>

    <div>
      <label for="printer-model" class="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">
        Printer
      </label>
      <select
        id="printer-model"
        class="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
        :value="selected?.id"
        @change="pickPrinter($event.target.value)"
      >
        <option v-for="model in selectedModels" :key="model.id" :value="model.id">{{ model.model }}</option>
      </select>
    </div>
  </div>
</template>