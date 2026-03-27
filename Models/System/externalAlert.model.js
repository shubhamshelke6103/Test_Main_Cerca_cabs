const mongoose = require('mongoose')

const externalAlertSchema = new mongoose.Schema(
  {
    channel: {
      type: String,
      enum: ['email', 'sms'],
      required: true
    },
    to: {
      type: String,
      required: true
    },
    subject: {
      type: String,
      default: null
    },
    message: {
      type: String,
      required: true
    },
    provider: {
      type: String,
      default: 'none'
    },
    status: {
      type: String,
      enum: ['queued', 'delivered', 'failed', 'skipped'],
      default: 'queued'
    },
    attemptCount: {
      type: Number,
      default: 0
    },
    lastAttemptAt: {
      type: Date,
      default: null
    },
    lastError: {
      type: String,
      default: null
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: true
  }
)

externalAlertSchema.index({ channel: 1, status: 1, createdAt: -1 })

module.exports = mongoose.model('ExternalAlert', externalAlertSchema)
