const mongoose = require('mongoose')

const supportIssueSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null
    },
    issueType: {
      type: String,
      enum: ['RIDE', 'PAYMENT', 'ACCOUNT', 'GENERAL'],
      default: 'GENERAL'
    },
    status: {
      type: String,
      enum: [
        'WAITING_FOR_ADMIN',
        'ADMIN_ASSIGNED',
        'CHAT_ACTIVE',
        'CHAT_ENDED',
        'FEEDBACK_PENDING',
        'RESOLVED',
        'NOT_RESOLVED',
        'ESCALATED'
      ],
      default: 'WAITING_FOR_ADMIN',
      index: true
    },
    escalated: {
      type: Boolean,
      default: false
    },
    resolvedAt: Date
  },
  { timestamps: true }
)

module.exports = mongoose.model('SupportIssue', supportIssueSchema)
