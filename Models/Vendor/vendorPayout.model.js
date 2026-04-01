const mongoose = require('mongoose')

const { Schema } = mongoose

const vendorPayoutSchema = new Schema(
  {
    vendor: {
      type: Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
      index: true
    },
    amount: {
      type: Number,
      required: true,
      min: 0
    },
    bankAccount: {
      accountNumber: { type: String, required: true },
      ifscCode: { type: String, required: true },
      accountHolderName: { type: String, required: true },
      bankName: { type: String, required: true },
      accountType: {
        type: String,
        enum: ['SAVINGS', 'CURRENT'],
        default: 'CURRENT'
      }
    },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'],
      default: 'PENDING',
      index: true
    },
    requestedAt: {
      type: Date,
      default: Date.now,
      index: true
    },
    processedAt: {
      type: Date,
      default: null
    },
    processedBy: {
      type: Schema.Types.ObjectId,
      ref: 'Admin',
      default: null
    },
    transactionId: { type: String, default: null },
    transactionReference: { type: String, default: null },
    failureReason: { type: String, default: null },
    notes: { type: String, maxlength: 500 },
    metadata: { type: Schema.Types.Mixed, default: {} }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
)

vendorPayoutSchema.index({ vendor: 1, status: 1, requestedAt: -1 })
vendorPayoutSchema.index({ status: 1, requestedAt: -1 })

// Avoid OverwriteModelError when this file is required more than once (e.g. nodemon / tests).
module.exports = mongoose.models.VendorPayout || mongoose.model('VendorPayout', vendorPayoutSchema)
