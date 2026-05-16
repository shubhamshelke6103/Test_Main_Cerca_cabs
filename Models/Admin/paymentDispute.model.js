const mongoose = require('mongoose')

const TERMINAL_STATUSES = [
  'RESOLVED_PAID',
  'RESOLVED_REJECTED',
  'RESOLVED_COMPANY_SETTLED',
  'AUTO_CLOSED',
  'CANCELLED',
]

const evidenceSchema = new mongoose.Schema(
  {
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    role: { type: String, enum: ['driver', 'rider', 'admin'], required: true },
    url: { type: String, required: true },
    mimeType: { type: String, default: null },
    note: { type: String, maxlength: 1000, default: null },
    issueType: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

const auditEntrySchema = new mongoose.Schema(
  {
    fromStatus: String,
    toStatus: String,
    action: String,
    actorId: mongoose.Schema.Types.ObjectId,
    actorRole: { type: String, enum: ['driver', 'rider', 'admin', 'system'] },
    note: String,
    at: { type: Date, default: Date.now },
  },
  { _id: false }
)

const paymentDisputeSchema = new mongoose.Schema(
  {
    rideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ride',
      required: true,
    },
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      required: true,
      index: true,
    },
    issueType: {
      type: String,
      enum: [
        'RIDER_DID_NOT_PAY',
        'FAKE_UPI_SCREENSHOT',
        'PARTIAL_PAYMENT',
        'PAYMENT_NOT_CONFIRMED',
        'DRIVER_FALSE_COMPLAINT',
        'RIDER_PAYMENT_PROOF',
        'OFFLINE_PAYMENT_LATER',
        'COMPANY_SETTLED',
      ],
      required: true,
    },
    status: {
      type: String,
      enum: [
        'OPEN',
        'UNDER_REVIEW',
        'AWAITING_RIDER_PAYMENT',
        'AWAITING_DRIVER_CONFIRMATION',
        'RESOLVED_PAID',
        'RESOLVED_REJECTED',
        'RESOLVED_COMPANY_SETTLED',
        'AUTO_CLOSED',
        'CANCELLED',
      ],
      default: 'OPEN',
      index: true,
    },
    paymentContext: {
      fare: { type: Number, default: 0 },
      paymentMethod: { type: String, default: 'CASH' },
      amountDue: { type: Number, default: 0 },
      amountReceived: { type: Number, default: 0 },
      amountRemaining: { type: Number, default: 0 },
    },
    evidence: [evidenceSchema],
    driverNote: { type: String, maxlength: 2000, default: null },
    riderNote: { type: String, maxlength: 2000, default: null },
    resolution: {
      outcome: { type: String, default: null },
      resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
      resolvedAt: { type: Date, default: null },
      adminNote: { type: String, maxlength: 2000, default: null },
      razorpayRefundId: { type: String, default: null },
    },
    fraudFlags: {
      riderFraudIncrement: { type: Number, default: 0 },
      driverFraudIncrement: { type: Number, default: 0 },
    },
    supportIssueId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportIssue',
      default: null,
    },
    reminderState: {
      lastSentAt: { type: Date, default: null },
      count: { type: Number, default: 0 },
    },
    autoConfirmAt: { type: Date, default: null },
    recoveryPaymentId: { type: String, default: null, sparse: true },
    auditLog: [auditEntrySchema],
  },
  { timestamps: true }
)

paymentDisputeSchema.index(
  { rideId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $nin: TERMINAL_STATUSES },
    },
  }
)

paymentDisputeSchema.index({ riderId: 1, status: 1 })
paymentDisputeSchema.index({ driverId: 1, status: 1 })
paymentDisputeSchema.index({ status: 1, createdAt: -1 })

module.exports = mongoose.model('PaymentDispute', paymentDisputeSchema)
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES
