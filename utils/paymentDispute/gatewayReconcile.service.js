const razorpay = require('razorpay')
const Ride = require('../../Models/Driver/ride.model')
const PaymentDispute = require('../../Models/Admin/paymentDispute.model')
const { resolveDisputePaid } = require('./dispute.service')
const logger = require('../logger')

const key = process.env.RAZORPAY_ID
const secret = process.env.RAZORPAY_SECRET
const instance =
  key && secret
    ? new razorpay({ key_id: key, key_secret: secret })
    : null

const reconcileDisputedRide = async (dispute) => {
  if (!instance) {
    logger.warn('gatewayReconcile: Razorpay not configured')
    return { reconciled: false, reason: 'no_razorpay' }
  }

  const ride = await Ride.findById(dispute.rideId)
  if (!ride) return { reconciled: false, reason: 'ride_not_found' }

  const paymentId = ride.razorpayPaymentId || ride.transactionId
  if (!paymentId) {
    return { reconciled: false, reason: 'no_payment_id' }
  }

  try {
    const payment = await instance.payments.fetch(paymentId)
    if (payment.status === 'captured') {
      ride.paymentStatus = 'completed'
      await ride.save()
      await resolveDisputePaid({
        dispute,
        actorRole: 'system',
        outcome: 'GATEWAY_AUTO_CAPTURED',
      })
      return { reconciled: true, status: 'captured' }
    }
    return { reconciled: false, status: payment.status }
  } catch (err) {
    logger.warn(`gatewayReconcile ride ${ride._id}: ${err.message}`)
    return { reconciled: false, error: err.message }
  }
}

const reconcileUnderReviewGatewayDisputes = async () => {
  const disputes = await PaymentDispute.find({
    status: 'UNDER_REVIEW',
    issueType: 'PAYMENT_NOT_CONFIRMED',
  }).limit(50)

  const results = []
  for (const dispute of disputes) {
    const r = await reconcileDisputedRide(dispute)
    results.push({ disputeId: dispute._id, ...r })
  }
  return results
}

module.exports = {
  reconcileDisputedRide,
  reconcileUnderReviewGatewayDisputes,
}
