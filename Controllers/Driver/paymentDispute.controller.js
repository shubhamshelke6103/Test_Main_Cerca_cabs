const path = require('path')
const {
  createDriverDispute,
  addEvidence,
  driverConfirmPaymentReceived,
} = require('../../utils/paymentDispute/dispute.service')
const PaymentDispute = require('../../Models/Admin/paymentDispute.model')
const Ride = require('../../Models/Driver/ride.model')

const buildEvidenceFromFile = (req, file) => {
  if (!file) return null
  const url = `/uploads/${file.filename}`
  return {
    url,
    mimeType: file.mimetype,
    note: req.body.note || null,
    issueType: req.body.issueType || null,
  }
}

const reportPaymentIssue = async (req, res) => {
  try {
    const { driverId, rideId } = req.params
    const { issueType, driverNote, amountReceived } = req.body

    const allowed = [
      'RIDER_DID_NOT_PAY',
      'FAKE_UPI_SCREENSHOT',
      'PARTIAL_PAYMENT',
      'PAYMENT_NOT_CONFIRMED',
    ]
    if (!allowed.includes(issueType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid issue type for driver report',
      })
    }

    const evidence = []
    if (req.file) {
      const ev = buildEvidenceFromFile(req, req.file)
      if (ev) evidence.push(ev)
    }
    if (Array.isArray(req.body.evidenceUrls)) {
      req.body.evidenceUrls.forEach((url) => {
        evidence.push({ url, mimeType: null, note: null })
      })
    }

    const dispute = await createDriverDispute({
      rideId,
      driverId,
      issueType,
      driverNote,
      amountReceived: amountReceived != null ? Number(amountReceived) : undefined,
      evidence,
    })

    res.status(201).json({ success: true, data: dispute })
  } catch (error) {
    res.status(400).json({ success: false, message: error.message })
  }
}

const uploadDisputeEvidence = async (req, res) => {
  try {
    const { driverId, disputeId } = req.params
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'File required' })
    }
    const ev = buildEvidenceFromFile(req, req.file)
    const dispute = await addEvidence({
      disputeId,
      uploadedBy: driverId,
      role: 'driver',
      ...ev,
    })
    res.status(200).json({ success: true, data: dispute })
  } catch (error) {
    res.status(400).json({ success: false, message: error.message })
  }
}

const confirmPaymentReceived = async (req, res) => {
  try {
    const { driverId, disputeId } = req.params
    const dispute = await driverConfirmPaymentReceived({ disputeId, driverId })
    res.status(200).json({ success: true, data: dispute })
  } catch (error) {
    res.status(400).json({ success: false, message: error.message })
  }
}

const listDriverDisputes = async (req, res) => {
  try {
    const { driverId } = req.params
    const { status } = req.query
    const filter = { driverId }
    if (status) filter.status = status
    const disputes = await PaymentDispute.find(filter)
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('rideId', 'fare paymentMethod status createdAt')
    res.status(200).json({ success: true, data: disputes })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

module.exports = {
  reportPaymentIssue,
  uploadDisputeEvidence,
  confirmPaymentReceived,
  listDriverDisputes,
}
