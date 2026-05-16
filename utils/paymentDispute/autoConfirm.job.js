const Ride = require('../../Models/Driver/ride.model')
const PaymentDispute = require('../../Models/Admin/paymentDispute.model')
const { TERMINAL_STATUSES } = require('../../Models/Admin/paymentDispute.model')
const { syncAdminEarningsAfterRidePaid } = require('../adminEarningsSettlement')
const logger = require('../logger')

/**
 * Scenario 10: auto-confirm cash/off-platform payment when no dispute reported.
 */
const runAutoConfirmJob = async () => {
  const now = new Date()
  const rides = await Ride.find({
    status: 'completed',
    paymentMethod: 'CASH',
    paymentStatus: { $in: ['pending', 'partial'] },
    'paymentCollection.status': 'pending_collection',
    'paymentCollection.autoConfirmAt': { $lte: now, $ne: null },
    'paymentCollection.activeDisputeId': null,
  }).limit(100)

  let confirmed = 0
  for (const ride of rides) {
    const activeDispute = await PaymentDispute.findOne({
      rideId: ride._id,
      status: { $nin: TERMINAL_STATUSES },
    })
    if (activeDispute) continue

    const fare = ride.fare || 0
    ride.paymentStatus = 'completed'
    ride.paymentCollection = ride.paymentCollection || {}
    ride.paymentCollection.status = 'auto_confirmed'
    ride.paymentCollection.amountReceived = fare
    ride.paymentCollection.amountRemaining = 0
    ride.paymentCollection.collectedAt = now
    ride.paymentCollection.autoConfirmAt = null
    await ride.save()

    try {
      await syncAdminEarningsAfterRidePaid(ride._id)
    } catch (err) {
      logger.warn(`autoConfirm earnings sync ${ride._id}: ${err.message}`)
    }
    confirmed += 1
  }

  if (confirmed > 0) {
    logger.info(`paymentDispute.autoConfirm: confirmed ${confirmed} ride(s)`)
  }
  return { confirmed }
}

module.exports = { runAutoConfirmJob }
