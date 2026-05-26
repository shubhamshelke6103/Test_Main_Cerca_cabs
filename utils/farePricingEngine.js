/**
 * Central fare pricing: per-vehicle tiered distance slabs (0-5, 5-10, 10+ km)
 * + city-wide time-of-day multipliers.
 * All amounts rounded to 2 decimal places at boundaries.
 */

const {
  VEHICLE_SERVICE_KEYS,
  perKmDefaultForKey,
} = require('./vehicleServicesKeys')

const DEFAULT_TIMEZONE = 'Asia/Kolkata'
const TIER1_MAX_KM = 5
const TIER2_MAX_KM = 10

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
 * Build 3-slab distance tiers from flat perKmRate when tiered pricing is disabled.
 */
const buildTiersFromFlatRate = (perKmRate) => {
  const r = Number(perKmRate) || 0
  return {
    tier1: { maxKm: TIER1_MAX_KM, ratePerKm: r },
    tier2: { maxKm: TIER2_MAX_KM, ratePerKm: r },
    beyondTier2RatePerKm: r,
  }
}

/**
 * Map legacy city-wide 4-slab config to new 3-slab vehicle config.
 */
const migrateLegacyCityTiersToVehicle = (oldTiers, perKmRate, vehiclePerKmOverride) => {
  const fallback = Number(perKmRate) || 0
  const vehicleRate = Number(vehiclePerKmOverride) || fallback
  const old = oldTiers || {}
  const shortRate = Number(old.tier1?.ratePerKm) || fallback
  const midRate = Number(old.tier2?.ratePerKm) || shortRate
  const beyondRate =
    Number(old.beyondTier3RatePerKm ?? old.tier3?.ratePerKm ?? old.tier2?.ratePerKm) ||
    vehicleRate
  return {
    tier1: { maxKm: TIER1_MAX_KM, ratePerKm: shortRate },
    tier2: { maxKm: TIER2_MAX_KM, ratePerKm: shortRate },
    beyondTier2RatePerKm: midRate !== shortRate ? midRate : beyondRate,
  }
}

/**
 * Normalize a vehicle's 3-slab distance tier config.
 */
const normalizeVehicleDistanceTiers = (vehicleService, fallbackPerKm, vehiclePerKmOverride) => {
  const fallback = Number(fallbackPerKm) || 0
  const vehicleRate = Number(vehiclePerKmOverride) || fallback
  const raw = vehicleService?.distanceTiers || {}

  if (raw.tier1?.ratePerKm != null || raw.tier2?.ratePerKm != null || raw.beyondTier2RatePerKm != null) {
    const r1 = Number(raw.tier1?.ratePerKm ?? fallback) || fallback
    const r2 = Number(raw.tier2?.ratePerKm ?? r1) || r1
    const rBeyond = Number(raw.beyondTier2RatePerKm ?? r2) || r2
    return {
      tier1: { maxKm: TIER1_MAX_KM, ratePerKm: r1 },
      tier2: { maxKm: TIER2_MAX_KM, ratePerKm: r2 },
      beyondTier2RatePerKm: rBeyond,
    }
  }

  return {
    tier1: { maxKm: TIER1_MAX_KM, ratePerKm: vehicleRate },
    tier2: { maxKm: TIER2_MAX_KM, ratePerKm: vehicleRate },
    beyondTier2RatePerKm: vehicleRate,
  }
}

/**
 * Resolve vehicle distance tiers from settings, with legacy city-tier fallback.
 */
const resolveVehicleDistanceTiersFromSettings = (settings, vehicleServiceKey = 'cercaZip') => {
  const pc = settings?.pricingConfigurations || {}
  const perKmRate = Number(pc.perKmRate) || 0
  const key = VEHICLE_SERVICE_KEYS.includes(vehicleServiceKey) ? vehicleServiceKey : 'cercaZip'
  const vehicleService = settings?.vehicleServices?.[key]
  const vehiclePerKm =
    Number(settings?.intercityPricingConfigurations?.perKmRates?.[key]) ||
    perKmDefaultForKey(key)

  const rawVehicle = vehicleService?.distanceTiers
  const hasVehicleTiers =
    rawVehicle &&
    (rawVehicle.tier1?.ratePerKm != null ||
      rawVehicle.tier2?.ratePerKm != null ||
      rawVehicle.beyondTier2RatePerKm != null)

  if (hasVehicleTiers) {
    return normalizeVehicleDistanceTiers(vehicleService, perKmRate, vehiclePerKm)
  }

  const legacyCityTiers = pc.farePricing?.distanceTiers
  if (legacyCityTiers && (legacyCityTiers.tier1 || legacyCityTiers.tier2 || legacyCityTiers.tier3)) {
    return migrateLegacyCityTiersToVehicle(legacyCityTiers, perKmRate, vehiclePerKm)
  }

  return normalizeVehicleDistanceTiers(vehicleService, perKmRate, vehiclePerKm)
}

