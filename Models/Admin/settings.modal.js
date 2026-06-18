const mongoose = require('mongoose');

const SettingsSchema = new mongoose.Schema({
    gst: {
        enabled: { type: Boolean, default: false },
        percentage: { type: Number, default: 3 },
    },
    pricingConfigurations: {
        baseFare: { type: Number, required: true },
        perKmRate: { type: Number, required: true },
        minimumFare: { type: Number, required: true },
        cancellationFees: { type: Number, required: true },
        platformFees: { type: Number, required: true },
        driverCommissions: { type: Number, required: true },
        pickupWaitFreeMinutes: { type: Number, default: 5 },
        pickupWaitTier1EndMinute: { type: Number, default: 8 },
        pickupWaitTier1RatePerMin: { type: Number, default: 4 },
        pickupWaitTier2RatePerMin: { type: Number, default: 2 },
        pickupWaitDriverCancelAfterMinutes: { type: Number, default: 7 },
        /** Used when client omits estimatedDuration: duration ≈ distance / speed (km/h). */
        estimatedAverageSpeedKmh: { type: Number, default: 35 },
        /**
         * INSTANT completion: fareAtBooking is used as a floor only when the trip is "substantive"
         * (actual time and distance both meet thresholds). Short/no-travel trips bill on actuals
         * with minimumFare only—reduces mis-tap / abuse while keeping quote protection on real trips.
         */
        substantiveTripMinDurationMinutes: { type: Number, default: 2 },
        substantiveTripMinDistanceKm: { type: Number, default: 0.3 },
        /** Required actual km ≥ max(substantiveTripMinDistanceKm, this × estimatedDistanceInKm). */
        substantiveTripEstimateDistanceFraction: { type: Number, default: 0.05 },
        /**
         * Time-of-day multipliers for distance + time fares.
         * Per-km distance slabs (0–5, 5–10, 10+ km) live on vehicleServices.*.distanceTiers.
         * When enabled=false, flat pricingConfigurations.perKmRate is used (legacy).
         */
        farePricing: {
            enabled: { type: Boolean, default: false },
            timezone: { type: String, default: 'Asia/Kolkata' },
            timeBands: [
                {
                    id: { type: String },
                    label: { type: String },
                    start: { type: String },
                    end: { type: String },
                    multiplier: { type: Number },
                },
            ],
            timeMultiplierAppliesTo: {
                type: String,
                enum: ['distanceAndTime', 'subtotalExcludingBase'],
                default: 'distanceAndTime',
            },
        },
    },
    intercityPricingConfigurations: {
        enabled: { type: Boolean, default: true },
        /** When true, intercity distance uses city pricingConfigurations.farePricing tiers. */
        useCityFarePricing: { type: Boolean, default: true },
        baseFare: { type: Number, default: 0 },
        perKmRates: {
            cercaZip: { type: Number, default: 10 },
            cercaGlide: { type: Number, default: 12 },
            cercaTitan: { type: Number, default: 16 },
        },
        tollChargeDefault: { type: Number, default: 0 },
        parkingChargeDefault: { type: Number, default: 0 },
        roundTripAllowance: {
            first24Hours: { type: Number, default: 300 },
            next24Hours: { type: Number, default: 500 },
            subsequent24Hours: { type: Number, default: 500 },
        },
        dailyDistanceAllowance: {
            thresholdKm: { type: Number, default: 300 },
            cercaZipPerKm: { type: Number, default: 10 },
            cercaGlidePerKm: { type: Number, default: 12 },
            cercaTitanPerKm: { type: Number, default: 16 },
        },
        matching: {
            batchSize: { type: Number, default: 5 },
            batchWaitSeconds: { type: Number, default: 45 },
            scheduledMatchLeadMinutes: { type: Number, default: 1440 },
            cronIntervalMinutes: { type: Number, default: 5 },
        },
    },
    services: [
        {
            name: { type: String, required: true },
            price: { type: Number, required: true },
        },
    ],
    systemSettings: {
        maintenanceMode: { type: Boolean, default: false },
        forceUpdate: { type: Boolean, default: false },
        maintenanceMessage: { type: String, required: false },
    },
    appVersions: {
        driverAppVersion: { type: String, required: false },
        userAppVersion: { type: String, required: false },
    },
    payoutConfigurations: {
        minPayoutThreshold: { type: Number, default: 500 },
        payoutSchedule: {
            type: String,
            enum: ['DAILY', 'WEEKLY', 'MONTHLY'],
            default: 'WEEKLY',
        },
        processingDays: { type: Number, default: 3 }, // Business days
    },
    /** Rider app + socket behaviour for prepaid flows */
    paymentFeatures: {
        prepaidWalletEnabled: { type: Boolean, default: true },
        /** When true, pure RAZORPAY bookings must include razorpayPaymentId at ride creation */
        prepaidRazorpayEnabled: { type: Boolean, default: false },
    },
    paymentDisputePolicy: {
        bookingBlockThresholdInr: { type: Number, default: 1 },
        maxPendingDuesBeforeHardBlock: { type: Number, default: 2000 },
        autoConfirmMinutes: { type: Number, default: 30 },
        disputeReportGraceMinutes: { type: Number, default: 0 },
        reminderIntervalHours: { type: Number, default: 6 },
        maxReminders: { type: Number, default: 10 },
        riderFraudSuspendThreshold: { type: Number, default: 3 },
        driverFalseComplaintSuspendThreshold: { type: Number, default: 3 },
    },
    /** Split of cancellation fee retained from rider (percentages sum to 100) */
    cancellationSettlement: {
        cancellationFeeSplitPlatformPercent: { type: Number, default: 50 },
        cancellationFeeSplitDriverPercent: { type: Number, default: 50 },
    },
    /**
     * Ride matching configuration. Currently controls the destination-reach
     * stacked-offer feature: while a driver is on an active INSTANT trip, they
     * can receive ONE additional offer if their live location is within
     * `destinationReachRadiusMeters` of the active drop-off and they don't
     * already have a queued ride. Setting `stackedAccept.enabled` to false
     * (or `destinationReachRadiusMeters` to 0) disables the feature globally.
     */
    rideMatching: {
        destinationReachRadiusMeters: { type: Number, default: 1500 },
        stackedAccept: {
            enabled: { type: Boolean, default: true },
        },
    },
    vehicleServices: {
        cercaZip: {
            name: { type: String, default: 'Cerca Zip' },
            price: { type: Number, required: true, default: 299 },
            perMinuteRate: { type: Number, required: true, default: 2 },
            seats: { type: Number, default: 4 },
            enabled: { type: Boolean, default: true },
            imagePath: { type: String, default: 'assets/cars/cerca-zip.png' },
            distanceTiers: {
                tier1: { maxKm: { type: Number, default: 5 }, ratePerKm: { type: Number } },
                tier2: { maxKm: { type: Number, default: 10 }, ratePerKm: { type: Number } },
                beyondTier2RatePerKm: { type: Number },
            },
        },
        cercaGlide: {
            name: { type: String, default: 'Cerca Glide' },
            price: { type: Number, required: true, default: 499 },
            perMinuteRate: { type: Number, required: true, default: 3 },
            seats: { type: Number, default: 6 },
            enabled: { type: Boolean, default: true },
            imagePath: { type: String, default: 'assets/cars/cerca-glide.png' },
            distanceTiers: {
                tier1: { maxKm: { type: Number, default: 5 }, ratePerKm: { type: Number } },
                tier2: { maxKm: { type: Number, default: 10 }, ratePerKm: { type: Number } },
                beyondTier2RatePerKm: { type: Number },
            },
        },
        cercaTitan: {
            name: { type: String, default: 'Cerca Titan' },
            price: { type: Number, required: true, default: 699 },
            perMinuteRate: { type: Number, required: true, default: 4 },
            seats: { type: Number, default: 8 },
            enabled: { type: Boolean, default: true },
            imagePath: { type: String, default: 'assets/cars/cerca-titan.png' },
            distanceTiers: {
                tier1: { maxKm: { type: Number, default: 5 }, ratePerKm: { type: Number } },
                tier2: { maxKm: { type: Number, default: 10 }, ratePerKm: { type: Number } },
                beyondTier2RatePerKm: { type: Number },
            },
        }
    },
}, { timestamps: true });

module.exports = mongoose.model('Settings', SettingsSchema);
