const mongoose = require("mongoose");

const vendorSchema = new mongoose.Schema({
  businessName: {
    type: String,
    required: true,
    trim: true
  },

  ownerName: {
    type: String,
    required: true,
    trim: true
  },

  email: {
    type: String,
    required: true,
    lowercase: true,
    unique: true
  },

  phone: {
    type: String,
    required: true,
    unique: true
  },

  password: {
    type: String,
    required: true
  },

  address: {
    type: String,
    required: true
  },

  // location: {
  //   type: {
  //     type: String,
  //     enum: ["Point"],
  //     default: "Point"
  //   },
  //   coordinates: {
  //     type: [Number], // [lng, lat]
  //     required: true
  //   }
  // },

  // Commission vendor takes from their drivers
  commissionType: {
    type: String,
    enum: ["PERCENTAGE", "FIXED"],
    default: "PERCENTAGE"
  },

  commissionValue: {
    type: Number,
    default: 10 // e.g. 10%
  },

  // Wallet System
  walletBalance: {
    type: Number,
    default: 0
  },

  totalEarnings: {
    type: Number,
    default: 0
  },

  totalRides: {
    type: Number,
    default: 0
  },

  totalDrivers: {
    type: Number,
    default: 0
  },

  totalVehicles: {
    type: Number,
    default: 0
  },

  isVerified: {
    type: Boolean,
    default: false
  },

  isActive: {
    type: Boolean,
    default: true
  },

  rejectionReason: {
    type: String,
    default: null
  },

  documents: {
    type: [String], // GST, business license, etc
    default: []
  },

  bankAccount: {
    accountNumber: String,
    ifscCode: String,
    accountHolderName: String,
    bankName: String,
    accountType: {
      type: String,
      enum: ["SAVINGS", "CURRENT"],
      default: "CURRENT"
    }
  },

  createdAt: {
    type: Date,
    default: Date.now
  },

  updatedAt: {
    type: Date,
    default: Date.now
  }

});

// Auto update updatedAt
vendorSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Geospatial index (for future nearby logic if needed)
vendorSchema.index({ location: "2dsphere" });

const Vendor = mongoose.model("Vendor", vendorSchema);

module.exports = Vendor;