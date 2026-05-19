const logger = require('../logger')
const { isPostRideRazorpay } = require('./ridePaymentMode')

function roundMoney (n) {
  return Math.round(Number(n) * 100) / 100
}

function firstPositive (...candidates) {
  for (const { value, source } of candidates) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) {
      return { amount: roundMoney(n), source }
    }
  }
  return { amount: 0, source: 'none' }
}

/**
 * Resolve the amount a rider should pay for a completed post-ride Pay Online trip.
 * @param {object} ride - ride document or plain object
 * @param {{ requirePostRideRazorpay?: boolean }} [options]
 * @returns {{ ok: boolean, amount: number, source: string, code?: string, message?: string }}
 */
function resolveRidePayableAmount (ride, options = {}) {
  const requirePostRide = options.requirePostRideRazorpay !== false

  if (!ride) {
    return {
      ok: false,
      amount: 0,
      source: 'none',
      code: 'RIDE_NOT_FOUND',
      message: 'Ride not found'
    }
  }

  if (ride.status !== 'completed') {
    return {
      ok: false,
      amount: 0,
      source: 'none',
      code: 'RIDE_NOT_COMPLETED',
      message: 'Ride must be completed before payment'
    }
  }

  if (requirePostRide && !isPostRideRazorpay(ride)) {
    return {
      ok: false,
      amount: 0,
      source: 'none',
      code: 'NOT_POST_RIDE_RAZORPAY',
      message: 'Ride is not eligible for post-ride online payment'
    }
  }

  if (String(ride.paymentStatus || '').toLowerCase() === 'completed') {
    return {
      ok: false,
      amount: 0,
      source: 'none',
      code: 'PAYMENT_ALREADY_COMPLETED',
      message: 'Payment already completed for this ride'
    }
  }

  const resolved = firstPositive(
    { value: ride.fare, source: 'fare' },
    { value: ride.fareBreakdown?.finalFare, source: 'fareBreakdown.finalFare' },
    { value: ride.fareBreakdown?.fareAfterMinimum, source: 'fareBreakdown.fareAfterMinimum' },
    { value: ride.fareAtBooking, source: 'fareAtBooking' }
  )

  if (resolved.source !== 'fare' && resolved.amount > 0) {
    logger.info(
      `metric.ride.payable_amount_fallback rideId=${ride._id || ride.id} source=${resolved.source} amount=${resolved.amount}`
    )
  }

  if (resolved.amount <= 0) {
    return {
      ok: false,
      amount: 0,
      source: resolved.source,
      code: 'PAYABLE_AMOUNT_INVALID',
      message: 'Invalid ride fare amount'
    }
  }

  return {
    ok: true,
    amount: resolved.amount,
    source: resolved.source
  }
}

/**
 * Build payment-summary payload for rider apps.
 */
function buildRidePaymentSummary (ride, userId) {
  const rideId = String(ride._id || ride.id)
  const riderId = String(ride.rider?._id || ride.rider || '')
  const pickupWaitCharge =
    Number(ride.fareBreakdown?.pickupWaitCharge) ||
    Number(ride.pickupWait?.totalPickupWaitCharge) ||
    0

  const payable = resolveRidePayableAmount(ride)
  const canPayOnline =
    payable.ok &&
    isPostRideRazorpay(ride) &&
    String(ride.paymentStatus || '').toLowerCase() !== 'completed'

  return {
    rideId,
    amountDue: payable.ok ? payable.amount : 0,
    amountSource: payable.source,
    currency: 'INR',
    paymentMethod: ride.paymentMethod,
    paymentStatus: ride.paymentStatus || 'pending',
    pickupWaitCharge: roundMoney(pickupWaitCharge),
    pickupAddress: ride.pickupAddress || '',
    dropoffAddress: ride.dropoffAddress || '',
    actualDuration: ride.actualDuration || 0,
    canPayOnline,
    isAuthorized: userId && riderId && riderId === String(userId),
    ...(payable.code && !payable.ok ? { errorCode: payable.code } : {})
  }
}

module.exports = {
  resolveRidePayableAmount,
  buildRidePaymentSummary,
  roundMoney
}
