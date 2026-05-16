const User = require('../../Models/User/user.model')
const PaymentDispute = require('../../Models/Admin/paymentDispute.model')
const { TERMINAL_STATUSES } = require('../../Models/Admin/paymentDispute.model')
const { getPaymentDisputePolicy } = require('./policy')
const logger = require('../logger')

const OPEN_DUE_STATUSES = ['OPEN', 'UNDER_REVIEW', 'AWAITING_RIDER_PAYMENT', 'AWAITING_DRIVER_CONFIRMATION']

const roundInr = (n) => Math.round((Number(n) || 0) * 100) / 100

const sumOpenDisputeDues = async (riderId) => {
  const disputes = await PaymentDispute.find({
    riderId,
    status: { $in: OPEN_DUE_STATUSES },
  }).lean()

  return disputes.reduce(
    (sum, d) => sum + roundInr(d.paymentContext?.amountRemaining || 0),
    0
  )
}

const recalcRiderPendingDues = async (riderId) => {
  const policy = await getPaymentDisputePolicy()
  const totalPendingDues = await sumOpenDisputeDues(riderId)

  let bookingBlocked = false
  let bookingBlockedReason = null

  if (totalPendingDues >= policy.bookingBlockThresholdInr) {
    bookingBlocked = true
    bookingBlockedReason =
      'Please clear previous ride payment before booking another ride.'
  }
  if (totalPendingDues >= policy.maxPendingDuesBeforeHardBlock) {
    bookingBlocked = true
    bookingBlockedReason =
      'Your pending dues exceed the limit. Please clear all outstanding payments or contact support.'
  }

  await User.findByIdAndUpdate(riderId, {
    'paymentCompliance.totalPendingDues': totalPendingDues,
    'paymentCompliance.bookingBlocked': bookingBlocked,
    'paymentCompliance.bookingBlockedReason': bookingBlockedReason,
  })

  return { totalPendingDues, bookingBlocked, bookingBlockedReason }
}

const listPendingDuesForRider = async (riderId) => {
  const disputes = await PaymentDispute.find({
    riderId,
    status: { $in: OPEN_DUE_STATUSES },
  })
    .populate('rideId', 'fare paymentMethod status createdAt')
    .sort({ createdAt: -1 })
    .lean()

  const items = disputes.map((d) => ({
    disputeId: d._id,
    rideId: d.rideId?._id || d.rideId,
    issueType: d.issueType,
    status: d.status,
    amountRemaining: roundInr(d.paymentContext?.amountRemaining || 0),
    fare: roundInr(d.paymentContext?.fare || 0),
    paymentMethod: d.paymentContext?.paymentMethod,
    createdAt: d.createdAt,
  }))

  const totalPendingDues = items.reduce((s, i) => s + i.amountRemaining, 0)

  const user = await User.findById(riderId)
    .select('paymentCompliance')
    .lean()

  return {
    items,
    totalPendingDues: roundInr(totalPendingDues),
    bookingBlocked: user?.paymentCompliance?.bookingBlocked || false,
    bookingBlockedReason: user?.paymentCompliance?.bookingBlockedReason || null,
  }
}

/** Nightly reconcile: fix aggregate if drifted */
const reconcileRiderDues = async (riderId) => {
  const before = await User.findById(riderId).select('paymentCompliance.totalPendingDues').lean()
  const after = await recalcRiderPendingDues(riderId)
  const drift = Math.abs(
    (before?.paymentCompliance?.totalPendingDues || 0) - after.totalPendingDues
  )
  if (drift > 0.01) {
    logger.warn(`paymentDispute.duesReconcile: rider ${riderId} drift corrected by ₹${drift}`)
  }
  return after
}

const reconcileAllRidersWithOpenDisputes = async () => {
  const riderIds = await PaymentDispute.distinct('riderId', {
    status: { $nin: TERMINAL_STATUSES },
  })
  let fixed = 0
  for (const riderId of riderIds) {
    await reconcileRiderDues(riderId)
    fixed += 1
  }
  return { ridersProcessed: fixed }
}

module.exports = {
  OPEN_DUE_STATUSES,
  roundInr,
  sumOpenDisputeDues,
  recalcRiderPendingDues,
  listPendingDuesForRider,
  reconcileRiderDues,
  reconcileAllRidersWithOpenDisputes,
}
