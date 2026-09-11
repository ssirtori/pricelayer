/**
 * Preloaded filament densities in g/cm³.
 * Values are typical averages and vary a little between manufacturers.
 * `pricePerKg` is a rough 1 kg spool street price in € used as the default
 * material cost; the user can override it in the print-cost panel.
 */
export const MATERIALS = [
  { id: 'PLA', name: 'PLA', density: 1.24, pricePerKg: 20 },
  { id: 'PETG', name: 'PETG', density: 1.27, pricePerKg: 25 },
  { id: 'ABS', name: 'ABS', density: 1.04, pricePerKg: 22 },
  { id: 'TPU', name: 'TPU', density: 1.21, pricePerKg: 32 }
]

export const DEFAULT_MATERIAL = 'PLA'

export function getMaterial (id) {
  return MATERIALS.find(m => m.id === id) || MATERIALS[0]
}
