/**
 * Central fare pricing: tiered distance slabs + time-of-day multipliers.
 * All amounts rounded to 2 decimal places at boundaries.
 */

const DEFAULT_TIMEZONE = 'Asia/Kolkata'

const DEFAULT_TIME_BANDS = [
  { id: 'morning', label: 'Morning peak', start: '06:00', end: '10:00', multiplier: 1.2 },
  { id: 'day', label: 'Day', start: '10:00', end: '17:00', multiplier: 1.0 },
  { id: 'evening', label: 'Evening peak', start: '17:00', end: '22:00', multiplier: 1.5 },
  { id: 'night', label: 'Night', start: '22:00', end: '06:00', multiplier: 1.8 },
]

const roundMoney = (n) => Math.round((Number(n) || 0) * 100) / 100

const parseHmToMinutes = (hm) => {
  if (!hm || typeof hm !== 'string') return null
  const m = hm.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

/**
 * @param {string} timezone
 * @param {Date} date
 * @returns {{ hour: number, minute: number, minutesOfDay: number }}
 */
const getLocalTimeParts = (date, timezone) => {
  const d = date instanceof Date ? date : new Date(date)
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(d)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return { hour, minute, minutesOfDay: hour * 60 + minute }
}

const isValidTimezone = (tz) => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Whether minutesOfDay falls in [start, end) with optional overnight wrap.
 */
const minutesInBand = (minutesOfDay, startMin, endMin) => {
  if (startMin === endMin) return true
  if (startMin < endMin) {
    return minutesOfDay >= startMin && minutesOfDay < endMin
  }
  // overnight e.g. 22:00 -> 06:00
  return minutesOfDay >= startMin || minutesOfDay < endMin
}

/**
 * @param {Date} date
 * @param {Array<{ id, start, end, multiplier }>} bands
 * @param {string} timezone
 */
const resolveTimeBandMultiplier = (date, bands, timezone = DEFAULT_TIMEZONE) => {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  const { minutesOfDay } = getLocalTimeParts(date, tz)
  const list = Array.isArray(bands) && bands.length ? bands : DEFAULT_TIME_BANDS

  for (const band of list) {
    const startMin = parseHmToMinutes(band.start)
    const endMin = parseHmToMinutes(band.end)
    if (startMin === null || endMin === null) continue
    if (minutesInBand(minutesOfDay, startMin, endMin)) {
      const mult = Number(band.multiplier)
      return {
        timeBandId: band.id || 'unknown',
        timeMultiplier: Number.isFinite(mult) && mult > 0 ? mult : 1,
        timezone: tz,
      }
    }
  }

  return { timeBandId: 'day', timeMultiplier: 1, timezone: tz }
}

/**
 * Build distance tiers from flat perKmRate when tiers not configured.
 */
const buildTiersFromFlatRate = (perKmRate) => {
  const r = Number(perKmRate) || 0
  return {
    tier1: { maxKm: 10, ratePerKm: r },
    tier2: { maxKm: 20, ratePerKm: r },
    tier3: { maxKm: 30, ratePerKm: r },
    beyondTier3RatePerKm: r,
  }
}

/**
 * @param {object} settings - full Settings doc or { pricingConfigurations }
 */
const normalizeFarePricingConfig = (settings) => {
  const pc = settings?.pricingConfigurations || settings || {}
  const perKmRate = Number(pc.perKmRate) || 0
  const fp = pc.farePricing || {}
  const enabled = fp.enabled === true

  const rawTiers = fp.distanceTiers || {}
  const tier1Max = Number(rawTiers.tier1?.maxKm) || 10
  const tier2Max = Number(rawTiers.tier2?.maxKm) || 20
  const tier3Max = Number(rawTiers.tier3?.maxKm) || 30

  const distanceTiers = enabled
    ? {
        tier1: {
          maxKm: tier1Max,
          ratePerKm: Number(rawTiers.tier1?.ratePerKm ?? perKmRate) || perKmRate,
        },
        tier2: {
          maxKm: tier2Max,
          ratePerKm: Number(rawTiers.tier2?.ratePerKm ?? perKmRate) || perKmRate,
        },
        tier3: {
          maxKm: tier3Max,
          ratePerKm: Number(rawTiers.tier3?.ratePerKm ?? perKmRate) || perKmRate,
        },
        beyondTier3RatePerKm:
          Number(rawTiers.beyondTier3RatePerKm ?? rawTiers.tier3?.ratePerKm ?? perKmRate) ||
          perKmRate,
      }
    : buildTiersFromFlatRate(perKmRate)

  const timeBands =
    enabled && Array.isArray(fp.timeBands) && fp.timeBands.length
      ? fp.timeBands
      : enabled
        ? DEFAULT_TIME_BANDS
        : [{ id: 'flat', start: '00:00', end: '00:00', multiplier: 1 }]

  const timezone =
    fp.timezone && isValidTimezone(fp.timezone) ? fp.timezone : DEFAULT_TIMEZONE

  return {
    enabled,
    perKmRate,
    minimumFare: Number(pc.minimumFare) || 0,
    distanceTiers,
    timeBands,
    timezone,
    timeMultiplierAppliesTo:
      fp.timeMultiplierAppliesTo === 'subtotalExcludingBase'
        ? 'subtotalExcludingBase'
        : 'distanceAndTime',
  }
}

/**
 * Resolve fare pricing for intercity (city tiers or intercity override).
 */
const normalizeIntercityFarePricingConfig = (settings) => {
  const intercity = settings?.intercityPricingConfigurations || {}
  if (intercity.useCityFarePricing !== false) {
    return normalizeFarePricingConfig(settings)
  }
  const city = normalizeFarePricingConfig(settings)
  const fp = intercity.farePricing || {}
  if (fp.enabled === true && fp.distanceTiers) {
    return {
      ...city,
      enabled: true,
      distanceTiers: {
        tier1: {
          maxKm: Number(fp.distanceTiers.tier1?.maxKm) || 10,
          ratePerKm: Number(fp.distanceTiers.tier1?.ratePerKm) || city.perKmRate,
        },
        tier2: {
          maxKm: Number(fp.distanceTiers.tier2?.maxKm) || 20,
          ratePerKm: Number(fp.distanceTiers.tier2?.ratePerKm) || city.perKmRate,
        },
        tier3: {
          maxKm: Number(fp.distanceTiers.tier3?.maxKm) || 30,
          ratePerKm: Number(fp.distanceTiers.tier3?.ratePerKm) || city.perKmRate,
        },
        beyondTier3RatePerKm:
          Number(fp.beyondTier3RatePerKm ?? fp.distanceTiers?.tier3?.ratePerKm) ||
          city.perKmRate,
      },
      timeBands:
        Array.isArray(fp.timeBands) && fp.timeBands.length ? fp.timeBands : city.timeBands,
      timezone: fp.timezone && isValidTimezone(fp.timezone) ? fp.timezone : city.timezone,
    }
  }
  return city
}

/**
 * @param {number} distanceKm
 * @param {object} tiers - normalized distanceTiers
 * @returns {{ total: number, breakdown: Array<{ tier, km, ratePerKm, amount }> }}
 */
const calculateTieredDistanceFare = (distanceKm, tiers) => {
  const d = Math.max(0, Number(distanceKm) || 0)
  if (d === 0) {
    return { total: 0, breakdown: [] }
  }

  const t1Max = Number(tiers.tier1?.maxKm) || 10
  const t2Max = Number(tiers.tier2?.maxKm) || 20
  const t3Max = Number(tiers.tier3?.maxKm) || 30
  const r1 = Number(tiers.tier1?.ratePerKm) || 0
  const r2 = Number(tiers.tier2?.ratePerKm) || 0
  const r3 = Number(tiers.tier3?.ratePerKm) || 0
  const rBeyond = Number(tiers.beyondTier3RatePerKm ?? r3) || 0

  const breakdown = []
  let remaining = d
  let total = 0

  const addSlab = (tier, km, rate) => {
    if (km <= 0) return
    const amount = roundMoney(km * rate)
    breakdown.push({ tier, km: roundMoney(km), ratePerKm: rate, amount })
    total += amount
  }

  const km1 = Math.min(remaining, t1Max)
  addSlab('tier1_0_10', km1, r1)
  remaining -= km1

  const km2 = Math.min(remaining, t2Max - t1Max)
  addSlab('tier2_11_20', km2, r2)
  remaining -= km2

  const km3 = Math.min(remaining, t3Max - t2Max)
  addSlab('tier3_21_30', km3, r3)
  remaining -= km3

  if (remaining > 0) {
    addSlab('beyond_30', remaining, rBeyond)
  }

  return { total: roundMoney(total), breakdown }
}

/**
 * Effective average ₹/km for partial settlement (cancellation).
 */
const getEffectivePerKmRate = (distanceKm, tiers) => {
  const d = Math.max(0, Number(distanceKm) || 0)
  if (d <= 0) return 0
  const { total } = calculateTieredDistanceFare(d, tiers)
  return roundMoney(total / d)
}

/**
 * @param {object} params
 * @param {number} params.basePrice
 * @param {number} params.distanceKm
 * @param {number} params.durationMin
 * @param {number} params.perMinuteRate
 * @param {number} params.minimumFare
 * @param {object} [params.pricingConfig] - output of normalizeFarePricingConfig
 * @param {object} [params.settings] - full settings (alternative to pricingConfig)
 * @param {Date} [params.at] - defaults to now
 */
const calculateInstantFare = ({
  basePrice,
  distanceKm,
  durationMin,
  perMinuteRate,
  minimumFare,
  pricingConfig,
  settings,
  at,
}) => {
  const config = pricingConfig || normalizeFarePricingConfig(settings)
  const when = at instanceof Date ? at : at ? new Date(at) : new Date()
  const minFare = Number.isFinite(Number(minimumFare))
    ? Number(minimumFare)
    : config.minimumFare

  const { total: tieredDistanceFare, breakdown: distanceTierBreakdown } =
    calculateTieredDistanceFare(distanceKm, config.distanceTiers)

  const duration = Math.max(0, Number(durationMin) || 0)
  const perMin = Math.max(0, Number(perMinuteRate) || 0)
  const rawTimeFare = roundMoney(duration * perMin)

  const { timeBandId, timeMultiplier, timezone } = resolveTimeBandMultiplier(
    when,
    config.timeBands,
    config.timezone
  )

  let distanceFare = tieredDistanceFare
  let timeFare = rawTimeFare
  let variableSubtotal = roundMoney(distanceFare + timeFare)

  if (config.enabled && config.timeMultiplierAppliesTo === 'subtotalExcludingBase') {
    const base = roundMoney(Number(basePrice) || 0)
    const subtotalBeforeMin = roundMoney(base + variableSubtotal * timeMultiplier)
    const fareAfterMinimum = roundMoney(Math.max(subtotalBeforeMin, minFare))
    return buildFareResult({
      basePrice,
      distanceFare,
      timeFare,
      timeMultiplier,
      timeBandId,
      timezone,
      pricingComputedAt: when,
      distanceTierBreakdown,
      variableSubtotal,
      adjustedVariable: roundMoney(variableSubtotal * timeMultiplier),
      subtotal: subtotalBeforeMin,
      fareAfterMinimum,
      minimumFare: minFare,
      farePricingEnabled: true,
    })
  }

  const adjustedVariable = config.enabled
    ? roundMoney(variableSubtotal * timeMultiplier)
    : variableSubtotal

  if (config.enabled) {
    distanceFare = roundMoney(tieredDistanceFare * timeMultiplier)
    timeFare = roundMoney(rawTimeFare * timeMultiplier)
  }

  const base = roundMoney(Number(basePrice) || 0)
  const subtotal = roundMoney(base + adjustedVariable)
  const fareAfterMinimum = roundMoney(Math.max(subtotal, minFare))

  return buildFareResult({
    basePrice,
    distanceFare,
    timeFare,
    rawTimeFare,
    rawDistanceFare: tieredDistanceFare,
    timeMultiplier: config.enabled ? timeMultiplier : 1,
    timeBandId: config.enabled ? timeBandId : 'flat',
    timezone,
    pricingComputedAt: when,
    distanceTierBreakdown,
    variableSubtotal,
    adjustedVariable,
    subtotal,
    fareAfterMinimum,
    minimumFare: minFare,
    farePricingEnabled: config.enabled,
  })
}

const buildFareResult = (fields) => ({
  baseFare: roundMoney(fields.basePrice),
  distanceFare: roundMoney(fields.distanceFare),
  timeFare: roundMoney(fields.timeFare),
  subtotal: roundMoney(fields.subtotal),
  fareAfterMinimum: roundMoney(fields.fareAfterMinimum),
  timeBandId: fields.timeBandId,
  timeMultiplier: fields.timeMultiplier,
  timezone: fields.timezone,
  pricingComputedAt:
    fields.pricingComputedAt instanceof Date
      ? fields.pricingComputedAt.toISOString()
      : fields.pricingComputedAt,
  distanceTierBreakdown: fields.distanceTierBreakdown || [],
  variableSubtotal: roundMoney(fields.variableSubtotal),
  adjustedVariable: roundMoney(fields.adjustedVariable),
  minimumFareApplied: fields.fareAfterMinimum > fields.subtotal,
  farePricingEnabled: fields.farePricingEnabled === true,
  rawTimeFare: fields.rawTimeFare != null ? roundMoney(fields.rawTimeFare) : undefined,
  rawDistanceFare: fields.rawDistanceFare != null ? roundMoney(fields.rawDistanceFare) : undefined,
})

/**
 * Distance-only fare for cancellation settlements (no base, no per-minute).
 */
const calculateDistanceFareForSettlement = (distanceKm, settings, at) => {
  const config = normalizeFarePricingConfig(settings)
  const when = at instanceof Date ? at : at ? new Date(at) : new Date()
  const { total: tieredDistanceFare, breakdown } = calculateTieredDistanceFare(
    distanceKm,
    config.distanceTiers
  )
  const { timeBandId, timeMultiplier } = resolveTimeBandMultiplier(
    when,
    config.timeBands,
    config.timezone
  )
  const amount = config.enabled
    ? roundMoney(tieredDistanceFare * timeMultiplier)
    : tieredDistanceFare
  return {
    amount,
    distanceTierBreakdown: breakdown,
    timeBandId: config.enabled ? timeBandId : 'flat',
    timeMultiplier: config.enabled ? timeMultiplier : 1,
    effectivePerKmRate: getEffectivePerKmRate(distanceKm, config.distanceTiers),
    pricingComputedAt: when.toISOString(),
  }
}

/**
 * Intercity distance component with tiered + time multiplier (no base/toll).
 */
const calculateIntercityDistanceFare = ({
  distanceKm,
  durationMin = 0,
  perMinuteRate = 0,
  settings,
  at,
}) => {
  const config = normalizeIntercityFarePricingConfig(settings)
  const when = at instanceof Date ? at : at ? new Date(at) : new Date()
  const result = calculateInstantFare({
    basePrice: 0,
    distanceKm,
    durationMin,
    perMinuteRate,
    minimumFare: 0,
    pricingConfig: config,
    at: when,
  })
  return {
    distanceFare: result.distanceFare,
    timeFare: result.timeFare,
    variableSubtotal: result.adjustedVariable,
    distanceTierBreakdown: result.distanceTierBreakdown,
    timeBandId: result.timeBandId,
    timeMultiplier: result.timeMultiplier,
    pricingComputedAt: result.pricingComputedAt,
    effectivePerKmRate: getEffectivePerKmRate(distanceKm, config.distanceTiers),
  }
}

/**
 * Seed farePricing from flat perKmRate for admin migration.
 */
const seedFarePricingFromPerKmRate = (perKmRate, existing = {}) => {
  const r = Number(perKmRate) || 12
  return {
    enabled: existing.enabled === true,
    timezone: existing.timezone || DEFAULT_TIMEZONE,
    distanceTiers: {
      tier1: {
        maxKm: 10,
        ratePerKm: Number(existing.distanceTiers?.tier1?.ratePerKm) || r,
      },
      tier2: {
        maxKm: 20,
        ratePerKm: Number(existing.distanceTiers?.tier2?.ratePerKm) || r,
      },
      tier3: {
        maxKm: 30,
        ratePerKm: Number(existing.distanceTiers?.tier3?.ratePerKm) || r,
      },
      beyondTier3RatePerKm:
        Number(existing.distanceTiers?.beyondTier3RatePerKm) || r,
    },
    timeBands:
      Array.isArray(existing.timeBands) && existing.timeBands.length
        ? existing.timeBands
        : DEFAULT_TIME_BANDS,
    timeMultiplierAppliesTo: existing.timeMultiplierAppliesTo || 'distanceAndTime',
  }
}

/**
 * Validate farePricing payload; throws Error on invalid config.
 */
const validateFarePricingConfig = (farePricing) => {
  if (!farePricing || farePricing.enabled !== true) return

  const tiers = farePricing.distanceTiers || {}
  const t1 = Number(tiers.tier1?.maxKm)
  const t2 = Number(tiers.tier2?.maxKm)
  const t3 = Number(tiers.tier3?.maxKm)
  if (!(t1 > 0 && t2 > t1 && t3 > t2)) {
    throw new Error('Distance tier maxKm must be strictly increasing (e.g. 10, 20, 30)')
  }

  for (const key of ['tier1', 'tier2', 'tier3']) {
    const rate = Number(tiers[key]?.ratePerKm)
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error(`distanceTiers.${key}.ratePerKm must be a non-negative number`)
    }
  }
  const beyond = Number(tiers.beyondTier3RatePerKm ?? tiers.tier3?.ratePerKm)
  if (!Number.isFinite(beyond) || beyond < 0) {
    throw new Error('distanceTiers.beyondTier3RatePerKm must be a non-negative number')
  }

  if (farePricing.timezone && !isValidTimezone(farePricing.timezone)) {
    throw new Error(`Invalid timezone: ${farePricing.timezone}`)
  }

  const bands = farePricing.timeBands
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new Error('timeBands must be a non-empty array when fare pricing is enabled')
  }

  for (const band of bands) {
    const mult = Number(band.multiplier)
    if (!Number.isFinite(mult) || mult < 0.1 || mult > 5) {
      throw new Error(
        `Time band ${band.id || band.start} multiplier must be between 0.1 and 5`
      )
    }
    if (parseHmToMinutes(band.start) === null || parseHmToMinutes(band.end) === null) {
      throw new Error(`Invalid time band start/end: ${band.start} - ${band.end}`)
    }
  }
}

