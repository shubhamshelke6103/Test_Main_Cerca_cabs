const mongoose = require('mongoose')

const driverSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    // unique: true,
    lowercase: true
  },
  socketId: {
    type: String
  },
  phone: {
    type: String,
    required: true
  },
  password: {
    type: String,
    required: true
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: true
    }
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: false
  },
  rejectionReason: {
    type: String,
    default: null
  },
  isBusy: {
    type: Boolean,
    default: false
  },
  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5
  },
  totalRatings: {
    type: Number,
    default: 0
  },
  totalEarnings: {
    type: Number,
    default: 0
  },
  rideRejectionCount: {
    type: Number,
    default: 0
  },
  rideRejectionThreshold: {
    type: Number,
    default: 5
  },
  rideRejectionLastNotifiedAt: {
    type: Date,
    default: null
  },
  currentOnlineSessionStartedAt: {
    type: Date,
    default: null
  },
  totalOnlineMinutes: {
    type: Number,
    default: 0
  },
  bankAccount: {
    accountNumber: String,
    ifscCode: String,
    accountHolderName: String,
    bankName: String,
    accountType: {
      type: String,
      enum: ['SAVINGS', 'CURRENT'],
      default: 'SAVINGS'
    }
  },
  vehicleInfo: {
    make: String,
    model: String,
    year: Number,
    color: String,
    licensePlate: String,
    vehicleType: {
      type: String,
      enum: ['sedan', 'suv', 'hatchback', 'auto'],
      default: 'sedan'
    }
  },
  isOnline: {
    type: Boolean,
    default: false
  },
  lastSeen: Date,
  documents: {
    type: [String], // Array of document URLs or file paths
    required: true
  },
  complianceDocuments: [
    {
      documentType: {
        type: String,
        trim: true,
        required: true
      },
      documentNumber: {
        type: String,
        trim: true,
        default: null
      },
      expiryDate: {
        type: Date,
        required: true
      },
      verifiedAt: {
        type: Date,
        default: null
      },
      status: {
        type: String,
        enum: ['valid', 'expiring_soon', 'expired'],
        default: 'valid'
      },
      alertSentBeforeExpiryAt: {
        type: Date,
        default: null
      },
      alertSentAfterExpiryAt: {
        type: Date,
        default: null
      },
      notes: {
        type: String,
        trim: true,
        default: null
      }
    }
  ],
  trustedContacts: [
    {
      name: {
        type: String,
        trim: true,
        required: true
      },
      relation: {
        type: String,
        trim: true,
        default: null
      },
      phone: {
        type: String,
        trim: true,
        default: null
      },
      email: {
        type: String,
        trim: true,
        lowercase: true,
        default: null
      }
    }
  ],

  isPriorityDriver: {
    type: Boolean,
    default: false
  },

  priorityDocument: {
    type: String,
    default: null
  },

  priorityApprovedAt: {
    type: Date,
    default: null
  },

  vendorId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "Vendor",
  default: null
},

  rides: [
    {
      rideId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Ride'
      },
      status: {
        type: String,
        enum: ['accepted', 'rejected', 'completed', 'cancelled'],
        default: 'pending'
      }
    }
  ],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
})

// Update the `updatedAt` field before saving
driverSchema.pre('save', function (next) {
  this.updatedAt = Date.now()
  next()
})
// Add 2dsphere index for geospatial queries
driverSchema.index({ location: '2dsphere' })
const Driver = mongoose.model('Driver', driverSchema)

module.exports = Driver
