const mongoose = require('mongoose')

const driverOnlineSessionSchema = new mongoose.Schema(
  {
    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      required: true,
      index: true
    },
    loginAt: {
      type: Date,
      required: true
    },
    logoutAt: {
      type: Date,
      default: null
    },
    durationMinutes: {
      type: Number,
      default: 0
    },
    source: {
      type: String,
      enum: ['login', 'manual_toggle', 'socket_connect', 'socket_disconnect'],
      default: 'manual_toggle'
    },
    status: {
      type: String,
      enum: ['active', 'closed'],
      default: 'active'
    }
  },
  {
    timestamps: true
  }
)

driverOnlineSessionSchema.index({ driver: 1, loginAt: -1 })
driverOnlineSessionSchema.index({ status: 1, logoutAt: -1 })

module.exports = mongoose.model(
  'DriverOnlineSession',
  driverOnlineSessionSchema
)
