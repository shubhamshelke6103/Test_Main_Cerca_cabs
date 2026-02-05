const mongoose = require('mongoose')
const { randomInt } = require('crypto')

// cryptographically-strong 4-digit OTP
const genOtp = () => String(randomInt(1000, 10000))

const rideSchema = new mongoose.Schema(
  {
    rider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver'
    },

    // =========================
    // Ride Ownership
    // =========================
    rideFor: {
      type: String,
      enum: ['SELF', 'OTHER'],
      default: 'SELF'
    },

    passenger: {
      name: {
        type: String,
        trim: true
      },

      phone: {
        type: String,
        match: /^[6-9]\d{9}$/ // Indian mobile validation
      },

      relation: {
        type: String,
        trim: true
      },

      notes: {
        type: String,
        trim: true
      }
    },

    // ⭐ Future Ready (if passenger has account later)
    passengerUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },

    // ⭐ OTP Receiver (Production Ready)
    otpReceiver: {
      type: String,
      enum: ['RIDER', 'PASSENGER'],
      default: 'RIDER'
    },

    pickupAddress: String,
    dropoffAddress: String,

    pickupLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number],
        required: true
      }
    },

    dropoffLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number],
        required: true
      }
    },

    driverSocketId: String,
    userSocketId: String,

    fare: Number,
    distanceInKm: Number,

    status: {
      type: String,
      enum: ['requested', 'accepted', 'in_progress', 'completed', 'cancelled'],
      default: 'requested'
    },

    // =========================
    // Booking Types
    // =========================
    rideType: {
      type: String,
      enum: ['normal', 'whole_day', 'custom'],
      default: 'normal'
    },

    bookingType: {
      type: String,
      enum: ['INSTANT', 'FULL_DAY', 'RENTAL', 'DATE_WISE'],
      default: 'INSTANT'
    },

    bookingMeta: {
      startTime: Date,
      endTime: Date,
      days: Number,
      dates: [Date]
    },

    cancelledBy: {
      type: String,
      enum: ['rider', 'driver', 'system'],
      default: null
    },

    customSchedule: {
      startDate: Date,
      endDate: Date,
      startTime: String,
      endTime: String
    },

    startOtp: {
      type: String,
      default: genOtp
    },

    stopOtp: {
      type: String,
      default: genOtp
    },

    paymentMethod: {
      type: String,
      enum: ['CASH', 'RAZORPAY', 'WALLET'],
      default: 'CASH'
    },

    actualStartTime: Date,
    actualEndTime: Date,
    estimatedDuration: Number,
    actualDuration: Number,
    estimatedArrivalTime: Date,
    driverArrivedAt: Date,

    // =========================
    // Vehicle & Service
    // =========================
    vehicleType: {
      type: String,
      enum: ['sedan', 'suv', 'hatchback', 'auto']
    },

    vehicleService: {
      type: String,
      enum: ['cercaSmall', 'cercaMedium', 'cercaLarge']
    },

    service: String,

    // =========================
    // Fare Transparency
    // =========================
    fareBreakdown: {
      baseFare: Number,
      distanceFare: Number,
      timeFare: Number,
      subtotal: Number,
      fareAfterMinimum: Number,
      discount: Number,
      finalFare: Number
    },

    riderRating: {
      type: Number,
      min: 1,
      max: 5
    },

    driverRating: {
      type: Number,
      min: 1,
      max: 5
    },

    tips: {
      type: Number,
      default: 0
    },

    discount: {
      type: Number,
      default: 0
    },

    promoCode: String,

    cancellationReason: {
      type: String,
      maxlength: 500
    },

    cancellationFee: {
      type: Number,
      default: 0
    },

    refundAmount: {
      type: Number,
      default: 0
    },

    paymentStatus: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded', 'partial'],
      default: 'pending'
    },

    transactionId: String,
    razorpayPaymentId: String,

    walletAmountUsed: {
      type: Number,
      default: 0,
      min: 0
    },

    razorpayAmountPaid: {
      type: Number,
      default: 0,
      min: 0
    },

    rejectedDrivers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Driver'
      }
    ],

    notifiedDrivers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Driver'
      }
    ],

    // =========================
    // Ride Sharing
    // =========================
    shareToken: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },

    shareTokenExpiresAt: Date,

    isShared: {
      type: Boolean,
      default: false
    },

    shareCreatedAt: Date
  },
  {
    timestamps: true
  }
)

/* =====================================================
   ⭐ ENTERPRISE VALIDATION HOOK
===================================================== */
rideSchema.pre('validate', function (next) {

  // Remove passenger data if ride is SELF
  if (this.rideFor === 'SELF') {
    this.passenger = undefined
    this.passengerUser = undefined
    this.otpReceiver = 'RIDER'
  }

  // Validate passenger if OTHER
  if (this.rideFor === 'OTHER') {
    if (!this.passenger?.name || !this.passenger?.phone) {
      return next(new Error('Passenger name and phone are required for OTHER ride'))
    }

    this.otpReceiver = 'PASSENGER'
  }

  next()
})

/* =====================================================
   ⭐ INDEXES
===================================================== */

rideSchema.index({ status: 1, createdAt: -1 })
rideSchema.index({ pickupLocation: '2dsphere' })
rideSchema.index({ dropoffLocation: '2dsphere' })
rideSchema.index({ shareToken: 1 })
rideSchema.index({ 'passenger.phone': 1 })

/* =====================================================
   ⭐ Keep updatedAt synced
===================================================== */

rideSchema.pre('save', function (next) {
  this.updatedAt = Date.now()
  next()
})

const Ride = mongoose.model('Ride', rideSchema)

module.exports = Ride
