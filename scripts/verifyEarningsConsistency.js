/**
 * Earnings Consistency Verification Script
 * 
 * This script verifies data consistency across the earnings system:
 * 1. All completed rides should have AdminEarnings records
 * 2. Fare consistency: AdminEarnings.grossFare should match Ride.fare
 * 3. Calculation consistency: platformFee + driverEarning = grossFare
 * 4. Settings consistency: Verify earnings match current settings
 * 
 * Usage:
 *   node scripts/verifyEarningsConsistency.js
 *   node scripts/verifyEarningsConsistency.js --fix  # Attempt to fix issues
 */

require('dotenv').config()
const mongoose = require('mongoose')
const { connectDB } = require('../db')
const logger = require('../utils/logger')
const {
  validateEarningsForRide,
  findMissingEarnings,
  findIncorrectEarnings,
  validateAdminEarningsTotals
} = require('../utils/earningsValidator')
const AdminEarnings = require('../Models/Admin/adminEarnings.model')
const Ride = require('../Models/Driver/ride.model')
const Settings = require('../Models/Admin/settings.modal')

const FIX_MODE = process.argv.includes('--fix')

async function verifyEarningsConsistency() {
  try {
    await connectDB()
    logger.info('🔍 Starting earnings consistency verification...')

    const results = {
      missingEarnings: null,
      fareMismatches: [],
      calculationErrors: [],
      settingsMismatches: null,
      summary: {
        totalCompletedRides: 0,
        totalEarningsRecords: 0,
        missingCount: 0,
        fareMismatchCount: 0,
        calculationErrorCount: 0
      }
    }

    // ============================
    // 1. CHECK FOR MISSING EARNINGS
    // ============================
    logger.info('📊 Checking for missing earnings records...')
    const missingEarningsResult = await findMissingEarnings()
    results.missingEarnings = missingEarningsResult
    results.summary.totalCompletedRides = missingEarningsResult.totalCompletedRides || 0
    results.summary.totalEarningsRecords = missingEarningsResult.totalEarningsRecords || 0
    results.summary.missingCount = missingEarningsResult.missingCount || 0

    if (missingEarningsResult.missingCount > 0) {
      logger.warn(`⚠️ Found ${missingEarningsResult.missingCount} completed rides without earnings records`)
      if (FIX_MODE) {
        logger.info('🔧 Fix mode enabled - would trigger backfill (not implemented in this script)')
      }
    } else {
      logger.info('✅ All completed rides have earnings records')
    }

    // ============================
    // 2. CHECK FARE CONSISTENCY
    // ============================
    logger.info('💰 Checking fare consistency...')
    const earnings = await AdminEarnings.find({}).select('rideId grossFare').lean()
    const fareMismatches = []

    for (const earning of earnings) {
      const ride = await Ride.findById(earning.rideId).select('fare status').lean()
      if (!ride) {
        fareMismatches.push({
          rideId: earning.rideId.toString(),
          error: 'Ride not found',
          earningsGrossFare: earning.grossFare
        })
        continue
      }

      if (ride.status === 'completed') {
        const tolerance = 0.01
        if (Math.abs(earning.grossFare - ride.fare) > tolerance) {
          fareMismatches.push({
            rideId: earning.rideId.toString(),
            earningsGrossFare: earning.grossFare,
            rideFare: ride.fare,
            difference: Math.abs(earning.grossFare - ride.fare)
          })
        }
      }
    }

    results.fareMismatches = fareMismatches
    results.summary.fareMismatchCount = fareMismatches.length

    if (fareMismatches.length > 0) {
      logger.warn(`⚠️ Found ${fareMismatches.length} fare mismatches`)
      if (FIX_MODE) {
        logger.info('🔧 Fix mode enabled - would update earnings records (not implemented in this script)')
      }
    } else {
      logger.info('✅ All earnings fares match ride fares')
    }

    // ============================
    // 3. CHECK CALCULATION CONSISTENCY
    // ============================
    logger.info('🧮 Checking calculation consistency...')
    const allEarnings = await AdminEarnings.find({})
      .select('rideId grossFare platformFee driverEarning')
      .lean()

    const calculationErrors = []
    const tolerance = 0.01

    for (const earning of allEarnings) {
      const calculatedTotal = earning.platformFee + earning.driverEarning
      if (Math.abs(earning.grossFare - calculatedTotal) > tolerance) {
        calculationErrors.push({
          rideId: earning.rideId.toString(),
          grossFare: earning.grossFare,
          platformFee: earning.platformFee,
          driverEarning: earning.driverEarning,
          calculatedTotal,
          difference: Math.abs(earning.grossFare - calculatedTotal)
        })
      }
    }

    results.calculationErrors = calculationErrors
    results.summary.calculationErrorCount = calculationErrors.length

    if (calculationErrors.length > 0) {
      logger.warn(`⚠️ Found ${calculationErrors.length} calculation errors`)
      if (FIX_MODE) {
        logger.info('🔧 Fix mode enabled - would recalculate earnings (not implemented in this script)')
      }
    } else {
      logger.info('✅ All earnings calculations are consistent')
    }

    // ============================
    // 4. CHECK SETTINGS CONSISTENCY
    // ============================
    logger.info('⚙️ Checking settings consistency...')
    const settingsMismatches = await findIncorrectEarnings()
    results.settingsMismatches = settingsMismatches

    if (settingsMismatches.incorrectCount > 0) {
      logger.warn(`⚠️ Found ${settingsMismatches.incorrectCount} earnings records that don't match current settings`)
      logger.info('   (This is expected if settings were changed after rides were completed)')
    } else {
      logger.info('✅ All earnings match current settings')
    }

    // ============================
    // 5. VALIDATE TOTALS
    // ============================
    logger.info('📈 Validating totals...')
    const totalsValidation = await validateAdminEarningsTotals()
    if (!totalsValidation.valid) {
      logger.error('❌ Total validation failed:', totalsValidation.errors)
    } else {
      logger.info('✅ Total validation passed')
      logger.info(`   Total Gross Fare: ₹${totalsValidation.totals.totalGrossFare}`)
      logger.info(`   Total Platform Fee: ₹${totalsValidation.totals.totalPlatformFee}`)
      logger.info(`   Total Driver Earning: ₹${totalsValidation.totals.totalDriverEarning}`)
      logger.info(`   Admin Earnings: ₹${totalsValidation.totals.adminEarnings}`)
    }

    // ============================
    // SUMMARY
    // ============================
    logger.info('\n📋 Verification Summary:')
    logger.info(`   Total Completed Rides: ${results.summary.totalCompletedRides}`)
    logger.info(`   Total Earnings Records: ${results.summary.totalEarningsRecords}`)
    logger.info(`   Missing Earnings: ${results.summary.missingCount}`)
    logger.info(`   Fare Mismatches: ${results.summary.fareMismatchCount}`)
    logger.info(`   Calculation Errors: ${results.summary.calculationErrorCount}`)
    logger.info(`   Settings Mismatches: ${settingsMismatches.incorrectCount || 0}`)

    const hasIssues = 
      results.summary.missingCount > 0 ||
      results.summary.fareMismatchCount > 0 ||
      results.summary.calculationErrorCount > 0

    if (hasIssues) {
      logger.warn('\n⚠️ Issues found! Review the details above.')
      logger.info('   Run with --fix flag to attempt automatic fixes (if implemented)')
      process.exit(1)
    } else {
      logger.info('\n✅ All consistency checks passed!')
      process.exit(0)
    }
  } catch (error) {
    logger.error('❌ Error during consistency verification:', error)
    process.exit(1)
  } finally {
    await mongoose.connection.close()
  }
}

// Run verification
if (require.main === module) {
  verifyEarningsConsistency()
}

module.exports = { verifyEarningsConsistency }

