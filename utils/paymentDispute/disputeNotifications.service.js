const Notification = require('../../Models/User/notification.model')
const User = require('../../Models/User/user.model')
const Driver = require('../../Models/Driver/driver.model')
const { sendPushNotification } = require('../../firebase.notify')
const logger = require('../logger')

const TEMPLATES = {
  PENDING_PAYMENT_DETECTED: {
    title: 'Pending payment',
    body: 'Pending payment detected for a previous ride. Please clear it to continue booking.',
  },
  DISPUTE_UNDER_REVIEW: {
    title: 'Payment under review',
    body: 'Your payment dispute is being reviewed by our team.',
  },
  SUBMIT_PAYMENT_PROOF: {
    title: 'Payment proof needed',
    body: 'Please submit payment proof for your recent ride dispute.',
  },
  PENDING_DUES_REMINDER: {
    title: 'Payment reminder',
    body: 'You have pending ride dues. Please clear payment.',
  },
  PAYMENT_RECEIVED_SUCCESS: {
    title: 'Payment received',
    body: 'Payment received successfully for the disputed ride.',
  },
  DISPUTE_REJECTED: {
    title: 'Dispute update',
    body: 'The payment dispute was reviewed and closed.',
  },
  BOOKING_BLOCKED_DUES: {
    title: 'Booking restricted',
    body: 'Please clear previous ride payment before booking another ride.',
  },
}

const persistNotification = async ({
  recipientId,
  recipientModel,
  templateKey,
  relatedRide,
  data,
}) => {
  const tpl = TEMPLATES[templateKey] || TEMPLATES.PENDING_PAYMENT_DETECTED
  return Notification.create({
    recipient: recipientId,
    recipientModel,
    title: tpl.title,
    message: tpl.body,
    type: 'payment_dispute',
    relatedRide: relatedRide || undefined,
    data: { templateKey, ...data },
  })
}

const getFcmToken = async (recipientId, recipientModel) => {
  if (recipientModel === 'User') {
    const u = await User.findById(recipientId).select('+fcmToken').lean()
    return u?.fcmToken || null
  }
  if (recipientModel === 'Driver') {
    const d = await Driver.findById(recipientId).select('fcmToken').lean()
    return d?.fcmToken || null
  }
  return null
}

const notifyPaymentDispute = async ({
  recipientId,
  recipientModel,
  templateKey,
  rideId,
  disputeId,
  extraData = {},
}) => {
  const data = {
    templateKey,
    disputeId: disputeId ? String(disputeId) : '',
    rideId: rideId ? String(rideId) : '',
    deepLink: disputeId
      ? `/pending-dues?disputeId=${disputeId}`
      : rideId
        ? `/pending-dues?rideId=${rideId}`
        : '/pending-dues',
    ...extraData,
  }

  await persistNotification({
    recipientId,
    recipientModel,
    templateKey,
    relatedRide: rideId,
    data,
  })

  const token = await getFcmToken(recipientId, recipientModel)
  if (!token) {
    return { pushSent: false }
  }

  const tpl = TEMPLATES[templateKey] || TEMPLATES.PENDING_PAYMENT_DETECTED
  try {
    await sendPushNotification({
      token,
      title: tpl.title,
      body: tpl.body,
      data,
    })
    return { pushSent: true }
  } catch (err) {
    logger.warn('paymentDispute notify push failed:', err.message)
    return { pushSent: false }
  }
}

module.exports = {
  TEMPLATES,
  notifyPaymentDispute,
}
