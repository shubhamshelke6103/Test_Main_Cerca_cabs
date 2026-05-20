const crypto = require('crypto')
const razorpay = require('razorpay')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')
const {
  listPendingDuesForRider,
} = require('../../utils/paymentDispute/dues.service')
const {
  addEvidence,
  payAllPendingDuesWithWallet,
} = require('../../utils/paymentDispute/dispute.service')
const { assertRiderCanBook, BookingBlockedError } = require('../../utils/paymentDispute/bookingGuard.service')
const PaymentDispute = require('../../Models/Admin/paymentDispute.model')
const logger = require('../../utils/logger')

const key = process.env.RAZORPAY_ID
const secret = process.env.RAZORPAY_SECRET
const razorpayInstance =
  key && secret ? new razorpay({ key_id: key, key_secret: secret }) : null
const JWT_SECRET =
  process.env.JWT_SECRET ||
  '@#@!#@dasd4234jkdh3874#$@#$#$@#$#$dkjashdlk$#442343%#$%f34234T$vtwefcEC$%'

const sendError = (res, error, fallbackStatus = 500) => {
  const statusCode = error.statusCode || fallbackStatus
  return res.status(statusCode).json({
    success: false,
    code: error.code || undefined,
    message: error.message,
  })
}

const getAuthRiderId = (req) => {
  const authHeader = req.headers.authorization || req.headers.Authorization || ''
  if (!authHeader.startsWith('Bearer ')) {
    return null
  }

  try {
    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, JWT_SECRET)
    return decoded.id || decoded.userId || null
  } catch {
    return null
  }
}

const logPendingDuesEvent = (event, req, extra = {}) => {
  logger.info(`paymentDispute.${event}`, {
    method: req.method,
    path: req.originalUrl,
    routeRiderId: req.params.id || null,
    hasAuthHeader: Boolean(req.headers.authorization || req.headers.Authorization),
    ...extra,
  })
}

const resolveRiderId = (req) => {
  const { id: paramRiderId } = req.params
  const authRiderId = getAuthRiderId(req)

  if (authRiderId && mongoose.Types.ObjectId.isValid(authRiderId)) {
    if (
      mongoose.Types.ObjectId.isValid(paramRiderId) &&
      String(paramRiderId) !== String(authRiderId)
    ) {
      logger.warn('paymentDispute.riderId mismatch; using authenticated rider id', {
        routeRiderId: paramRiderId,
        authRiderId,
        path: req.originalUrl,
        method: req.method,
      })
    }
    return authRiderId
  }

  if (mongoose.Types.ObjectId.isValid(paramRiderId)) {
    logger.warn('paymentDispute using route rider id because auth rider id is missing or invalid', {
      routeRiderId: paramRiderId,
      path: req.originalUrl,
      method: req.method,
    })
    return paramRiderId
  }

  const error = new Error('Invalid rider ID')
  error.statusCode = 400
  error.code = 'INVALID_RIDER_ID'
  throw error
}

const getPendingDues = async (req, res) => {
  try {
    const riderId = resolveRiderId(req)
    logPendingDuesEvent('pendingDues.request', req, { resolvedRiderId: riderId })
    const data = await listPendingDuesForRider(riderId)
    logPendingDuesEvent('pendingDues.success', req, {
      resolvedRiderId: riderId,
      totalPendingDues: data.totalPendingDues,
      itemCount: data.items?.length || 0,
    })
    res.status(200).json({ success: true, data })
  } catch (error) {
    logger.error('paymentDispute.pendingDues.failed', {
      method: req.method,
      path: req.originalUrl,
      routeRiderId: req.params.id || null,
      error: error.message,
      code: error.code || null,
    })
    sendError(res, error)
  }
}

const checkBookingEligibility = async (req, res) => {
  try {
    const riderId = resolveRiderId(req)
    logPendingDuesEvent('bookingEligibility.request', req, { resolvedRiderId: riderId })
    await assertRiderCanBook(riderId)
    logPendingDuesEvent('bookingEligibility.success', req, { resolvedRiderId: riderId })
    res.status(200).json({ success: true, canBook: true })
  } catch (error) {
    if (error instanceof BookingBlockedError) {
      return res.status(403).json({
        success: false,
        canBook: false,
        code: error.code,
        message: error.message,
        details: error.details,
      })
    }
    sendError(res, error, 400)
  }
}

const payPendingDuesWallet = async (req, res) => {
  try {
    const riderId = resolveRiderId(req)
    logPendingDuesEvent('payWallet.request', req, {
      resolvedRiderId: riderId,
      idempotencyKey: req.body.idempotencyKey || req.headers['idempotency-key'] || null,
    })
    const idempotencyKey =
      req.body.idempotencyKey ||
      req.headers['idempotency-key'] ||
      `dues_${riderId}_${Date.now()}`
    const result = await payAllPendingDuesWithWallet({ riderId, idempotencyKey })
    logPendingDuesEvent('payWallet.success', req, {
      resolvedRiderId: riderId,
      paid: result.paid,
      disputesCount: result.disputes?.length || 0,
      idempotent: Boolean(result.idempotent),
    })
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    logger.error('paymentDispute.payWallet.failed', {
      method: req.method,
      path: req.originalUrl,
      routeRiderId: req.params.id || null,
      error: error.message,
      code: error.code || null,
    })
    sendError(res, error, 400)
  }
}

