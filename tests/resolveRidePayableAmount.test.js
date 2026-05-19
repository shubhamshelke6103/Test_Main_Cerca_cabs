'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  resolveRidePayableAmount,
  buildRidePaymentSummary
} = require('../utils/paymentOrchestrator/resolveRidePayableAmount')

const basePostRide = {
  _id: 'ride1',
  rider: 'user1',
  status: 'completed',
  paymentMethod: 'RAZORPAY',
  paymentStatus: 'pending',
  razorpayPaymentId: null,
  walletAmountUsed: 0
}

describe('resolveRidePayableAmount', () => {
  it('uses ride.fare when positive', () => {
    const r = resolveRidePayableAmount({ ...basePostRide, fare: 250 })
    assert.equal(r.ok, true)
    assert.equal(r.amount, 250)
    assert.equal(r.source, 'fare')
  })

  it('falls back to fareBreakdown.finalFare', () => {
    const r = resolveRidePayableAmount({
      ...basePostRide,
      fare: 0,
      fareBreakdown: { finalFare: 180.5 }
    })
    assert.equal(r.ok, true)
    assert.equal(r.amount, 180.5)
    assert.equal(r.source, 'fareBreakdown.finalFare')
  })

  it('returns PAYABLE_AMOUNT_INVALID when all amounts zero', () => {
    const r = resolveRidePayableAmount({
      ...basePostRide,
      fare: 0,
      fareBreakdown: { finalFare: 0 }
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'PAYABLE_AMOUNT_INVALID')
  })

  it('rejects non post-ride razorpay when required', () => {
    const r = resolveRidePayableAmount({
      ...basePostRide,
      fare: 100,
      razorpayPaymentId: 'pay_abc'
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'NOT_POST_RIDE_RAZORPAY')
  })
})

describe('buildRidePaymentSummary', () => {
  it('includes amountDue and addresses', () => {
    const summary = buildRidePaymentSummary(
      {
        ...basePostRide,
        fare: 99,
        pickupAddress: 'A',
        dropoffAddress: 'B',
        actualDuration: 15
      },
      'user1'
    )
    assert.equal(summary.amountDue, 99)
    assert.equal(summary.pickupAddress, 'A')
    assert.equal(summary.canPayOnline, true)
    assert.equal(summary.isAuthorized, true)
  })
})