/** @deprecated Use calculateInstantFare — shim for flat perKmRate API */
const calculateFareWithTimeShim = (
  basePrice,
  distance,
  duration,
  perKmRate,
  perMinuteRate,
  minimumFare,
  settings,
  at
) => {
  const pricingConfig = normalizeFarePricingConfig({
    pricingConfigurations: {
      perKmRate,
      minimumFare,
      farePricing: settings?.pricingConfigurations?.farePricing,
    },
  })
  return calculateInstantFare({
    basePrice,
    distanceKm: distance,
    durationMin: duration,
    perMinuteRate,
    minimumFare,
    pricingConfig,
    at,
  })
}

module.exports = {
  DEFAULT_TIMEZONE,
  DEFAULT_TIME_BANDS,
  roundMoney,
  parseHmToMinutes,
  getLocalTimeParts,
  isValidTimezone,
  resolveTimeBandMultiplier,
  normalizeFarePricingConfig,
  normalizeIntercityFarePricingConfig,
  calculateTieredDistanceFare,
  getEffectivePerKmRate,
  calculateInstantFare,
  calculateDistanceFareForSettlement,
  calculateIntercityDistanceFare,
  seedFarePricingFromPerKmRate,
  validateFarePricingConfig,
  calculateFareWithTimeShim,
}
