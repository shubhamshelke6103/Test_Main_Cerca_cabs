const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  calculateTieredDistanceFare,
  resolveTimeBandMultiplier,
  normalizeFarePricingConfig,
  resolveVehiclePricingConfig,
  calculateInstantFare,
  getEffectivePerKmRate,
  calculateDistanceFareForSettlement,
  calculateIntercityDistanceFare,
  validateFarePricingConfig,
  validateVehicleDistanceTiers,
  seedFarePricingFromPerKmRate,
  seedVehicleDistanceTiers,
  migrateLegacyCityTiersToVehicle,
  resolveVehicleDistanceTiersFromSettings,
} = require('../utils/farePricingEngine')

const tiersSample = {
  tier1: { maxKm: 5, ratePerKm: 10 },
  tier2: { maxKm: 10, ratePerKm: 12 },
  beyondTier2RatePerKm: 14,
}

const legacyCityTiers = {
  tier1: { maxKm: 10, ratePerKm: 10 },
  tier2: { maxKm: 20, ratePerKm: 12 },
  tier3: { maxKm: 30, ratePerKm: 14 },
  beyondTier3RatePerKm: 14,
}

const settingsWithVehicleTiers = {
  pricingConfigurations: {
    perKmRate: 10,
    minimumFare: 0,
    farePricing: {
      enabled: true,
      timezone: 'Asia/Kolkata',
      timeBands: [
        { id: 'night', start: '22:00', end: '06:00', multiplier: 1.8 },
        { id: 'day', start: '06:00', end: '22:00', multiplier: 1 },
      ],
    },
  },
  vehicleServices: {
    cercaZip: {
      distanceTiers: {
        tier1: { maxKm: 5, ratePerKm: 10 },
        tier2: { maxKm: 10, ratePerKm: 10 },
        beyondTier2RatePerKm: 12,
      },
    },
    cercaTitan: {
      distanceTiers: {
        tier1: { maxKm: 5, ratePerKm: 20 },
        tier2: { maxKm: 10, ratePerKm: 20 },
        beyondTier2RatePerKm: 25,
      },
    },
  },
}

test('tiered distance: 5 km uses tier1 only', () => {
  const { total, breakdown } = calculateTieredDistanceFare(5, tiersSample)
  assert.equal(total, 50)
  assert.equal(breakdown.length, 1)
  assert.equal(breakdown[0].tier, 'tier1_0_5')
})

test('tiered distance: 7 km splits tier1 and tier2', () => {
  const { total } = calculateTieredDistanceFare(7, tiersSample)
  assert.equal(total, 5 * 10 + 2 * 12)
})

test('tiered distance: 15 km includes beyond slab', () => {
  const { total, breakdown } = calculateTieredDistanceFare(15, tiersSample)
  assert.equal(total, 5 * 10 + 5 * 12 + 5 * 14)
  assert.equal(breakdown[2].tier, 'beyond_10')
})

test('tiered distance: fractional km', () => {
  const { total } = calculateTieredDistanceFare(5.5, tiersSample)
  assert.equal(total, 5 * 10 + 0.5 * 12)
})

test('getEffectivePerKmRate matches total/distance', () => {
  const d = 15
  const { total } = calculateTieredDistanceFare(d, tiersSample)
  assert.equal(getEffectivePerKmRate(d, tiersSample), Math.round((total / d) * 100) / 100)
})

test('normalizeFarePricingConfig disabled uses flat perKmRate tiers via resolveVehiclePricingConfig', () => {
  const cfg = resolveVehiclePricingConfig(
    {
      pricingConfigurations: { perKmRate: 24, minimumFare: 100, farePricing: { enabled: false } },
    },
    'cercaZip'
  )
  assert.equal(cfg.enabled, false)
  const { total } = calculateTieredDistanceFare(5, cfg.distanceTiers)
  assert.equal(total, 5 * 24)
})

test('resolveVehiclePricingConfig uses per-vehicle tiers when enabled', () => {
  const zipCfg = resolveVehiclePricingConfig(settingsWithVehicleTiers, 'cercaZip')
  const titanCfg = resolveVehiclePricingConfig(settingsWithVehicleTiers, 'cercaTitan')
  const zipFare = calculateTieredDistanceFare(15, zipCfg.distanceTiers).total
  const titanFare = calculateTieredDistanceFare(15, titanCfg.distanceTiers).total
  assert.ok(titanFare > zipFare)
})

test('legacy city tier fallback until migrated', () => {
  const settings = {
    pricingConfigurations: {
      perKmRate: 10,
      farePricing: {
        enabled: true,
        distanceTiers: legacyCityTiers,
      },
    },
    vehicleServices: { cercaZip: {} },
    intercityPricingConfigurations: { perKmRates: { cercaZip: 10 } },
  }
  const tiers = resolveVehicleDistanceTiersFromSettings(settings, 'cercaZip')
  assert.equal(tiers.tier1.maxKm, 5)
  assert.equal(tiers.tier2.maxKm, 10)
  assert.ok(tiers.beyondTier2RatePerKm > 0)
})

