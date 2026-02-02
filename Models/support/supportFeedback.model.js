const mongoose = require('mongoose')

const supportFeedbackSchema = new mongoose.Schema(
  {
    issueId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportIssue',
      unique: true
    },
    resolved: {
      type: Boolean,
      required: true
    },
    rating: {
      type: Number,
      min: 1,
      max: 5
    },
    comment: String
  },
  { timestamps: true }
)

module.exports = mongoose.model('SupportFeedback', supportFeedbackSchema)
