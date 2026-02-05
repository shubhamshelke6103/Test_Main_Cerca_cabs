const mongoose = require('mongoose');
const { randomInt } = require('crypto');

// cryptographically-strong 4-digit OTP
const genOtp = () => String(randomInt(1000, 10000));

const rideSchema = new mongoose.Schema({
    rider: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },

    driver: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Driver',
        required: false,
    },

    // ============================================
    // PARTICIPANTS
    // ============================================
    participants: [
        {
            role: {
                type: String,
                enum: ['BOOKER', 'PASSENGER'],
                required: true
            },

            user: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User'
            },

            name: String,
            phoneNumber: String,
            socketId: String,

            notified: {
                type: Boolean,
                default: false
            }
        }
    ],

    pickupAddress: String,
    dropoffAddress: String,

    pickupLocation: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point',
        },
        coordinates: {
            type: [Number], // [lng, lat]
            required: true,
        },
    },

    driverSocketId: String,
    userSocketId: String,

    dropoffLocation: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point',
        },
        coordinates: {
            type: [Number],
            required: true,
        },
    },

    fare: Number,
    distanceInKm: Number,

    status: {
        type: String,
        enum: ['requested', 'accepted', 'in_progress', 'completed', 'cancelled'],
        default: 'requested',
    },

    rideType: {
        type: String,
        enum: ['normal', 'whole_day', 'custom'],
        default: 'normal',
    },

    bookingType: {
        type: String,
        enum: ['INSTANT', 'FULL_DAY', 'RENTAL', 'DATE_WISE'],
        default: 'INSTANT',
    },

    bookingMeta: {
        startTime: Date,
        endTime: Date,
        days: Number,
        dates: [Date],
    },

    cancelledBy: {
        type: String,
        enum: ['rider', 'driver', 'system'],
        default: null,
    },

    customSchedule: {
        startDate: Date,
        endDate: Date,
        startTime: String,
        endTime: String,
    },

    startOtp: {
        type: String,
        default: genOtp,
    },

    stopOtp: {
        type: String,
        default: genOtp,
    },

    paymentMethod: {
        type: String,
        enum: ['CASH', 'RAZORPAY', 'WALLET'],
        default: 'CASH',
    },

    actualStartTime: Date,
    actualEndTime: Date,
    estimatedDuration: Number,
    actualDuration: Number,
    estimatedArrivalTime: Date,
    driverArrivedAt: Date,

    vehicleType: {
        type: String,
        enum: ['sedan', 'suv', 'hatchback', 'auto'],
    },

    vehicleService: {
        type: String,
        enum: ['cercaSmall', 'cercaMedium', 'cercaLarge'],
    },

    service: String,

    fareBreakdown: {
        baseFare: Number,
        distanceFare: Number,
        timeFare: Number,
        subtotal: Number,
        fareAfterMinimum: Number,
        discount: Number,
        finalFare: Number
    },

    riderRating: { type: Number, min: 1, max: 5 },
    driverRating: { type: Number, min: 1, max: 5 },

    tips: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },

    promoCode: String,
    cancellationReason: { type: String, maxlength: 500 },
    cancellationFee: { type: Number, default: 0 },
    refundAmount: { type: Number, default: 0 },

    paymentStatus: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'refunded', 'partial'],
        default: 'pending',
    },

    transactionId: String,
    razorpayPaymentId: { type: String, default: null },

    walletAmountUsed: { type: Number, default: 0, min: 0 },
    razorpayAmountPaid: { type: Number, default: 0, min: 0 },

    rejectedDrivers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Driver'
    }],

    notifiedDrivers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Driver'
    }],

    // ============================================
    // ✅ EXISTING SHARE TRACKING TOKEN
    // ============================================
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

    shareCreatedAt: Date,

    // ============================================
    // 🆕 GUEST RIDE INFO TOKEN (NEW FEATURE)
    // ============================================
    guestRideToken: {
        type: String,
        unique: true,
        sparse: true,
        index: true
    },

    guestRideTokenExpiresAt: Date,

    guestRideCreatedAt: Date

}, {
    timestamps: true
});

// Indexes
rideSchema.index({ status: 1, createdAt: -1 });
rideSchema.index({ pickupLocation: '2dsphere' });
rideSchema.index({ dropoffLocation: '2dsphere' });
rideSchema.index({ shareToken: 1 });
rideSchema.index({ guestRideToken: 1 });

// Keep updatedAt synced
rideSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

const Ride = mongoose.model('Ride', rideSchema);

module.exports = Ride;
