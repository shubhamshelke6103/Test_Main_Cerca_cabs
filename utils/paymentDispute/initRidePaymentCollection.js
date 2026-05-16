const Ride = require('../../Models/Driver/ride.model')
const { getPaymentDisputePolicy } = require('./policy')
const { roundInr } = require('./dues.service')
const logger = require('../logger')

/**
 * Initialize payment collection window when ride completes.
 */
const initRidePaymentCollectionOnComplete = async (rideId) => {
  const ride = await Ride.findById(rideId)
  if (!ride || ride.status !== 'completed') {
    return null
  }

  const policy = await getPaymentDisputePolicy()
  const fare = roundInr(ride.fare || 0)
  const method = ride.paymentMethod || 'CASH'

  let amountReceived = 0
  let amountRemaining = fare
  let collectionStatus = 'pending_collection'
  let paymentStatus = ride.paymentStatus || 'pending'

  if (paymentStatus === 'completed') {
    amountReceived = fare
    amountRemaining = 0
    collectionStatus = 'paid'
  } else if (paymentStatus === 'partial') {
    amountReceived = roundInr(ride.paymentCollection?.amountReceived || 0)
    amountRemaining = Math.max(0, fare - amountReceived)
  }

  const autoConfirmAt = new Date(
    Date.now() + (policy.autoConfirmMinutes || 30) * 60 * 1000
  )

  const patch = {
    'paymentCollection.status': collectionStatus,
    'paymentCollection.amountDue': fare,
    'paymentCollection.amountReceived': amountReceived,
    'paymentCollection.amountRemaining': amountRemaining,
    'paymentCollection.autoConfirmAt': autoConfirmAt,
  }

  if (method === 'CASH' && paymentStatus !== 'completed') {
    paymentStatus = 'pending'
  }

  await Ride.findByIdAndUpdate(rideId, {
    $set: {
      ...patch,
      paymentStatus,
    },
  })

  logger.info(
    `paymentCollection initialized ride=${rideId} fare=₹${fare} method=${method} autoConfirmAt=${autoConfirmAt.toISOString()}`
  )

  return { fare, collectionStatus, autoConfirmAt }
}

module.exports = { initRidePaymentCollectionOnComplete }
