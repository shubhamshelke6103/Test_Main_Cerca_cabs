const { test } = require('node:test');
const assert = require('node:assert');
const {
  calculateHaversineDistance,
  getTravelTimeAndDistance
} = require('../utils/proximityRide.service');

test('calculateHaversineDistance', (t) => {
  // Test with known coordinates (New Delhi to Mumbai approx distance)
  const delhi = [77.1025, 28.7041]; // [lng, lat]
  const mumbai = [72.8777, 19.0760];

  const distance = calculateHaversineDistance(delhi, mumbai);
  assert.ok(distance > 1100 && distance < 1200, `Distance should be around 1150km, got ${distance}`);

  // Test same point
  const samePoint = calculateHaversineDistance(delhi, delhi);
  assert.equal(samePoint, 0, 'Same point should have 0 distance');
});

test('getTravelTimeAndDistance fallback', async (t) => {
  // Test fallback calculation (without API key)
  const origin = [77.1025, 28.7041];
  const destination = [72.8777, 19.0760];

  const result = await getTravelTimeAndDistance(origin, destination);

  assert.ok(result.durationMinutes > 0, 'Should have duration');
  assert.ok(result.distanceKm > 1100 && result.distanceKm < 1200, `Distance should be around 1150km, got ${result.distanceKm}`);
  assert.ok(['OK', 'FALLBACK', 'ERROR_FALLBACK'].includes(result.status), 'Should have valid status');
});