/**
 * City-level fare config (time bands only; distance tiers resolved per vehicle).
 * @param {object} settings - full Settings doc or { pricingConfigurations }
 */
const normalizeFarePricingConfig = (settings) => {
  const pc = settings?.pricingConfigurations || settings || {}
  const perKmRate = Number(pc.perKmRate) || 0
  const fp = pc.farePricing || {}
  const enabled = fp.enabled === true

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
    timeBands,
    timezone,
    timeMultiplierAppliesTo:
      fp.timeMultiplierAppliesTo === 'subtotalExcludingBase'
        ? 'subtotalExcludingBase'
        : 'distanceAndTime',
  }
}

/**
 * Full pricing config for a specific vehicle (city time bands + vehicle distance tiers).
 */
const resolveVehiclePricingConfig = (settings, vehicleServiceKey = 'cercaZip') => {
  const cityConfig = normalizeFarePricingConfig(settings)
  const distanceTiers = cityConfig.enabled
    ? resolveVehicleDistanceTiersFromSettings(settings, vehicleServiceKey)
    : buildTiersFromFlatRate(cityConfig.perKmRate)
  return { ...cityConfig, distanceTiers }
}

/**
 * Resolve fare pricing for intercity (per-vehicle tiers when useCityFarePricing).
 */
const normalizeIntercityFarePricingConfig = (settings, vehicleServiceKey = 'cercaZip') => {
  const intercity = settings?.intercityPricingConfigurations || {}
  if (intercity.useCityFarePricing !== false) {
    return resolveVehiclePricingConfig(settings, vehicleServiceKey)
  }
  const city = normalizeFarePricingConfig(settings)
  const fp = intercity.farePricing || {}
  if (fp.enabled === true && fp.distanceTiers) {
    return {
      ...city,
      enabled: true,
      distanceTiers: migrateLegacyCityTiersToVehicle(
        fp.distanceTiers,
        city.perKmRate,
        perKmDefaultForKey(vehicleServiceKey)
      ),
      timeBands:
        Array.isArray(fp.timeBands) && fp.timeBands.length ? fp.timeBands : city.timeBands,
      timezone: fp.timezone && isValidTimezone(fp.timezone) ? fp.timezone : city.timezone,
    }
  }
  return resolveVehiclePricingConfig(settings, vehicleServiceKey)
}

/**
 * @param {number} distanceKm
 * @param {object} tiers - normalized distanceTiers (3 slabs)
 * @returns {{ total: number, breakdown: Array<{ tier, km, ratePerKm, amount }> }}
 */
