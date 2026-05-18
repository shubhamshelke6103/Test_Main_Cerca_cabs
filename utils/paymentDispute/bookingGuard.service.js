const User = require('../../Models/User/user.model')
const { recalcRiderPendingDues } = require('./dues.service')
const { getPaymentDisputePolicy } = require('./policy')
const {
  getPendingDriverInProgressCancelSettlements
} = require('../ride_booking_functions')

class BookingBlockedError extends Error {
  constructor(message, details = {}, code = 'BOOKING_BLOCKED_DUES') {
    super(message)
    this.name = 'BookingBlockedError'
    this.code = code
    this.details = details
  }
}

const assertRiderCanBook = async (riderId) => {
  if (!riderId) {
    throw new Error('riderId is required for booking guard')
  }

  const user = await User.findById(riderId).select('isActive paymentCompliance').lean()
  if (!user) {
    throw new Error('Rider not found')
  }
  if (user.isActive === false) {
    throw new BookingBlockedError('Your account is blocked. Please contact support.', {
      reason: 'account_blocked',
    })
  }

  await recalcRiderPendingDues(riderId)
  const refreshed = await User.findById(riderId).select('paymentCompliance').lean()
  const compliance = refreshed?.paymentCompliance || {}
  const policy = await getPaymentDisputePolicy()

  if (
    (compliance.totalPendingDues || 0) >= policy.bookingBlockThresholdInr ||
    compliance.bookingBlocked
  ) {
    throw new BookingBlockedError(
      compliance.bookingBlockedReason ||
        'Please clear previous ride payment before booking another ride.',
      {
        reason: 'pending_dues',
        totalPendingDues: compliance.totalPendingDues || 0,
      }
    )
  }

  const { items, totalAdditionalDue } =
    await getPendingDriverInProgressCancelSettlements(riderId)
  if (totalAdditionalDue > 0) {
    const firstRideId = items[0]?.rideId || null
    throw new BookingBlockedError(
      'Please clear your previous trip charge before booking another ride.',
      {
        reason: 'driver_cancel_settlement',
        totalAdditionalDue,
        pendingSettlementRideIds: items.map(i => i.rideId),
        settlementRideId: firstRideId,
      },
      'BOOKING_BLOCKED_DRIVER_CANCEL_SETTLEMENT'
    )
  }

  return true
}

module.exports = {
  BookingBlockedError,
  assertRiderCanBook,
}