test('resolveTimeBandMultiplier: day band at noon IST', () => {
  const at = new Date('2024-06-15T07:00:00.000Z')
  const { timeBandId, timeMultiplier } = resolveTimeBandMultiplier(at, undefined, 'Asia/Kolkata')
  assert.equal(timeBandId, 'day')
  assert.equal(timeMultiplier, 1)
})

test('resolveTimeBandMultiplier: night band at 23:00 IST', () => {
  const at = new Date('2024-06-15T17:30:00.000Z')
  const { timeBandId, timeMultiplier } = resolveTimeBandMultiplier(at, undefined, 'Asia/Kolkata')
  assert.equal(timeBandId, 'night')
  assert.equal(timeMultiplier, 1.8)
})

test('calculateInstantFare applies multiplier to distance and time', () => {
  const at = new Date('2024-06-15T17:30:00.000Z')
  const r = calculateInstantFare({
    basePrice: 100,
    distanceKm: 5,
    durationMin: 10,
    perMinuteRate: 2,
    minimumFare: 0,
    settings: settingsWithVehicleTiers,
    vehicleServiceKey: 'cercaZip',
    at,
  })
  const rawDist = 5 * 10
  const rawTime = 20
  assert.equal(r.rawDistanceFare, rawDist)
  assert.equal(r.distanceFare, rawDist * 1.8)
  assert.equal(r.timeFare, rawTime * 1.8)
})

test('calculateInstantFare applies minimum fare', () => {
  const r = calculateInstantFare({
    basePrice: 10,
    distanceKm: 0,
    durationMin: 0,
    perMinuteRate: 0,
    minimumFare: 200,
    settings: { pricingConfigurations: { perKmRate: 12, minimumFare: 200 } },
  })
  assert.equal(r.fareAfterMinimum, 200)
})

test('calculateDistanceFareForSettlement with enabled pricing and vehicle key', () => {
  const settlementSettings = {
    ...settingsWithVehicleTiers,
    pricingConfigurations: {
      ...settingsWithVehicleTiers.pricingConfigurations,
      farePricing: {
        ...settingsWithVehicleTiers.pricingConfigurations.farePricing,
        timeBands: [{ id: 'day', start: '00:00', end: '00:00', multiplier: 1 }],
      },
    },
  }
  const at = new Date('2024-06-15T07:00:00.000Z')
  const r = calculateDistanceFareForSettlement(10, settlementSettings, {
    vehicleServiceKey: 'cercaZip',
    at,
  })
  assert.equal(r.amount, 5 * 10 + 5 * 10)
})

test('calculateIntercityDistanceFare uses per-vehicle tiers', () => {
  const r = calculateIntercityDistanceFare({
    distanceKm: 15,
    durationMin: 0,
    perMinuteRate: 0,
    settings: settingsWithVehicleTiers,
    vehicleServiceKey: 'cercaTitan',
  })
  assert.equal(r.distanceFare, 5 * 20 + 5 * 20 + 5 * 25)
})

test('validateVehicleDistanceTiers rejects bad tier order', () => {
  assert.throws(() =>
    validateVehicleDistanceTiers({
      tier1: { maxKm: 10, ratePerKm: 1 },
      tier2: { maxKm: 5, ratePerKm: 1 },
      beyondTier2RatePerKm: 1,
    })
  )
})

test('validateFarePricingConfig rejects missing time bands when enabled', () => {
  assert.throws(() =>
    validateFarePricingConfig({
      enabled: true,
      timeBands: [],
    })
  )
})

test('seedFarePricingFromPerKmRate has time bands only', () => {
  const s = seedFarePricingFromPerKmRate(15)
  assert.ok(s.timeBands.length >= 4)
  assert.equal(s.distanceTiers, undefined)
})

test('seedVehicleDistanceTiers per vehicle defaults', () => {
  const zip = seedVehicleDistanceTiers(12, 'cercaZip')
  const titan = seedVehicleDistanceTiers(12, 'cercaTitan')
  assert.equal(zip.beyondTier2RatePerKm, 10)
  assert.equal(titan.beyondTier2RatePerKm, 16)
})

test('migrateLegacyCityTiersToVehicle maps old slabs', () => {
  const migrated = migrateLegacyCityTiersToVehicle(legacyCityTiers, 10, 12)
  assert.equal(migrated.tier1.ratePerKm, 10)
  assert.equal(migrated.tier2.ratePerKm, 10)
  assert.equal(migrated.beyondTier2RatePerKm, 12)
})
