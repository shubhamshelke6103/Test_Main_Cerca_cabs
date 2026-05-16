const PaymentDispute = require('../../Models/Admin/paymentDispute.model')
const { adminResolveDispute } = require('../../utils/paymentDispute/dispute.service')
const { reconcileUnderReviewGatewayDisputes } = require('../../utils/paymentDispute/gatewayReconcile.service')

const listPaymentDisputes = async (req, res) => {
  try {
    const { status, issueType, page = 1, limit = 20 } = req.query
    const filter = {}
    if (status) filter.status = status
    if (issueType) filter.issueType = issueType

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10)
    const [disputes, total] = await Promise.all([
      PaymentDispute.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .populate('rideId', 'fare paymentMethod status paymentStatus createdAt')
        .populate('riderId', 'fullName phoneNumber email')
        .populate('driverId', 'name phoneNumber'),
      PaymentDispute.countDocuments(filter),
    ])

    res.status(200).json({
      success: true,
      data: disputes,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
      },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

const getPaymentDisputeById = async (req, res) => {
  try {
    const dispute = await PaymentDispute.findById(req.params.id)
      .populate('rideId')
      .populate('riderId', 'fullName phoneNumber email paymentCompliance')
      .populate('driverId', 'name phoneNumber paymentCompliance')
    if (!dispute) {
      return res.status(404).json({ success: false, message: 'Dispute not found' })
    }
    res.status(200).json({ success: true, data: dispute })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

const resolvePaymentDispute = async (req, res) => {
  try {
    const adminId = req.admin?._id || req.body.adminId
    const { action, adminNote, compensationAmount } = req.body
    const allowed = [
      'CONFIRM_FRAUD',
      'REJECT_DRIVER_COMPLAINT',
      'WAIVE',
      'COMPANY_SETTLE',
      'VERIFY_PAYMENT_CAPTURED',
    ]
    if (!allowed.includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid action' })
    }
    const dispute = await adminResolveDispute({
      disputeId: req.params.id,
      adminId,
      action,
      adminNote,
      compensationAmount,
    })
    res.status(200).json({ success: true, data: dispute })
  } catch (error) {
    res.status(400).json({ success: false, message: error.message })
  }
}

const getPaymentDisputeStats = async (req, res) => {
  try {
    const [open, underReview, awaitingPayment, resolvedToday] = await Promise.all([
      PaymentDispute.countDocuments({
        status: { $in: ['OPEN', 'AWAITING_RIDER_PAYMENT', 'AWAITING_DRIVER_CONFIRMATION'] },
      }),
      PaymentDispute.countDocuments({ status: 'UNDER_REVIEW' }),
      PaymentDispute.countDocuments({ status: 'AWAITING_RIDER_PAYMENT' }),
      PaymentDispute.countDocuments({
        status: {
          $in: [
            'RESOLVED_PAID',
            'RESOLVED_REJECTED',
            'RESOLVED_COMPANY_SETTLED',
            'AUTO_CLOSED',
          ],
        },
        updatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }),
    ])
    res.status(200).json({
      success: true,
      data: { open, underReview, awaitingPayment, resolvedToday },
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

const triggerGatewayReconcile = async (req, res) => {
  try {
    const results = await reconcileUnderReviewGatewayDisputes()
    res.status(200).json({ success: true, data: results })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

module.exports = {
  listPaymentDisputes,
  getPaymentDisputeById,
  resolvePaymentDispute,
  getPaymentDisputeStats,
  triggerGatewayReconcile,
}
