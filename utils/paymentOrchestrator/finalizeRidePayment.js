const Ride = require('../../Models/Driver/ride.model')
const User = require('../../Models/User/user.model')
const WalletTransaction = require('../../Models/User/walletTransaction.model')
const logger = require('../logger')
const { settleWalletRideCompletionFare } = require('../walletRideSettlement')
const { initRidePaymentCollectionOnComplete } = require('../paymentDispute/initRidePaymentCollection')
const { isPostRideRazorpay } = require('./ridePaymentMode')

/**
 * Process wallet settlement and collection window after ride completion.
 * Never debits wallet for post-ride Pay Online (RAZORPAY without razorpayPaymentId).
 *
 * @param {string|import('mongoose').Types.ObjectId} rideId
 * @param {{ fareFromEvent?: number, reEmitOnly?: boolean }} [options]
 * @returns {Promise<{ ride: object, requiresOnlinePayment: boolean, amountDue: number, paymentPayload: object|null }>}
 */
async function finalizeRidePayment (rideId, options = {}) {
  let completedRide = await Ride.findById(rideId).populate('rider driver')
  if (!completedRide || completedRide.status !== 'completed') {
    return {
      ride: completedRide,
      requiresOnlinePayment: false,
      amountDue: 0,
      paymentPayload: null
    }
  }

  const fareFromEvent = options.fareFromEvent

  if (!options.reEmitOnly && completedRide.paymentMethod === 'WALLET') {
    try {
      const riderId = completedRide.rider._id || completedRide.rider
      const fareAmount = completedRide.fare || fareFromEvent || 0

      logger.info(
        `[Wallet Payment] Processing wallet deduction - rideId: ${rideId}, fareAmount: ₹${fareAmount}, paymentStatus: ${completedRide.paymentStatus || 'pending'}`
      )

      if (fareAmount > 0) {
        const existingTransaction = await WalletTransaction.findOne({
          relatedRide: rideId,
          transactionType: 'RIDE_PAYMENT',
          status: 'COMPLETED'
        })

        if (existingTransaction) {
          logger.info(
            `[Wallet Payment] Payment already deducted upfront - Ride: ${rideId}, Transaction: ${existingTransaction._id}`
          )
          if (completedRide.paymentStatus !== 'completed') {
            completedRide.paymentStatus = 'completed'
            await completedRide.save()
          }
        } else if (completedRide.paymentStatus === 'completed') {
          logger.warn(
            `[Wallet Payment] Payment already completed but no transaction found - Ride: ${rideId}`
          )
        } else {
          const rider = await User.findById(riderId)
          if (!rider) {
            completedRide.paymentStatus = 'failed'
            await completedRide.save()
          } else {
            const balanceBefore = rider.walletBalance || 0
            if (balanceBefore >= fareAmount) {
              const balanceAfter = balanceBefore - fareAmount
              rider.walletBalance = balanceAfter
              await rider.save()

              await WalletTransaction.create({
                user: riderId,
                transactionType: 'RIDE_PAYMENT',
                amount: fareAmount,
                balanceBefore,
                balanceAfter,
                relatedRide: rideId,
                paymentMethod: 'WALLET',
                status: 'COMPLETED',
                description: `Ride payment of ₹${fareAmount}`,
                metadata: {
                  deductedAt: 'ride_completion',
                  legacyFlow: true
                }
              })

              completedRide.paymentStatus = 'completed'
              await completedRide.save()

              logger.info(
                `[Wallet Payment] Deduction successful (legacy flow) - Ride: ${rideId}, Amount: ₹${fareAmount}`
              )
            } else {
              completedRide.paymentStatus = 'failed'
              await completedRide.save()
              logger.warn(
                `[Wallet Payment] Insufficient balance - Ride: ${rideId}, Required: ₹${fareAmount}, Available: ₹${balanceBefore}`
              )
            }
          }
        }
      }

      try {
        const settlement = await settleWalletRideCompletionFare(completedRide)
        logger.info(
          `[Wallet Settlement] ride=${rideId} ${JSON.stringify(settlement)}`
        )
      } catch (settleErr) {
        logger.error(`[Wallet Settlement] ride=${rideId} error:`, settleErr)
      }
    } catch (walletError) {
      logger.error(
        `[Wallet Payment] Error processing wallet payment for ride ${rideId}:`,
        walletError
      )
      try {
        completedRide.paymentStatus = 'failed'
        await completedRide.save()
      } catch (updateError) {
        logger.error(
          `[Wallet Payment] Error updating payment status for ride ${rideId}:`,
          updateError
        )
      }
    }
  }

  if (isPostRideRazorpay(completedRide) && completedRide.paymentStatus === 'completed') {
    logger.warn(
      `[finalizeRidePayment] post-ride RAZORPAY ride ${rideId} had paymentStatus=completed; resetting to pending`
    )
    completedRide.paymentStatus = 'pending'
    await completedRide.save()
  }

  try {
    await initRidePaymentCollectionOnComplete(rideId)
  } catch (pcErr) {
    logger.warn(`paymentCollection init failed for ride ${rideId}: ${pcErr.message}`)
  }

  completedRide = await Ride.findById(rideId).populate('rider driver')
  const fare = Number(completedRide?.fare || 0)
  const requiresOnlinePayment =
    completedRide &&
    isPostRideRazorpay(completedRide) &&
    completedRide.paymentStatus === 'pending' &&
    fare > 0

  const paymentPayload = requiresOnlinePayment
    ? {
        rideId: String(rideId),
        amount: fare,
        paymentMethod: 'RAZORPAY',
        reason: 'ride_complete'
      }
    : null

  return {
    ride: completedRide,
    requiresOnlinePayment: Boolean(requiresOnlinePayment),
    amountDue: requiresOnlinePayment ? fare : 0,
    paymentPayload
  }
}

/**
 * Emit paymentRequired to ride room and rider/driver sockets.
 */
function emitPaymentRequired (io, ride, paymentPayload) {
  if (!io || !paymentPayload || !ride) return

  const rideRoom = `ride_${String(ride._id)}`
  const payload = {
    ...paymentPayload,
    ride: ride.toObject ? ride.toObject() : ride
  }

  io.to(rideRoom).emit('paymentRequired', payload)
  if (ride.userSocketId) {
    io.to(ride.userSocketId).emit('paymentRequired', payload)
  }
  if (ride.driverSocketId) {
    io.to(ride.driverSocketId).emit('paymentRequired', payload)
  }

  logger.info(
    `metric.payment.required rideId=${paymentPayload.rideId} amount=₹${paymentPayload.amount} reason=${paymentPayload.reason}`
  )
}

module.exports = {
  finalizeRidePayment,
  emitPaymentRequired,
  isPostRideRazorpay
}
