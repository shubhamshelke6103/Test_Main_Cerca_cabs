const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  calculateFareWithTime,
  getPricingSubstantiveThresholds,
  evaluateSubstantiveInstantTrip
} = require('../utils/ride_booking_functions')

test('calculateFareWithTime is deterministic for identical inputs', () => {
  const a = calculateFareWithTime(499, 10, 20, 24, 3, 20)
  const b = calculateFareWithTime(499, 10, 20, 24, 3, 20)
  assert.equal(a.fareAfterMinimum, b.fareAfterMinimum)
  assert.equal(a.subtotal, b.subtotal)
})

test('calculateFareWithTime applies minimum fare floor', () => {
  const low = calculateFareWithTime(50, 0, 0, 24, 3, 200)
  assert.equal(low.fareAfterMinimum, 200)
})

test('substantive trip: near-zero distance and short duration is not substantive (no quote floor)', () => {
  const thresholds = getPricingSubstantiveThresholds({})
  const r = evaluateSubstantiveInstantTrip({
    thresholds,
    actualDurationMinutes: 1,
    actualDistanceKm: 0.01,
    estimatedDistanceKm: 12
  })
  assert.equal(r.substantiveTrip, false)
  assert.equal(r.durationOk, false)
})

test('substantive trip: long enough duration and distance meets max(minKm, fraction×estimate)', () => {
  const thresholds = getPricingSubstantiveThresholds({})
  const r = evaluateSubstantiveInstantTrip({
    thresholds,
    actualDurationMinutes: 15,
    actualDistanceKm: 0.6,
    estimatedDistanceKm: 10
  })
  assert.equal(r.substantiveTrip, true)
})

test('substantive trip: zero duration (no start) is never substantive', () => {
  const thresholds = getPricingSubstantiveThresholds({})
  const r = evaluateSubstantiveInstantTrip({
    thresholds,
    actualDurationMinutes: 0,
    actualDistanceKm: 50,
    estimatedDistanceKm: 50
  })
  assert.equal(r.substantiveTrip, false)
})

test('substantive trip: long duration but distance below max(minKm, fraction×estimate) is not substantive', () => {
  const thresholds = getPricingSubstantiveThresholds({})
  const r = evaluateSubstantiveInstantTrip({
    thresholds,
    actualDurationMinutes: 20,
    actualDistanceKm: 0.2,
    estimatedDistanceKm: 20
  })
  assert.equal(r.substantiveTrip, false)
  assert.equal(r.distanceOk, false)
})
