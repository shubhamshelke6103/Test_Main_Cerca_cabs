const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  calculateTieredDistanceFare,
  resolveTimeBandMultiplier,
  normalizeFarePricingConfig,
  calculateInstantFare,
  getEffectivePerKmRate,
  calculateDistanceFareForSettlement,
  validateFarePricingConfig,
  seedFarePricingFromPerKmRate,
} = require('../utils/farePricingEngine')

const tiersSample = {
  tier1: { maxKm: 10, ratePerKm: 10 },
  tier2: { maxKm: 20, ratePerKm: 12 },
  tier3: { maxKm: 30, ratePerKm: 14 },
  beyondTier3RatePerKm: 14,
}

test('tiered distance: 10 km uses tier1 only', () => {
  const { total, breakdown } = calculateTieredDistanceFare(10, tiersSample)
  assert.equal(total, 100)
  assert.equal(breakdown.length, 1)
  assert.equal(breakdown[0].tier, 'tier1_0_10')
})

test('tiered distance: 15 km splits tier1 and tier2', () => {
  const { total } = calculateTieredDistanceFare(15, tiersSample)
  assert.equal(total, 10 * 10 + 5 * 12)
})

test('tiered distance: 31 km includes beyond slab', () => {
  const { total } = calculateTieredDistanceFare(31, tiersSample)
  assert.equal(total, 10 * 10 + 10 * 12 + 10 * 14 + 1 * 14)
})

test('tiered distance: fractional km', () => {
  const { total } = calculateTieredDistanceFare(10.5, tiersSample)
  assert.equal(total, 10 * 10 + 0.5 * 12)
})

test('getEffectivePerKmRate matches total/distance', () => {
  const d = 25
  const { total } = calculateTieredDistanceFare(d, tiersSample)
  assert.equal(getEffectivePerKmRate(d, tiersSample), Math.round((total / d) * 100) / 100)
})

test('normalizeFarePricingConfig disabled uses flat perKmRate tiers', () => {
  const cfg = normalizeFarePricingConfig({
    pricingConfigurations: { perKmRate: 24, minimumFare: 100, farePricing: { enabled: false } },
  })
  assert.equal(cfg.enabled, false)
  const { total } = calculateTieredDistanceFare(5, cfg.distanceTiers)
  assert.equal(total, 5 * 24)
})

test('resolveTimeBandMultiplier: day band at noon IST', () => {
  // 2024-06-15 12:30 IST = 07:00 UTC
  const at = new Date('2024-06-15T07:00:00.000Z')
  const { timeBandId, timeMultiplier } = resolveTimeBandMultiplier(at, undefined, 'Asia/Kolkata')
  assert.equal(timeBandId, 'day')
  assert.equal(timeMultiplier, 1)
})

test('resolveTimeBandMultiplier: night band at 23:00 IST', () => {
  const at = new Date('2024-06-15T17:30:00.000Z') // 23:00 IST
  const { timeBandId, timeMultiplier } = resolveTimeBandMultiplier(at, undefined, 'Asia/Kolkata')
  assert.equal(timeBandId, 'night')
  assert.equal(timeMultiplier, 1.8)
})

test('calculateInstantFare applies multiplier to distance and time', () => {
  const at = new Date('2024-06-15T17:30:00.000Z') // night 1.8x IST
  const settings = {
    pricingConfigurations: {
      perKmRate: 10,
      minimumFare: 0,
      farePricing: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        distanceTiers: tiersSample,
        timeBands: [
          { id: 'night', start: '22:00', end: '06:00', multiplier: 1.8 },
          { id: 'day', start: '06:00', end: '22:00', multiplier: 1 },
        ],
      },
    },
  }
  const r = calculateInstantFare({
    basePrice: 100,
    distanceKm: 5,
    durationMin: 10,
    perMinuteRate: 2,
    minimumFare: 0,
    settings,
    at,
  })
  const rawDist = 5 * 10
  const rawTime = 20
  assert.equal(r.rawDistanceFare, rawDist)
  assert.equal(r.distanceFare, rawDist * 1.8)
  assert.equal(r.timeFare, rawTime * 1.8)
  assert.equal(r.subtotal, 100 + rawDist * 1.8 + rawTime * 1.8)
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

test('calculateDistanceFareForSettlement with enabled pricing', () => {
  const settings = {
    pricingConfigurations: {
      perKmRate: 10,
      farePricing: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        distanceTiers: tiersSample,
        timeBands: [{ id: 'day', start: '00:00', end: '00:00', multiplier: 1 }],
      },
    },
  }
  const at = new Date('2024-06-15T07:00:00.000Z')
  const r = calculateDistanceFareForSettlement(10, settings, at)
  assert.equal(r.amount, 100)
})

test('validateFarePricingConfig rejects bad tier order', () => {
  assert.throws(() =>
    validateFarePricingConfig({
      enabled: true,
      distanceTiers: {
        tier1: { maxKm: 30, ratePerKm: 1 },
        tier2: { maxKm: 20, ratePerKm: 1 },
        tier3: { maxKm: 10, ratePerKm: 1 },
      },
      timeBands: [{ id: 'd', start: '00:00', end: '23:59', multiplier: 1 }],
    })
  )
})

test('seedFarePricingFromPerKmRate', () => {
  const s = seedFarePricingFromPerKmRate(15)
  assert.equal(s.distanceTiers.tier1.ratePerKm, 15)
  assert.equal(s.distanceTiers.beyondTier3RatePerKm, 15)
  assert.ok(s.timeBands.length >= 4)
})