const createPendingDuesRazorpayOrder = async (req, res) => {
  try {
    const riderId = resolveRiderId(req)
    logPendingDuesEvent('payOnline.request', req, { resolvedRiderId: riderId })
    if (!razorpayInstance) {
      return res.status(503).json({ success: false, message: 'Payment gateway unavailable' })
    }
    const dues = await listPendingDuesForRider(riderId)
    const amount = dues.totalPendingDues
    logPendingDuesEvent('payOnline.calculated', req, {
      resolvedRiderId: riderId,
      totalPendingDues: amount,
      itemCount: dues.items?.length || 0,
    })
    if (amount < 1) {
      return res.status(400).json({ success: false, message: 'No pending dues' })
    }
    const order = await razorpayInstance.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `dues_${riderId}_${Date.now()}`,
      notes: {
        type: 'pending_dues_recovery',
        riderId: String(riderId),
        disputeIds: dues.items.map((i) => String(i.disputeId)).join(','),
      },
    })
    res.status(200).json({
      success: true,
      data: { order, amount, key: process.env.RAZORPAY_ID },
    })
  } catch (error) {
    logger.error('paymentDispute.payOnline.failed', {
      method: req.method,
      path: req.originalUrl,
      routeRiderId: req.params.id || null,
      error: error.message,
      code: error.code || null,
    })
    sendError(res, error)
  }
}

const verifyPendingDuesRazorpay = async (req, res) => {
  try {
    const riderId = resolveRiderId(req)
    logPendingDuesEvent('verifyOnline.request', req, {
      resolvedRiderId: riderId,
      razorpayPaymentId: req.body.razorpay_payment_id || null,
      razorpayOrderId: req.body.razorpay_order_id || null,
    })
    const { razorpay_payment_id, razorpay_order_id } = req.body
    if (!razorpayInstance || !razorpay_payment_id || !razorpay_order_id) {
      return res.status(400).json({ success: false, message: 'Invalid payment payload' })
    }
    const payment = await razorpayInstance.payments.fetch(razorpay_payment_id)
    if (payment.status !== 'captured') {
      return res.status(400).json({
        success: false,
        message: `Payment not captured: ${payment.status}`,
      })
    }
    const idempotencyKey = `rzp_dues_${razorpay_payment_id}`
    const result = await payAllPendingDuesWithWallet({ riderId, idempotencyKey })
    logPendingDuesEvent('verifyOnline.success', req, {
      resolvedRiderId: riderId,
      paid: result.paid,
      disputesCount: result.disputes?.length || 0,
      idempotent: Boolean(result.idempotent),
    })
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    logger.error('paymentDispute.verifyOnline.failed', {
      method: req.method,
      path: req.originalUrl,
      routeRiderId: req.params.id || null,
      error: error.message,
      code: error.code || null,
    })
    sendError(res, error, 400)
  }
}

const uploadRiderEvidence = async (req, res) => {
  try {
    const { disputeId } = req.params
    const riderId = resolveRiderId(req)
    logPendingDuesEvent('uploadEvidence.request', req, { resolvedRiderId: riderId, disputeId })
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'File required' })
    }
    const dispute = await addEvidence({
      disputeId,
      uploadedBy: riderId,
      role: 'rider',
      url: `/uploads/${req.file.filename}`,
      mimeType: req.file.mimetype,
      note: req.body.note || null,
      issueType: 'RIDER_PAYMENT_PROOF',
    })
    res.status(200).json({ success: true, data: dispute })
  } catch (error) {
    logger.error('paymentDispute.uploadEvidence.failed', {
      method: req.method,
      path: req.originalUrl,
      routeRiderId: req.params.id || null,
      error: error.message,
      code: error.code || null,
    })
    sendError(res, error, 400)
  }
}

const listRiderDisputes = async (req, res) => {
  try {
    const riderId = resolveRiderId(req)
    logPendingDuesEvent('listDisputes.request', req, { resolvedRiderId: riderId })
    const disputes = await PaymentDispute.find({ riderId })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('rideId', 'fare paymentMethod status createdAt')
    logPendingDuesEvent('listDisputes.success', req, {
      resolvedRiderId: riderId,
      count: disputes.length,
    })
    res.status(200).json({ success: true, data: disputes })
  } catch (error) {
    logger.error('paymentDispute.listDisputes.failed', {
      method: req.method,
      path: req.originalUrl,
      routeRiderId: req.params.id || null,
      error: error.message,
      code: error.code || null,
    })
    sendError(res, error)
  }
}

module.exports = {
  getPendingDues,
  checkBookingEligibility,
  payPendingDuesWallet,
  createPendingDuesRazorpayOrder,
  verifyPendingDuesRazorpay,
  uploadRiderEvidence,
  listRiderDisputes,
}
