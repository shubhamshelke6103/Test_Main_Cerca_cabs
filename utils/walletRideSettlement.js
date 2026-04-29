/**
 * Align rider wallet with final ride fare after completion (distance/time from completeRide).
 *
 * Pure WALLET only (`paymentMethod === WALLET` and no `walletAmountUsed`):
 * compares sum of prior RIDE_PAYMENT debits to `completedRide.fare`, then REFUND or extra RIDE_PAYMENT.
 *
 * Phase 2 (not implemented here): hybrid rides need wallet + Razorpay capture/refund so the combined
 * settlement matches `completedRide.fare` without double-charging the wallet portion.
 *
 * Cancellation: `processWalletRefund` does not run for `status === completed'` rides. Fare-settlement
 * REFUND rows use `metadata.settlementType === ride_completion_fare`, distinct from cancellation refunds.
 */
const mongoose = require('mongoose')
const logger = require('./logger')
const User = require('../Models/User/user.model')
const WalletTransaction = require('../Models/User/walletTransaction.model')
const Ride = require('../Models/Driver/ride.model')

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100

const SETTLEMENT_METADATA_KEY = 'settlementType'
const SETTLEMENT_TYPE_VALUE = 'ride_completion_fare'

function toObjectId (id) {
  if (!id) return null
  const s = String(id)
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : id
}

/**
 * Sum completed RIDE_PAYMENT debits for this ride, excluding post-completion fare top-ups
 * (those rows carry settlementType so they are not counted as "prepaid estimate").
 */
async function sumPrepaidRidePayments (rideObjectId) {
  const rows = await WalletTransaction.find({
    relatedRide: rideObjectId,
    transactionType: 'RIDE_PAYMENT',
    status: 'COMPLETED'
  })
    .select('amount metadata')
    .lean()

  let total = 0
  for (const r of rows) {
    if (r.metadata && r.metadata[SETTLEMENT_METADATA_KEY] === SETTLEMENT_TYPE_VALUE) {
      continue
    }
    total += Number(r.amount) || 0
  }
  return roundMoney(total)
}

/**
 * @param {object} completedRide - ride document after completeRide (fare = final)
 * @returns {Promise<object>} result summary
 */
