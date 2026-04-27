const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeCancellationReasonCode,
  shouldBlockCancelWithinDropRadius,
  CANCEL_BLOCK_WITHIN_DROP_RADIUS_METERS
} = require('../utils/cancellationPolicy')

test('normalizeCancellationReasonCode accepts known reason code', () => {
  assert.equal(
    normalizeCancellationReasonCode('RIDER_PICKUP_SHIFT_TOO_FAR'),
    'RIDER_PICKUP_SHIFT_TOO_FAR'
  )
})

test('normalizeCancellationReasonCode falls back to GENERAL', () => {
  assert.equal(normalizeCancellationReasonCode('random-value'), 'GENERAL')
})

test('shouldBlockCancelWithinDropRadius blocks within configured threshold', () => {
  assert.equal(
    shouldBlockCancelWithinDropRadius(CANCEL_BLOCK_WITHIN_DROP_RADIUS_METERS),
    true
  )
  assert.equal(
    shouldBlockCancelWithinDropRadius(CANCEL_BLOCK_WITHIN_DROP_RADIUS_METERS + 1),
    false
  )
})
