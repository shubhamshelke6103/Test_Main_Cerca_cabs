'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  isPostRideRazorpay,
  getAllowedSettlementMethodsForRide,
  assertWalletSettlementAllowed
} = require('../utils/paymentOrchestrator/ridePaymentMode')

describe('isPostRideRazorpay', () => {
  it('true for post-ride RAZORPAY without payment id or wallet slice', () => {
    assert.equal(
      isPostRideRazorpay({
        paymentMethod: 'RAZORPAY',
        razorpayPaymentId: null,
        walletAmountUsed: 0
      }),
      true
    )
  })

  it('false for prepaid Razorpay at booking', () => {
    assert.equal(
      isPostRideRazorpay({
        paymentMethod: 'RAZORPAY',
        razorpayPaymentId: 'pay_abc123'
      }),
      false
    )
  })

  it('false for hybrid with walletAmountUsed', () => {
    assert.equal(
      isPostRideRazorpay({
        paymentMethod: 'RAZORPAY',
        walletAmountUsed: 50
      }),
      false
    )
  })

  it('false for WALLET', () => {
    assert.equal(
      isPostRideRazorpay({ paymentMethod: 'WALLET' }),
      false
    )
  })
})

describe('getAllowedSettlementMethodsForRide', () => {
  it('restricts post-ride Pay Online to razorpay and cash', () => {
    const methods = getAllowedSettlementMethodsForRide({
      paymentMethod: 'RAZORPAY'
    })
    assert.deepEqual(methods, ['razorpay', 'cash'])
  })

  it('allows wallet for WALLET bookings', () => {
    const methods = getAllowedSettlementMethodsForRide({
      paymentMethod: 'WALLET'
    })
    assert.ok(methods.includes('wallet'))
  })
})

describe('assertWalletSettlementAllowed', () => {
  it('throws PAYMENT_MODE_ONLINE_REQUIRED for post-ride Razorpay', () => {
    assert.throws(
      () =>
        assertWalletSettlementAllowed({
          paymentMethod: 'RAZORPAY'
        }),
      err => {
        assert.equal(err.code, 'PAYMENT_MODE_ONLINE_REQUIRED')
        assert.equal(err.statusCode, 409)
        return true
      }
    )
  })

  it('does not throw for WALLET booking', () => {
    assert.doesNotThrow(() =>
      assertWalletSettlementAllowed({ paymentMethod: 'WALLET' })
    )
  })
})
