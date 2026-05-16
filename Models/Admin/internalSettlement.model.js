const mongoose = require('mongoose')

const internalSettlementSchema = new mongoose.Schema(
  {
    disputeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentDispute',
      required: true,
      index: true,
    },
    rideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ride',
      required: true,
    },
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      required: true,
    },
    compensationAmount: { type: Number, required: true, min: 0 },
    reason: { type: String, maxlength: 2000, default: null },
    adminNote: { type: String, maxlength: 2000, default: null },
    settledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: true,
    },
  },
  { timestamps: true }
)

module.exports = mongoose.model('InternalSettlement', internalSettlementSchema)
