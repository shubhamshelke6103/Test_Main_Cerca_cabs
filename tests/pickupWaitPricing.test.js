const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  computePickupWaitingCharge,
  buildPickupWaitSnapshot,
  getPickupWaitPolicyFromSettings,
  DEFAULT_POLICY
} = require('../utils/pickupWaitPricing')

const policy = { ...DEFAULT_POLICY }

test('4m wait: ₹0', () => {
  const c = computePickupWaitingCharge(4 * 60, policy)
  assert.equal(c.totalPickupWaitCharge, 0)
})

test('5m wait: ₹0 (at free boundary)', () => {
  const c = computePickupWaitingCharge(5 * 60, policy)
  assert.equal(c.totalPickupWaitCharge, 0)
})

test('5m 1s → ceil 6m: ₹4', () => {
  const c = computePickupWaitingCharge(5 * 60 + 1, policy)
  assert.equal(c.waitMinutesCeil, 6)
  assert.equal(c.tier1BillableMinutes, 1)
  assert.equal(c.totalPickupWaitCharge, 4)
})

test('6m: ₹4', () => {
  const c = computePickupWaitingCharge(6 * 60, policy)
  assert.equal(c.tier1BillableMinutes, 1)
  assert.equal(c.totalPickupWaitCharge, 4)
})

test('8m: ₹12 (3 min × ₹4)', () => {
  const c = computePickupWaitingCharge(8 * 60, policy)
  assert.equal(c.tier1BillableMinutes, 3)
  assert.equal(c.tier2BillableMinutes, 0)
  assert.equal(c.totalPickupWaitCharge, 12)
})

test('10m: ₹12 + 2×₹2 = ₹16', () => {
  const c = computePickupWaitingCharge(10 * 60, policy)
  assert.equal(c.tier1BillableMinutes, 3)
  assert.equal(c.tier2BillableMinutes, 2)
  assert.equal(c.totalPickupWaitCharge, 16)
})

test('buildPickupWaitSnapshot without arrival: zero charge', () => {
  const end = new Date('2026-01-15T12:00:00Z')
  const s = buildPickupWaitSnapshot(null, end, policy)
  assert.equal(s.totalPickupWaitCharge, 0)
  assert.equal(s.waitDurationSeconds, 0)
})

test('getPickupWaitPolicyFromSettings uses defaults when missing', () => {
  const p = getPickupWaitPolicyFromSettings({})
  assert.equal(p.pickupWaitFreeMinutes, 5)
  assert.equal(p.pickupWaitTier1EndMinute, 8)
})
