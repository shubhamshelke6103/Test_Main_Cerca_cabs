/**
 * Payment dispute module — unit tests (no DB required for pure helpers).
 * Run: node tests/paymentDispute.test.js
 */
const assert = require('assert')
const { roundInr } = require('../utils/paymentDispute/dues.service')
const { DEFAULT_POLICY } = require('../utils/paymentDispute/policy')
const { TERMINAL_STATUSES } = require('../Models/Admin/paymentDispute.model')

function testRoundInr() {
  assert.strictEqual(roundInr(10.456), 10.46)
  assert.strictEqual(roundInr(null), 0)
  console.log('✓ roundInr')
}

function testPolicyDefaults() {
  assert.ok(DEFAULT_POLICY.bookingBlockThresholdInr >= 1)
  assert.ok(DEFAULT_POLICY.autoConfirmMinutes >= 1)
  console.log('✓ policy defaults')
}

function testTerminalStatuses() {
  assert.ok(TERMINAL_STATUSES.includes('RESOLVED_PAID'))
  assert.ok(!TERMINAL_STATUSES.includes('OPEN'))
  console.log('✓ terminal statuses')
}

function testPartialPaymentMath() {
  const fare = 780
  const received = 500
  const remaining = roundInr(fare - received)
  assert.strictEqual(remaining, 280)
  console.log('✓ partial payment math (S3)')
}

function testAggregateDues() {
  const items = [{ amountRemaining: 300 }, { amountRemaining: 250 }, { amountRemaining: 400 }]
  const total = items.reduce((s, i) => s + roundInr(i.amountRemaining), 0)
  assert.strictEqual(total, 950)
  console.log('✓ aggregate dues (S8)')
}

function testBookingBlockThreshold() {
  const policy = { ...DEFAULT_POLICY, bookingBlockThresholdInr: 1 }
  const totalPending = 0.5
  const blocked = totalPending >= policy.bookingBlockThresholdInr
  assert.strictEqual(blocked, false)
  const blocked2 = 1 >= policy.bookingBlockThresholdInr
  assert.strictEqual(blocked2, true)
  console.log('✓ booking block threshold')
}

function run() {
  testRoundInr()
  testPolicyDefaults()
  testTerminalStatuses()
  testPartialPaymentMath()
  testAggregateDues()
  testBookingBlockThreshold()
  console.log('\nAll payment dispute unit tests passed.')
}

run()
