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

const resolveRiderId = (req) => {
  const { id: paramRiderId } = req.params
  if (mongoose.Types.ObjectId.isValid(paramRiderId)) {
    return paramRiderId
  }

  const authRiderId = getAuthRiderId(req)
  if (authRiderId && mongoose.Types.ObjectId.isValid(authRiderId)) {
    return authRiderId
  }

  const error = new Error('Invalid rider ID')
  error.statusCode = 400
  error.code = 'INVALID_RIDER_ID'
  throw error
}

const getPendingDues = async (req, res) => {
  try {
    const riderId = resolveRiderId(req)
    const data = await listPendingDuesForRider(riderId)
    res.status(200).json({ success: true, data })
  } catch (error) {
    sendError(res, error)
  }
}

const checkBookingEligibility = async (req, res) => {
  try {
    const riderId = resolveRiderId(req)
    await assertRiderCanBook(riderId)
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
    const idempotencyKey =
      req.body.idempotencyKey ||
      req.headers['idempotency-key'] ||
      `dues_${riderId}_${Date.now()}`
    const result = await payAllPendingDuesWithWallet({ riderId, idempotencyKey })
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    sendError(res, error, 400)
  }
}

const createPendingDuesRazorpayOrder = async (req, res) => {
  try {
    const riderId = resolveRiderId(req)
    if (!razorpayInstance) {
      return res.status(503).json({ success: false, message: 'Payment gateway unavailable' })
    }
    const dues = await listPendingDuesForRider(riderId)
    const amount = dues.totalPendingDues
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
    sendError(res, error)
  }
}

const verifyPendingDuesRazorpay = async (req, res) => {
  try {
    const riderId = resolveRiderId(req)
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
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    sendError(res, error, 400)
  }
}

const uploadRiderEvidence = async (req, res) => {
  try {
    const { disputeId } = req.params
    const riderId = resolveRiderId(req)
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
    sendError(res, error, 400)
  }
}

const listRiderDisputes = async (req, res) => {
  try {
    const riderId = resolveRiderId(req)
    const disputes = await PaymentDispute.find({ riderId })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('rideId', 'fare paymentMethod status createdAt')
    res.status(200).json({ success: true, data: disputes })
  } catch (error) {
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
