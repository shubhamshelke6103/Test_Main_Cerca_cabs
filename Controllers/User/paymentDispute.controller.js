const crypto = require('crypto')
const razorpay = require('razorpay')
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

const getPendingDues = async (req, res) => {
  try {
    const { id: riderId } = req.params
    const data = await listPendingDuesForRider(riderId)
    res.status(200).json({ success: true, data })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

const checkBookingEligibility = async (req, res) => {
  try {
    const { id: riderId } = req.params
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
    res.status(400).json({ success: false, message: error.message })
  }
}

const payPendingDuesWallet = async (req, res) => {
  try {
    const { id: riderId } = req.params
    const idempotencyKey =
      req.body.idempotencyKey ||
      req.headers['idempotency-key'] ||
      `dues_${riderId}_${Date.now()}`
    const result = await payAllPendingDuesWithWallet({ riderId, idempotencyKey })
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    res.status(400).json({ success: false, message: error.message })
  }
}

const createPendingDuesRazorpayOrder = async (req, res) => {
  try {
    const { id: riderId } = req.params
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
    res.status(500).json({ success: false, message: error.message })
  }
}

const verifyPendingDuesRazorpay = async (req, res) => {
  try {
    const { id: riderId } = req.params
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
    res.status(400).json({ success: false, message: error.message })
  }
}

const uploadRiderEvidence = async (req, res) => {
  try {
    const { id: riderId, disputeId } = req.params
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
    res.status(400).json({ success: false, message: error.message })
  }
}

const listRiderDisputes = async (req, res) => {
  try {
    const { id: riderId } = req.params
    const disputes = await PaymentDispute.find({ riderId })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('rideId', 'fare paymentMethod status createdAt')
    res.status(200).json({ success: true, data: disputes })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
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
