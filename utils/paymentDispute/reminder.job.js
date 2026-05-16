const PaymentDispute = require('../../Models/Admin/paymentDispute.model')
const { getPaymentDisputePolicy } = require('./policy')
const { notifyPaymentDispute } = require('./disputeNotifications.service')
const logger = require('../logger')

const runReminderJob = async () => {
  const policy = await getPaymentDisputePolicy()
  const intervalMs = (policy.reminderIntervalHours || 6) * 60 * 60 * 1000
  const maxReminders = policy.maxReminders || 10
  const cutoff = new Date(Date.now() - intervalMs)

  const disputes = await PaymentDispute.find({
    status: 'AWAITING_RIDER_PAYMENT',
    'reminderState.count': { $lt: maxReminders },
    $or: [
      { 'reminderState.lastSentAt': null },
      { 'reminderState.lastSentAt': { $lte: cutoff } },
    ],
  }).limit(100)

  let sent = 0
  for (const dispute of disputes) {
    await notifyPaymentDispute({
      recipientId: dispute.riderId,
      recipientModel: 'User',
      templateKey: 'PENDING_DUES_REMINDER',
      rideId: dispute.rideId,
      disputeId: dispute._id,
    })
    dispute.reminderState = dispute.reminderState || {}
    dispute.reminderState.lastSentAt = new Date()
    dispute.reminderState.count = (dispute.reminderState.count || 0) + 1
    await dispute.save()
    sent += 1
  }

  if (sent > 0) {
    logger.info(`paymentDispute.reminder: sent ${sent} reminder(s)`)
  }
  return { sent }
}

module.exports = { runReminderJob }
