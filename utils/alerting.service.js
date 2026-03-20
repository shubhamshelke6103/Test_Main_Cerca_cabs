const Admin = require('../Models/User/admin.model')
const Vendor = require('../Models/vendor/vendor.models')
const { createNotification } = require('./ride_booking_functions')
const logger = require('./logger')

const dispatchExternalAlert = async payload => {
  const { channel, to, subject, message } = payload
  if (!to) return { channel, status: 'skipped', reason: 'missing_recipient' }

  logger.info(
    `External ${channel.toUpperCase()} alert queued for ${to}: ${subject || message}`
  )

  return {
    channel,
    status: 'queued'
  }
}

const notifyAdmins = async ({ title, message, type, data }) => {
  const admins = await Admin.find({ isActive: true }).select(
    'fullName email phoneNumber'
  )

  const results = []
  for (const admin of admins) {
    await createNotification({
      recipientId: admin._id,
      recipientModel: 'Admin',
      title,
      message,
      type,
      data
    })

    results.push(
      await dispatchExternalAlert({
        channel: 'email',
        to: admin.email,
        subject: title,
        message
      })
    )

    results.push(
      await dispatchExternalAlert({
        channel: 'sms',
        to: admin.phoneNumber,
        message
      })
    )
  }

  return results
}

const notifyVendor = async (vendorId, { title, message, type, data }) => {
  if (!vendorId) return []

  const vendor = await Vendor.findById(vendorId).select('email phone')
  if (!vendor) return []

  await createNotification({
    recipientId: vendor._id,
    recipientModel: 'Vendor',
    title,
    message,
    type,
    data
  })

  return [
    await dispatchExternalAlert({
      channel: 'email',
      to: vendor.email,
      subject: title,
      message
    }),
    await dispatchExternalAlert({
      channel: 'sms',
      to: vendor.phone,
      message
    })
  ]
}

module.exports = {
  notifyAdmins,
  notifyVendor
}
