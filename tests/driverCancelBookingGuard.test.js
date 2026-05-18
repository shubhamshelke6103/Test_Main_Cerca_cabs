'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  toRiderInProgressCancelBillingSummary
} = require('../utils/ride_booking_functions')
const {
  isPostRideRazorpay,
  getAllowedSettlementMethodsForRide
} = require('../utils/paymentOrchestrator/ridePaymentMode')

describe('toRiderInProgressCancelBillingSummary allowedSettlementMethods', () => {
  it('includes allowedSettlementMethods when present on settlement', () => {
    const summary = toRiderInProgressCancelBillingSummary({
      additionalDue: 50,
      allowedSettlementMethods: ['razorpay', 'cash'],
      riderPaymentStatus: 'pending'
    })
    assert.deepEqual(summary.allowedSettlementMethods, ['razorpay', 'cash'])
  })
})

describe('outstanding settlement item shape', () => {
  it('post-ride RAZORPAY restricts methods for client routing', () => {
    const ride = {
      paymentMethod: 'RAZORPAY',
      razorpayPaymentId: null,
      walletAmountUsed: 0
    }
    assert.equal(isPostRideRazorpay(ride), true)
    assert.deepEqual(getAllowedSettlementMethodsForRide(ride), [
      'razorpay',
      'cash'
    ])
  })
})
