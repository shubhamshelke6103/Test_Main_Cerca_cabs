const mongoose = require('mongoose')

const supportMessageSchema = new mongoose.Schema(
  {
    issueId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportIssue',
      required: true,
      index: true
    },
    senderType: {
      type: String,
      enum: ['USER', 'ADMIN', 'SYSTEM'],
      required: true
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    message: {
      type: String,
      required: true,
      maxlength: 1000
    }
  },
  { timestamps: true }
)

module.exports = mongoose.model('SupportMessage', supportMessageSchema)