async function settleWalletRideCompletionFare (completedRide) {
  const rideId = completedRide?._id || completedRide?.id
  if (!rideId) {
    return { skipped: true, reason: 'no_ride_id' }
  }

  if (completedRide.paymentMethod !== 'WALLET') {
    return { skipped: true, reason: 'not_wallet' }
  }

  const walletPortion = Number(completedRide.walletAmountUsed || 0)
  if (walletPortion > 0.01) {
    logger.info(
      `[Wallet Settlement] Skipping ride ${rideId}: hybrid payment (walletAmountUsed=${walletPortion})`
    )
    return { skipped: true, reason: 'hybrid_wallet_razorpay' }
  }

  const finalFare = roundMoney(completedRide.fare || 0)
  if (finalFare <= 0) {
    return { skipped: true, reason: 'zero_final_fare' }
  }

  const rideObjectId = toObjectId(rideId)

  const already = await WalletTransaction.findOne({
    relatedRide: rideObjectId,
    [`metadata.${SETTLEMENT_METADATA_KEY}`]: SETTLEMENT_TYPE_VALUE
  })
    .select('_id')
    .lean()

  if (already) {
    logger.info(`[Wallet Settlement] Already applied for ride ${rideId}`)
    return { skipped: true, reason: 'already_settled', transactionId: String(already._id) }
  }

  const prepaidTotal = await sumPrepaidRidePayments(rideObjectId)

  if (prepaidTotal <= 0) {
    return { skipped: true, reason: 'no_prior_debits', prepaidTotal, finalFare }
  }

  const delta = roundMoney(prepaidTotal - finalFare)
  if (Math.abs(delta) < 0.005) {
    logger.info(
      `[Wallet Settlement] Balanced ride=${rideId} prepaid=₹${prepaidTotal} final=₹${finalFare}`
    )
    return { skipped: true, reason: 'already_balanced', prepaidTotal, finalFare }
  }

  const riderId = completedRide.rider?._id || completedRide.rider
  if (!riderId) {
    return { skipped: true, reason: 'no_rider' }
  }
  const userId = toObjectId(riderId)

  const rider = await User.findById(userId)
  if (!rider) {
    logger.warn(`[Wallet Settlement] Rider not found ride=${rideId}`)
    return { skipped: true, reason: 'rider_not_found' }
  }

  if (delta > 0) {
    const balanceBefore = roundMoney(rider.walletBalance || 0)
    const balanceAfter = roundMoney(balanceBefore + delta)
    rider.walletBalance = balanceAfter
    await rider.save()

    await WalletTransaction.create({
      user: userId,
      transactionType: 'REFUND',
      amount: roundMoney(delta),
      balanceBefore,
      balanceAfter,
      relatedRide: rideObjectId,
      paymentMethod: 'WALLET',
      status: 'COMPLETED',
      description: `Fare adjustment: refunded ₹${roundMoney(delta)} (held ₹${prepaidTotal} → actual ₹${finalFare})`,
      metadata: {
        [SETTLEMENT_METADATA_KEY]: SETTLEMENT_TYPE_VALUE,
        finalFare,
        prepaidTotal,
        deltaRefund: roundMoney(delta)
      }
    })

    logger.info(
      `[Wallet Settlement] REFUND ₹${delta} ride=${rideId} prepaid=₹${prepaidTotal} final=₹${finalFare}`
    )
    return { applied: 'refund', amount: roundMoney(delta), prepaidTotal, finalFare, balanceAfter }
  }

  const extra = roundMoney(Math.abs(delta))
  const balanceBefore = roundMoney(rider.walletBalance || 0)
  if (balanceBefore < extra - 0.005) {
    logger.warn(
      `[Wallet Settlement] Insufficient balance ride=${rideId} need=₹${extra} have=₹${balanceBefore}`
    )
    try {
      await Ride.findByIdAndUpdate(rideObjectId, { paymentStatus: 'partial' })
    } catch (e) {
      logger.warn(`[Wallet Settlement] Could not mark partial payment: ${e.message}`)
    }
    return {
      failed: true,
      reason: 'insufficient_for_additional',
      extra,
      balanceBefore,
      prepaidTotal,
      finalFare
    }
  }

  const balanceAfter = roundMoney(balanceBefore - extra)
  rider.walletBalance = balanceAfter
  await rider.save()

  await WalletTransaction.create({
    user: userId,
    transactionType: 'RIDE_PAYMENT',
    amount: extra,
    balanceBefore,
    balanceAfter,
    relatedRide: rideObjectId,
    paymentMethod: 'WALLET',
    status: 'COMPLETED',
    description: `Fare adjustment: additional ₹${extra} (held ₹${prepaidTotal} → actual ₹${finalFare})`,
    metadata: {
      [SETTLEMENT_METADATA_KEY]: SETTLEMENT_TYPE_VALUE,
      finalFare,
      prepaidTotal,
      additionalFareSettlement: true
    }
  })

  logger.info(
    `[Wallet Settlement] Additional debit ₹${extra} ride=${rideId} prepaid=₹${prepaidTotal} final=₹${finalFare}`
  )
  return {
    applied: 'additional_debit',
    amount: extra,
    prepaidTotal,
    finalFare,
    balanceAfter
  }
}

/** Exported for unit tests (pure math). */
function computeSettlementDelta (prepaidTotal, finalFare) {
  return roundMoney(roundMoney(prepaidTotal) - roundMoney(finalFare))
}

module.exports = {
  settleWalletRideCompletionFare,
  computeSettlementDelta,
  roundMoney,
  SETTLEMENT_TYPE_VALUE
}
