const Admin = require('../Models/User/admin.model')
const logger = require('./logger')
const { createNotification } = require('./ride_booking_functions')

const SOCKET_FLAG = 'ADMIN_REGISTRATION_SOCKET_ALERTS'

/**
 * Persist one notification per active admin and optionally broadcast to admin Socket.IO rooms.
 * Does not send email/SMS (unlike notifyAdmins in alerting.service).
 *
 * @param {object} params
 * @param {'admin_new_driver'|'admin_new_vendor'|'admin_vehicle_pending'|'admin_driver_linked_vendor'} params.type
 * @param {string} params.title
 * @param {string} params.message
 * @param {'driver'|'vendor'|'vehicle'} params.entityKind
 * @param {string} params.entityId
 * @param {object} [params.data] Extra metadata (vendorId, licensePlate, driverName, isResubmit, etc.)
 * @param {string} [params.path] Optional deep link (overrides default for entityKind)
 */
async function notifyAdminsRegistrationEvent ({
  type,
  title,
  message,
  entityKind,
  entityId,
  data = {},
  path: pathOverride
}) {
  const pathByKind = {
    driver: '/folder/drivers',
    vendor: '/folder/vendors',
    vehicle: '/folder/vehicles'
  }
  const path = pathOverride || pathByKind[entityKind] || '/folder/dashboard'

  const baseData = {
    entityKind,
    entityId: String(entityId),
    path,
    ...data
  }

  let firstNotificationId = null
  try {
    const admins = await Admin.find({ isActive: true }).select('_id').lean()
    if (!admins.length) {
      return { persisted: 0, broadcast: false }
    }
    for (const admin of admins) {
      const doc = await createNotification({
        recipientId: admin._id,
        recipientModel: 'Admin',
        title,
        message,
        type,
        data: baseData
      })
      if (doc && doc._id && !firstNotificationId) {
        firstNotificationId = doc._id
      }
    }
  } catch (err) {
    logger.error('notifyAdminsRegistrationEvent DB error:', err)
    throw err
  }

  const socketEnabled =
    process.env[SOCKET_FLAG] === undefined ||
    process.env[SOCKET_FLAG] === 'true' ||
    process.env[SOCKET_FLAG] === '1'

  if (!socketEnabled) {
    return { notificationCount: 0, broadcast: false }
  }

  try {
    const { getSocketIO } = require('./socket')
    const io = getSocketIO()
    if (!io) {
      return { notificationCount: firstNotificationId ? 1 : 0, broadcast: false }
    }

    const payload = {
      kind: entityKind,
      type,
      title,
      message,
      entityId: String(entityId),
      path,
      notificationId: firstNotificationId ? String(firstNotificationId) : undefined,
      data: baseData,
      createdAt: new Date().toISOString()
    }

    io.to('admin').emit('adminRegistrationAlert', payload)
    io.to('admin_support_online').emit('adminRegistrationAlert', payload)
    logger.info(
      `adminRegistrationAlert broadcast entityKind=${entityKind} entityId=${entityId}`
    )
    return { broadcast: true, payload }
  } catch (err) {
    logger.warn(
      `notifyAdminsRegistrationEvent socket skip: ${err.message}`
    )
    return { broadcast: false }
  }
}

/**
 * Notify all active admins when a vendor requests a payout (DB + optional socket).
 *
 * @param {object} params
 * @param {string} params.vendorId
 * @param {string} [params.businessName]
 * @param {number} params.amount
 * @param {string} params.payoutId
 */
async function notifyAdminsVendorPayoutRequested ({
  vendorId,
  businessName,
  amount,
  payoutId
}) {
  const title = 'Vendor payout requested'
  const displayName = businessName && String(businessName).trim() ? businessName : 'A vendor'
  const amt = Number(amount)
  const message = `${displayName} requested a payout of ₹${Number.isFinite(amt) ? amt.toFixed(2) : amount}.`
  const path = `/folder/payouts?tab=vendor&payoutId=${encodeURIComponent(String(payoutId))}`

  const baseData = {
    entityKind: 'vendor_payout',
    entityId: String(payoutId),
    path,
    payoutId: String(payoutId),
    vendorId: String(vendorId),
    amount: amt
  }

  let firstNotificationId = null
  try {
    const admins = await Admin.find({ isActive: true }).select('_id').lean()
    if (!admins.length) {
      return { persisted: 0, broadcast: false }
    }
    for (const admin of admins) {
      const doc = await createNotification({
        recipientId: admin._id,
        recipientModel: 'Admin',
        title,
        message,
        type: 'admin_vendor_payout_requested',
        data: baseData
      })
      if (doc && doc._id && !firstNotificationId) {
        firstNotificationId = doc._id
      }
    }
  } catch (err) {
    logger.error('notifyAdminsVendorPayoutRequested DB error:', err)
    throw err
  }

  const socketEnabled =
    process.env[SOCKET_FLAG] === undefined ||
    process.env[SOCKET_FLAG] === 'true' ||
    process.env[SOCKET_FLAG] === '1'

  if (!socketEnabled) {
    return { notificationCount: firstNotificationId ? 1 : 0, broadcast: false }
  }

  try {
    const { getSocketIO } = require('./socket')
    const io = getSocketIO()
    if (!io) {
      return { notificationCount: firstNotificationId ? 1 : 0, broadcast: false }
    }

    const payload = {
      kind: 'vendor_payout',
      type: 'admin_vendor_payout_requested',
      title,
      message,
      entityId: String(payoutId),
      path,
      notificationId: firstNotificationId ? String(firstNotificationId) : undefined,
      data: baseData,
      createdAt: new Date().toISOString()
    }

    io.to('admin').emit('adminRegistrationAlert', payload)
    io.to('admin_support_online').emit('adminRegistrationAlert', payload)
    logger.info(
      `adminRegistrationAlert vendor_payout payoutId=${payoutId} vendorId=${vendorId}`
    )
    return { broadcast: true, payload }
  } catch (err) {
    logger.warn(`notifyAdminsVendorPayoutRequested socket skip: ${err.message}`)
    return { broadcast: false }
  }
}

module.exports = { notifyAdminsRegistrationEvent, notifyAdminsVendorPayoutRequested }
