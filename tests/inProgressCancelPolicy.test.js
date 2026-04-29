'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  toRiderInProgressCancelBillingSummary,
  impliedPerKmFromBooking
} = require('../utils/ride_booking_functions')

describe('toRiderInProgressCancelBillingSummary', () => {
  it('returns rider-safe fields only', () => {
    const summary = toRiderInProgressCancelBillingSummary({
      partialDistanceKm: 4.2,
      perKmRateUsed: 18,
      perKmRateSource: 'booking_implied',
      driverPartialAmount: 75.6,
      riderPenaltyAmount: 50,
      riderTotalCharge: 125.6,
      prepaidTotal: 100,
      additionalDue: 25.6,
      refundDue: 0,
      riderPaymentStatus: 'pending',
      driverCoordsAtCancel: [72.8, 19.1],
      ledgerFinalizedAt: null,
      settlementVersion: 1
    })
    assert.ok(summary)
    assert.equal(summary.partialDistanceKm, 4.2)
    assert.equal(summary.perKmRateSource, 'booking_implied')
    assert.equal(summary.billingNote, 'distance_based_partial')
    assert.equal('driverCoordsAtCancel' in summary, false)
    assert.equal('ledgerFinalizedAt' in summary, false)
  })

  it('returns null for empty input', () => {
    assert.equal(toRiderInProgressCancelBillingSummary(null), null)
    assert.equal(toRiderInProgressCancelBillingSummary(undefined), null)
  })
})

describe('impliedPerKmFromBooking', () => {
  it('uses fareAtBooking over estimatedDistanceInKm', () => {
    const r = impliedPerKmFromBooking({
      fareAtBooking: 200,
      estimatedDistanceInKm: 10
    })
    assert.equal(r, 20)
  })

  it('falls back to fare when fareAtBooking missing', () => {
    const r = impliedPerKmFromBooking({
      fare: 150,
      estimatedDistanceInKm: 15
    })
    assert.equal(r, 10)
  })

  it('returns null when distance invalid', () => {
    assert.equal(
      impliedPerKmFromBooking({ fare: 100, estimatedDistanceInKm: 0 }),
      null
    )
    assert.equal(impliedPerKmFromBooking({ fare: 0, estimatedDistanceInKm: 5 }), null)
  })
})
