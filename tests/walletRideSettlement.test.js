const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  computeSettlementDelta,
  roundMoney
} = require('../utils/walletRideSettlement')

test('roundMoney matches paise rounding', () => {
  assert.equal(roundMoney(674.234), 674.23)
  assert.equal(roundMoney(557.155), 557.16)
})

test('computeSettlementDelta refund case (674 held, 557 final)', () => {
  assert.equal(computeSettlementDelta(674.23, 557.16), 117.07)
})

test('computeSettlementDelta additional charge case', () => {
  assert.equal(computeSettlementDelta(500, 600), -100)
})

test('computeSettlementDelta balanced', () => {
  assert.equal(Math.abs(computeSettlementDelta(100.5, 100.5)), 0)
})
