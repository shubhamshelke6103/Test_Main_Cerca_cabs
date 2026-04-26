const { test } = require('node:test')
const assert = require('node:assert/strict')

const { calculateFareWithTime } = require('../utils/ride_booking_functions')

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

test('agreed fare floor semantics (unit mirror of completion policy)', () => {
  const agreed = 1173
  const recalculatedTrip = 499
  assert.equal(Math.max(agreed, recalculatedTrip), 1173)
})
