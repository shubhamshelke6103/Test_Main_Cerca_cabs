const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  calculateIntercityFareBreakdown,
  getIntercityPricingConfig
} = require('../utils/ride_booking_functions')

const settings = {
  intercityPricingConfigurations: {
    enabled: true,
    baseFare: 100,
    perKmRates: {
      cercaZip: 10,
      cercaGlide: 12,
      cercaTitan: 16
    },
    tollChargeDefault: 50,
    parkingChargeDefault: 20,
    roundTripAllowance: {
      first24Hours: 300,
      next24Hours: 500,
      subsequent24Hours: 500
    },
    dailyDistanceAllowance: {
      thresholdKm: 300,
      cercaZipPerKm: 10,
      cercaGlidePerKm: 12,
      cercaTitanPerKm: 16
    },
    matching: {
      batchSize: 5,
      batchWaitSeconds: 45,
      scheduledMatchLeadMinutes: 1440,
      cronIntervalMinutes: 5
    }
  }
}

test('intercity config falls back to defaults', () => {
  const config = getIntercityPricingConfig({})
  assert.equal(config.enabled, true)
  assert.equal(config.matching.batchSize, 5)
})

test('one-way intercity fare includes distance, toll and parking', () => {
  const breakdown = calculateIntercityFareBreakdown({
    pickupLocation: { coordinates: [77.209, 28.6139] },
    dropoffLocation: { coordinates: [77.259, 28.6439] },
    durationMinutes: 120,
    vehicleType: 'cercaZip',
    tripMode: 'one_way',
    tollCharges: 50,
    parkingCharges: 20,
    settings
  })

  assert.equal(breakdown.baseFare, 100)
  assert.equal(breakdown.tollCharges, 50)
  assert.equal(breakdown.parkingCharges, 20)
  assert.ok(breakdown.distanceKm > 0)
  assert.ok(breakdown.finalFare > breakdown.baseFare)
})

test('round-trip intercity fare adds allowance and daily distance charge', () => {
  const breakdown = calculateIntercityFareBreakdown({
    pickupLocation: { coordinates: [77.209, 28.6139] },
    dropoffLocation: { coordinates: [81.0, 24.0] },
    durationMinutes: 48 * 60,
    vehicleType: 'cercaGlide',
    tripMode: 'round_trip',
    tollCharges: 0,
    parkingCharges: 0,
    settings
  })

  assert.ok(breakdown.distanceKm > 300)
  assert.equal(breakdown.driverAllowance > 800, true)
  assert.ok(breakdown.finalFare > 0)
})
