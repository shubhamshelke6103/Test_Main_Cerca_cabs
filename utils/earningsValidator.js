const AdminEarnings = require('../Models/Admin/adminEarnings.model')
const Ride = require('../Models/Driver/ride.model')
const Settings = require('../Models/Admin/settings.modal')
const logger = require('./logger')

/**
 * Validate earnings for a specific ride
 * @param {string} rideId - Ride ID to validate
 * @returns {Promise<Object>} Validation result
 */
const validateEarningsForRide = async (rideId) => {
  try {
    if (!rideId) {
      return {
        valid: false,
        errors: ['Ride ID is required']
      }
    }

    // Check if ride exists and is completed
    const ride = await Ride.findById(rideId).select('fare status').lean()
    if (!ride) {
      return {
        valid: false,
        errors: [`Ride ${rideId} not found`]
      }
    }

    if (ride.status !== 'completed') {
      return {
        valid: true,
        warnings: [`Ride ${rideId} is not completed (status: ${ride.status}), earnings validation skipped`]
      }
    }

    // Check if AdminEarnings record exists
    const earnings = await AdminEarnings.findOne({ rideId: rideId }).lean()
    if (!earnings) {
      return {
        valid: false,
        errors: [`No earnings record found for completed ride ${rideId}`],
        rideId: rideId,
        rideFare: ride.fare
      }
    }

    const errors = []
    const warnings = []

    // Verify grossFare matches ride.fare
    const fareTolerance = 0.01
    if (Math.abs(earnings.grossFare - ride.fare) > fareTolerance) {
      errors.push(
        `Fare mismatch - earnings.grossFare: ₹${earnings.grossFare}, ride.fare: ₹${ride.fare}, difference: ₹${Math.abs(earnings.grossFare - ride.fare)}`
      )
    }

    // Verify platformFee + driverEarning = grossFare (within tolerance)
    const calculatedTotal = earnings.platformFee + earnings.driverEarning
    if (Math.abs(earnings.grossFare - calculatedTotal) > fareTolerance) {
      errors.push(
        `Calculation mismatch - grossFare: ₹${earnings.grossFare}, platformFee + driverEarning: ₹${calculatedTotal}, difference: ₹${Math.abs(earnings.grossFare - calculatedTotal)}`
      )
    }

    // Verify calculations match current settings
    const settings = await Settings.findOne().select('pricingConfigurations').lean()
    if (settings && settings.pricingConfigurations) {
      const { platformFees, driverCommissions } = settings.pricingConfigurations
      const expectedPlatformFee = Math.round((earnings.grossFare * (platformFees / 100)) * 100) / 100
      const expectedDriverEarning = Math.round((earnings.grossFare * (driverCommissions / 100)) * 100) / 100

      if (Math.abs(earnings.platformFee - expectedPlatformFee) > fareTolerance) {
        warnings.push(
          `Platform fee doesn't match current settings - stored: ₹${earnings.platformFee}, expected: ₹${expectedPlatformFee} (settings may have changed)`
        )
      }

      if (Math.abs(earnings.driverEarning - expectedDriverEarning) > fareTolerance) {
        warnings.push(
          `Driver earning doesn't match current settings - stored: ₹${earnings.driverEarning}, expected: ₹${expectedDriverEarning} (settings may have changed)`
        )
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      rideId: rideId,
      earnings: {
        grossFare: earnings.grossFare,
        platformFee: earnings.platformFee,
        driverEarning: earnings.driverEarning,
        calculatedTotal: calculatedTotal
      },
      rideFare: ride.fare
    }
  } catch (error) {
    logger.error(`Error validating earnings for ride ${rideId}:`, error)
    return {
      valid: false,
      errors: [`Validation error: ${error.message}`]
    }
  }
}

/**
 * Validate driver earnings totals match aggregated values
 * @param {string} driverId - Driver ID
 * @param {Date} startDate - Start date (optional)
 * @param {Date} endDate - End date (optional)
 * @returns {Promise<Object>} Validation result
 */
const validateDriverEarningsTotals = async (driverId, startDate = null, endDate = null) => {
  try {
    if (!driverId) {
      return {
        valid: false,
        errors: ['Driver ID is required']
      }
    }

    const dateFilter = {}
    if (startDate || endDate) {
      dateFilter.rideDate = {}
      if (startDate) dateFilter.rideDate.$gte = new Date(startDate)
      if (endDate) dateFilter.rideDate.$lte = new Date(endDate)
    }

    dateFilter.driverId = driverId

    // Sum all AdminEarnings records
    const earnings = await AdminEarnings.find(dateFilter).select('grossFare platformFee driverEarning').lean()

    const totalGrossFare = earnings.reduce((sum, e) => sum + (e.grossFare || 0), 0)
    const totalPlatformFee = earnings.reduce((sum, e) => sum + (e.platformFee || 0), 0)
    const totalDriverEarning = earnings.reduce((sum, e) => sum + (e.driverEarning || 0), 0)

    // Verify calculations
    const errors = []
    const tolerance = 0.01

    if (Math.abs(totalGrossFare - (totalPlatformFee + totalDriverEarning)) > tolerance) {
      errors.push(
        `Total mismatch - totalGrossFare: ₹${totalGrossFare}, totalPlatformFee + totalDriverEarning: ₹${totalPlatformFee + totalDriverEarning}`
      )
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      driverId: driverId,
      totals: {
        totalGrossFare: Math.round(totalGrossFare * 100) / 100,
        totalPlatformFee: Math.round(totalPlatformFee * 100) / 100,
        totalDriverEarning: Math.round(totalDriverEarning * 100) / 100,
        recordCount: earnings.length
      }
    }
  } catch (error) {
    logger.error(`Error validating driver earnings totals for driver ${driverId}:`, error)
    return {
      valid: false,
      errors: [`Validation error: ${error.message}`]
    }
  }
}

/**
 * Validate admin earnings totals match aggregated values
 * @param {Date} startDate - Start date (optional)
 * @param {Date} endDate - End date (optional)
 * @returns {Promise<Object>} Validation result
 */
const validateAdminEarningsTotals = async (startDate = null, endDate = null) => {
  try {
    const dateFilter = {}
    if (startDate || endDate) {
      dateFilter.rideDate = {}
      if (startDate) dateFilter.rideDate.$gte = new Date(startDate)
      if (endDate) dateFilter.rideDate.$lte = new Date(endDate)
    }

    // Sum all AdminEarnings records
    const earnings = await AdminEarnings.find(dateFilter).select('grossFare platformFee driverEarning').lean()

    const totalGrossFare = earnings.reduce((sum, e) => sum + (e.grossFare || 0), 0)
    const totalPlatformFee = earnings.reduce((sum, e) => sum + (e.platformFee || 0), 0)
    const totalDriverEarning = earnings.reduce((sum, e) => sum + (e.driverEarning || 0), 0)

    // Verify calculations
    const errors = []
    const tolerance = 0.01

    if (Math.abs(totalGrossFare - (totalPlatformFee + totalDriverEarning)) > tolerance) {
      errors.push(
        `Total mismatch - totalGrossFare: ₹${totalGrossFare}, totalPlatformFee + totalDriverEarning: ₹${totalPlatformFee + totalDriverEarning}`
      )
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      totals: {
        totalGrossFare: Math.round(totalGrossFare * 100) / 100,
        totalPlatformFee: Math.round(totalPlatformFee * 100) / 100,
        totalDriverEarning: Math.round(totalDriverEarning * 100) / 100,
        adminEarnings: Math.round(totalPlatformFee * 100) / 100, // Admin earnings = platform fees
        recordCount: earnings.length
      }
    }
  } catch (error) {
    logger.error('Error validating admin earnings totals:', error)
    return {
      valid: false,
      errors: [`Validation error: ${error.message}`]
    }
  }
}

/**
 * Find completed rides without AdminEarnings records
 * @returns {Promise<Object>} List of missing earnings
 */
const findMissingEarnings = async () => {
  try {
    // Find all completed rides
    const completedRides = await Ride.find({ status: 'completed' })
      .select('_id fare driver rider actualEndTime')
      .lean()

    // Get all existing earnings rideIds
    const existingEarnings = await AdminEarnings.find({}).select('rideId').lean()
    const existingRideIds = new Set(existingEarnings.map(e => e.rideId.toString()))

    // Find rides without earnings
    const missingEarnings = completedRides.filter(ride => {
      const rideIdStr = ride._id.toString()
      return !existingRideIds.has(rideIdStr)
    })

    return {
      totalCompletedRides: completedRides.length,
      totalEarningsRecords: existingEarnings.length,
      missingCount: missingEarnings.length,
      missingRides: missingEarnings.map(ride => ({
        rideId: ride._id.toString(),
        fare: ride.fare,
        driverId: ride.driver?.toString() || null,
        riderId: ride.rider?.toString() || null,
        actualEndTime: ride.actualEndTime
      }))
    }
  } catch (error) {
    logger.error('Error finding missing earnings:', error)
    return {
      error: error.message,
      missingRides: []
    }
  }
}

/**
 * Find AdminEarnings records where calculations don't match current settings
 * Useful if settings changed but old records weren't updated
 * @returns {Promise<Object>} List of incorrect earnings
 */
const findIncorrectEarnings = async () => {
  try {
    const settings = await Settings.findOne().select('pricingConfigurations').lean()
    if (!settings || !settings.pricingConfigurations) {
      return {
        error: 'Settings not found'
      }
    }

    const { platformFees, driverCommissions } = settings.pricingConfigurations
    const tolerance = 0.01

    // Get all earnings records
    const earnings = await AdminEarnings.find({})
      .select('rideId grossFare platformFee driverEarning')
      .lean()

    const incorrectEarnings = []

    for (const earning of earnings) {
      const expectedPlatformFee = Math.round((earning.grossFare * (platformFees / 100)) * 100) / 100
      const expectedDriverEarning = Math.round((earning.grossFare * (driverCommissions / 100)) * 100) / 100

      if (
        Math.abs(earning.platformFee - expectedPlatformFee) > tolerance ||
        Math.abs(earning.driverEarning - expectedDriverEarning) > tolerance
      ) {
        incorrectEarnings.push({
          rideId: earning.rideId.toString(),
          grossFare: earning.grossFare,
          storedPlatformFee: earning.platformFee,
          expectedPlatformFee: expectedPlatformFee,
          storedDriverEarning: earning.driverEarning,
          expectedDriverEarning: expectedDriverEarning
        })
      }
    }

    return {
      totalEarningsRecords: earnings.length,
      incorrectCount: incorrectEarnings.length,
      incorrectEarnings: incorrectEarnings
    }
  } catch (error) {
    logger.error('Error finding incorrect earnings:', error)
    return {
      error: error.message,
      incorrectEarnings: []
    }
  }
}

module.exports = {
  validateEarningsForRide,
  validateDriverEarningsTotals,
  validateAdminEarningsTotals,
  findMissingEarnings,
  findIncorrectEarnings
}