const calculateTieredDistanceFare = (distanceKm, tiers) => {
  const d = Math.max(0, Number(distanceKm) || 0)
  if (d === 0) {
    return { total: 0, breakdown: [] }
  }

  const t1Max = Number(tiers.tier1?.maxKm) || TIER1_MAX_KM
  const t2Max = Number(tiers.tier2?.maxKm) || TIER2_MAX_KM
  const r1 = Number(tiers.tier1?.ratePerKm) || 0
  const r2 = Number(tiers.tier2?.ratePerKm) || 0
  const rBeyond = Number(tiers.beyondTier2RatePerKm ?? r2) || 0

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
  addSlab('tier1_0_5', km1, r1)
  remaining -= km1

  const km2 = Math.min(remaining, t2Max - t1Max)
  addSlab('tier2_5_10', km2, r2)
  remaining -= km2

  if (remaining > 0) {
    addSlab('beyond_10', remaining, rBeyond)
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
 * @param {object} [params.pricingConfig] - output of resolveVehiclePricingConfig
 * @param {object} [params.settings] - full settings (alternative to pricingConfig)
 * @param {string} [params.vehicleServiceKey]
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
  vehicleServiceKey = 'cercaZip',
  at,
}) => {
  const config =
    pricingConfig ||
    (settings
      ? resolveVehiclePricingConfig(settings, vehicleServiceKey)
      : normalizeFarePricingConfig(settings))
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
 * @param {number} distanceKm
 * @param {object} settings
 * @param {{ vehicleServiceKey?: string, at?: Date }} [options]
 */
const calculateDistanceFareForSettlement = (distanceKm, settings, options = {}) => {
  const vehicleServiceKey = options.vehicleServiceKey || 'cercaZip'
  const at = options.at
  const config = resolveVehiclePricingConfig(settings, vehicleServiceKey)
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
  vehicleServiceKey = 'cercaZip',
  at,
}) => {
  const config = normalizeIntercityFarePricingConfig(settings, vehicleServiceKey)
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
 * Seed farePricing (time bands only) from flat perKmRate for admin bootstrap.
 */
const seedFarePricingFromPerKmRate = (perKmRate, existing = {}) => {
  return {
    enabled: existing.enabled === true,
    timezone: existing.timezone || DEFAULT_TIMEZONE,
    timeBands:
      Array.isArray(existing.timeBands) && existing.timeBands.length
        ? existing.timeBands
        : DEFAULT_TIME_BANDS,
    timeMultiplierAppliesTo: existing.timeMultiplierAppliesTo || 'distanceAndTime',
  }
}

/**
 * Default 3-slab distance tiers for a vehicle service.
 */
const seedVehicleDistanceTiers = (perKmRate, vehicleServiceKey = 'cercaZip', existing = {}) => {
  const cityRate = Number(perKmRate) || 12
  const vehicleRate = Number(existing.beyondTier2RatePerKm) ||
    Number(existing.tier1?.ratePerKm) ||
    perKmDefaultForKey(vehicleServiceKey) ||
    cityRate
  const r1 = Number(existing.tier1?.ratePerKm) || vehicleRate
  const r2 = Number(existing.tier2?.ratePerKm) || r1
  const rBeyond = Number(existing.beyondTier2RatePerKm) || vehicleRate
  return {
    tier1: { maxKm: TIER1_MAX_KM, ratePerKm: r1 },
    tier2: { maxKm: TIER2_MAX_KM, ratePerKm: r2 },
    beyondTier2RatePerKm: rBeyond,
  }
}

/**
 * Validate vehicle distance tier payload; throws Error on invalid config.
 */
const validateVehicleDistanceTiers = (tiers, label = 'distanceTiers') => {
  const t1 = Number(tiers?.tier1?.maxKm ?? TIER1_MAX_KM)
  const t2 = Number(tiers?.tier2?.maxKm ?? TIER2_MAX_KM)
  if (!(t1 > 0 && t2 > t1)) {
    throw new Error(`${label}: tier maxKm must be strictly increasing (e.g. 5, 10)`)
  }
  for (const key of ['tier1', 'tier2']) {
    const rate = Number(tiers[key]?.ratePerKm)
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error(`${label}.${key}.ratePerKm must be a non-negative number`)
    }
  }
  const beyond = Number(tiers.beyondTier2RatePerKm ?? tiers.tier2?.ratePerKm)
  if (!Number.isFinite(beyond) || beyond < 0) {
    throw new Error(`${label}.beyondTier2RatePerKm must be a non-negative number`)
  }
}

/**
 * Validate farePricing payload (time bands); throws Error on invalid config.
 */
const validateFarePricingConfig = (farePricing) => {
  if (!farePricing || farePricing.enabled !== true) return

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
  at,
  vehicleServiceKey = 'cercaZip'
) => {
  const pricingConfig = settings
    ? resolveVehiclePricingConfig(settings, vehicleServiceKey)
    : {
        ...normalizeFarePricingConfig({
          pricingConfigurations: { perKmRate, minimumFare, farePricing: { enabled: false } },
        }),
        distanceTiers: buildTiersFromFlatRate(perKmRate),
      }
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
  TIER1_MAX_KM,
  TIER2_MAX_KM,
  roundMoney,
  parseHmToMinutes,
  getLocalTimeParts,
  isValidTimezone,
  resolveTimeBandMultiplier,
  buildTiersFromFlatRate,
  migrateLegacyCityTiersToVehicle,
  normalizeVehicleDistanceTiers,
  resolveVehicleDistanceTiersFromSettings,
  normalizeFarePricingConfig,
  resolveVehiclePricingConfig,
  normalizeIntercityFarePricingConfig,
  calculateTieredDistanceFare,
  getEffectivePerKmRate,
  calculateInstantFare,
  calculateDistanceFareForSettlement,
  calculateIntercityDistanceFare,
  seedFarePricingFromPerKmRate,
  seedVehicleDistanceTiers,
  validateVehicleDistanceTiers,
  validateFarePricingConfig,
  calculateFareWithTimeShim,
}
