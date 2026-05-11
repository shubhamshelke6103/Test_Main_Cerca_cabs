const mongoose = require('mongoose');

const adminEarningsSchema = new mongoose.Schema({
    rideId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Ride',
        required: true,
        unique: true,
        index: true,
    },
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Driver',
        required: true,
    },
    riderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    grossFare: {
        type: Number,
        required: true,
        min: 0,
    },
    platformFee: {
        type: Number,
        required: true,
        min: 0,
    },
    driverEarning: {
        type: Number,
        required: true,
        min: 0,
    },
    rideDate: {
        type: Date,
        required: true,
        index: true,
    },
    /** Snapshot at settlement time; used for bank payout ledger (cash vs online). */
    paymentMethodSnapshot: {
        type: String,
        default: null,
    },
    vehicleSnapshot: {
        licensePlate: {
            type: String,
            default: null,
        },
        make: {
            type: String,
            default: null,
        },
        model: {
            type: String,
            default: null,
        },
        year: {
            type: Number,
            default: null,
        },
        color: {
            type: String,
            default: null,
        },
        vehicleType: {
            type: String,
            default: null,
        },
        source: {
            type: String,
            enum: ['SELF_OWNED', 'FLEET_ASSIGNED', 'UNKNOWN'],
            default: 'UNKNOWN',
        },
    },
    paymentStatus: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'refunded'],
        default: 'pending',
    },
    settlementType: {
        type: String,
        enum: ['completed', 'driver_cancel_in_progress', 'rider_cancel_before_start_otp', 'rider_cancel_fee_retained'],
        default: 'completed',
    },
    riderFundsStatus: {
        type: String,
        enum: ['none', 'authorized', 'captured', 'refunded', 'partially_refunded'],
        default: 'none',
    },
    driverPayoutEligible: {
        type: Boolean,
        default: false,
    },
    cashPlatformReceivable: {
        amount: { type: Number, default: 0, min: 0 },
        status: {
            type: String,
            enum: ['outstanding', 'settled', 'waived', 'netted_in_payout'],
            default: 'outstanding',
        },
        collectedAt: { type: Date, default: null },
        collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
        notes: { type: String, default: null },
    },
    cancellationFeeSplit: {
        totalFee: { type: Number, default: 0 },
        platformShare: { type: Number, default: 0 },
        driverShare: { type: Number, default: 0 },
        platformPercent: { type: Number, default: 0 },
        driverPercent: { type: Number, default: 0 },
    },
    vendorFineCredit: {
        type: Number,
        default: 0,
        min: 0,
    },
    riderPenaltyAmount: {
        type: Number,
        default: 0,
        min: 0,
    },
}, {
    timestamps: true,
});

// Compound index for driver analytics queries
adminEarningsSchema.index({ driverId: 1, rideDate: -1 });

// Index for date range queries
adminEarningsSchema.index({ rideDate: -1 });

module.exports = mongoose.model('AdminEarnings', adminEarningsSchema);

