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
        pickupWaitDriverCancelAfterMinutes: { type: Number, default: 8 },
    },
    intercityPricingConfigurations: {
        enabled: { type: Boolean, default: true },
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
    vehicleServices: {
        cercaZip: {
            name: { type: String, default: 'Cerca Zip' },
            price: { type: Number, required: true, default: 299 },
            perMinuteRate: { type: Number, required: true, default: 2 },
            seats: { type: Number, default: 4 },
            enabled: { type: Boolean, default: true },
            imagePath: { type: String, default: 'assets/cars/cerca-zip.png' }
        },
        cercaGlide: {
            name: { type: String, default: 'Cerca Glide' },
            price: { type: Number, required: true, default: 499 },
            perMinuteRate: { type: Number, required: true, default: 3 },
            seats: { type: Number, default: 6 },
            enabled: { type: Boolean, default: true },
            imagePath: { type: String, default: 'assets/cars/cerca-glide.png' }
        },
        cercaTitan: {
            name: { type: String, default: 'Cerca Titan' },
            price: { type: Number, required: true, default: 699 },
            perMinuteRate: { type: Number, required: true, default: 4 },
            seats: { type: Number, default: 8 },
            enabled: { type: Boolean, default: true },
            imagePath: { type: String, default: 'assets/cars/cerca-titan.png' }
        }
    },
}, { timestamps: true });

module.exports = mongoose.model('Settings', SettingsSchema);
