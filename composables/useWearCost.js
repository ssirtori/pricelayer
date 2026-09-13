// Printer wear-and-tear cost model.
//
// Given the purchase price of the printer and a print duration in hours, the
// printer is assumed to have an accounting useful life (in printing hours)
// and a total cost of maintenance/spare parts expressed as a percentage of
// the purchase price. The wear cost of a single print is the share of
// (price + maintenance) proportional to the printed time.
//
// These are book-keeping estimates for regular use — not a guaranteed
// technical lifetime.

// Brackets are inclusive at the upper bound ("up to €300", "€301–€600", …).
const LIFESPAN_BRACKETS = [
  { max: 300, hours: 3500, maintenancePct: 0.25 },
  { max: 600, hours: 5000, maintenancePct: 0.30 },
  { max: 1000, hours: 6000, maintenancePct: 0.35 },
  { max: 2000, hours: 8000, maintenancePct: 0.40 },
  { max: Infinity, hours: 10000, maintenancePct: 0.50 }
]

export function wearBracket (price) {
  if (price == null || !Number.isFinite(Number(price)) || price <= 0) return null
  return LIFESPAN_BRACKETS.find(b => price <= b.max) ?? null
}

export function computeWear ({ price, timeH, lifespanHours, maintenancePct }) {
  const bracket = wearBracket(price)
  if (!bracket || timeH == null || !(timeH > 0)) return null

  // Optional user overrides; empty values keep the bracket estimate.
  const life = lifespanHours != null && lifespanHours > 0 ? lifespanHours : bracket.hours
  let pct = maintenancePct != null && maintenancePct >= 0 ? maintenancePct : bracket.maintenancePct
  // Accept a percentage (25) as a convenience in addition to a fraction (0.25),
  // so a raw percent can never blow the maintenance number up 100×.
  if (pct > 1) pct /= 100

  const maintenanceCost = price * pct
  const maintenanceCoefficient = 1 + (maintenanceCost / price)
  const totalLifetimeCost = price + maintenanceCost
  const wearCostPerHour = totalLifetimeCost / life
  const printWearCost = wearCostPerHour * timeH

  return {
    lifespanHours: life,
    maintenancePct: pct,
    maintenanceCost,
    maintenanceCoefficient,
    totalLifetimeCost,
    wearCostPerHour,
    printWearCost
  }
}