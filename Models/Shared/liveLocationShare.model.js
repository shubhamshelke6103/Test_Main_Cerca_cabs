const mongoose = require('mongoose')

const liveLocationShareSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'ownerModel',
      required: true
    },
    ownerModel: {
      type: String,
      enum: ['Driver', 'User'],
      required: true
    },
    ride: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ride',
      default: null
    },
    shareToken: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    recipientName: {
      type: String,
      trim: true,
      required: true
    },
    recipientPhone: {
      type: String,
      trim: true,
      default: null
    },
    recipientEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: null
    },
    recipientType: {
      type: String,
      enum: ['family', 'vendor', 'trusted_contact'],
      default: 'trusted_contact'
    },
    relation: {
      type: String,
      trim: true,
      default: null
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    },
    accessCount: {
      type: Number,
      default: 0
    },
    lastAccessedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
)

liveLocationShareSchema.index({ owner: 1, ownerModel: 1, isActive: 1 })

module.exports = mongoose.model('LiveLocationShare', liveLocationShareSchema)
