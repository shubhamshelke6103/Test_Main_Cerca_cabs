const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  buildPickupWaitAdminDetail,
  parsePolicyVersion,
  formatDurationLabel
} = require('../utils/pickupWaitAdminDetail')

test('formatDurationLabel', () => {
  assert.equal(formatDurationLabel(45), '45s')
  assert.equal(formatDurationLabel(120), '2m')
  assert.equal(formatDurationLabel(372), '6m 12s')
})

test('parsePolicyVersion valid', () => {
  const { policy, policySource } = parsePolicyVersion('5:8:4:2')
  assert.equal(policySource, 'snapshot')
  assert.equal(policy.pickupWaitFreeMinutes, 5)
  assert.equal(policy.pickupWaitTier1EndMinute, 8)
  assert.equal(policy.pickupWaitTier1RatePerMin, 4)
  assert.equal(policy.pickupWaitTier2RatePerMin, 2)
})

test('parsePolicyVersion invalid uses default', () => {
  const { policySource } = parsePolicyVersion('bad')
  assert.equal(policySource, 'default_fallback')
})

test('10 min wait: tier1 3 @ 4 + tier2 2 @ 2 = 16', () => {
  const ride = {
    status: 'completed',
    driverArrivedAt: new Date('2026-01-01T12:00:00Z'),
    actualStartTime: new Date('2026-01-01T12:10:00Z'),
    fareBreakdown: { pickupWaitCharge: 16 },
    pickupWait: {
      policyVersion: '5:8:4:2',
      waitDurationSeconds: 600,
      waitStartedAt: new Date('2026-01-01T12:00:00Z'),
      waitEndedAt: new Date('2026-01-01T12:10:00Z'),
      tier1BillableMinutes: 3,
      tier2BillableMinutes: 2,
      amountTier1: 12,
      amountTier2: 4,
      totalPickupWaitCharge: 16,
      freeMinutesApplied: 5
    }
  }
  const d = buildPickupWaitAdminDetail(ride)
  assert.equal(d.present, true)
  assert.equal(d.durationSeconds, 600)
  assert.equal(d.durationLabel, '10m')
  assert.equal(d.totalPickupWaitCharge, 16)
  assert.equal(d.billingAligned, true)
  assert.match(d.summaryLine, /₹16\.00/)
  const tierA = d.billingLines.find((l) => l.kind === 'tier_a')
  assert.ok(tierA)
  assert.equal(tierA.minutes, 3)
})

test('no pickup data returns present false', () => {
  const d = buildPickupWaitAdminDetail({ status: 'requested' })
  assert.equal(d.present, false)
})

test('fareBreakdown mismatch sets billingNote', () => {
  const ride = {
    status: 'completed',
    driverArrivedAt: new Date('2026-01-01T12:00:00Z'),
    actualStartTime: new Date('2026-01-01T12:10:00Z'),
    fareBreakdown: { pickupWaitCharge: 99 },
    pickupWait: {
      policyVersion: '5:8:4:2',
      waitDurationSeconds: 600,
      tier1BillableMinutes: 3,
      tier2BillableMinutes: 2,
      amountTier1: 12,
      amountTier2: 4,
      totalPickupWaitCharge: 16
    }
  }
  const d = buildPickupWaitAdminDetail(ride)
  assert.equal(d.billingAligned, false)
  assert.ok(d.billingNote)
})
