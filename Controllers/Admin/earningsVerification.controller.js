const logger = require('../../utils/logger')
const {
  validateEarningsForRide,
  validateDriverEarningsTotals,
  validateAdminEarningsTotals,
  findMissingEarnings,
  findIncorrectEarnings
} = require('../../utils/earningsValidator')
const { backfillEarnings } = require('../../utils/backfillEarnings')

/**
 * @desc    Verify earnings for a specific ride
 * @route   POST /admin/earnings/verify-ride/:rideId
 */
const verifyRideEarnings = async (req, res) => {
  try {
    const { rideId } = req.params

    if (!rideId) {
      return res.status(400).json({
        success: false,
        message: 'Ride ID is required'
      })
    }

    const result = await validateEarningsForRide(rideId)

    if (result.valid) {
      res.status(200).json({
        success: true,
        message: 'Earnings validation passed',
        data: result
      })
    } else {
      res.status(200).json({
        success: false,
        message: 'Earnings validation failed',
        data: result
      })
    }
  } catch (error) {
    logger.error('Error verifying ride earnings:', error)
    res.status(500).json({
      success: false,
      message: 'Error verifying ride earnings',
      error: error.message
    })
  }
}

/**
 * @desc    Verify all earnings for a driver
 * @route   POST /admin/earnings/verify-driver/:driverId
 */
const verifyDriverEarnings = async (req, res) => {
  try {
    const { driverId } = req.params
    const { startDate, endDate } = req.query

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: 'Driver ID is required'
      })
    }

    const result = await validateDriverEarningsTotals(driverId, startDate, endDate)

    res.status(200).json({
      success: result.valid,
      message: result.valid
        ? 'Driver earnings validation passed'
        : 'Driver earnings validation failed',
      data: result
    })
  } catch (error) {
    logger.error('Error verifying driver earnings:', error)
    res.status(500).json({
      success: false,
      message: 'Error verifying driver earnings',
      error: error.message
    })
  }
}

/**
 * @desc    Find completed rides without earnings records
 * @route   POST /admin/earnings/find-missing
 */
const findMissingEarningsRecords = async (req, res) => {
  try {
    const result = await findMissingEarnings()

    res.status(200).json({
      success: true,
      message: `Found ${result.missingCount || 0} rides without earnings records`,
      data: result
    })
  } catch (error) {
    logger.error('Error finding missing earnings:', error)
    res.status(500).json({
      success: false,
      message: 'Error finding missing earnings',
      error: error.message
    })
  }
}

/**
 * @desc    Trigger backfill for missing earnings
 * @route   POST /admin/earnings/backfill
 */
const triggerBackfill = async (req, res) => {
  try {
    const {
      dryRun = true, // Default to dry run for safety
      fixMode = false,
      batchSize = 100,
      startFromRideId = null
    } = req.body

    // Start backfill in background (don't wait for completion)
    backfillEarnings({
      dryRun,
      fixMode,
      batchSize,
      startFromRideId
    }).catch(error => {
      logger.error('Error during backfill:', error)
    })

    res.status(202).json({
      success: true,
      message: dryRun
        ? 'Backfill preview started (dry run mode)'
        : 'Backfill process started',
      data: {
        dryRun,
        fixMode,
        batchSize,
        startFromRideId
      }
    })
  } catch (error) {
    logger.error('Error triggering backfill:', error)
    res.status(500).json({
      success: false,
      message: 'Error triggering backfill',
      error: error.message
    })
  }
}

/**
 * @desc    Find incorrect earnings (don't match current settings)
 * @route   POST /admin/earnings/find-incorrect
 */
const findIncorrectEarningsRecords = async (req, res) => {
  try {
    const result = await findIncorrectEarnings()

    res.status(200).json({
      success: true,
      message: `Found ${result.incorrectCount || 0} earnings records that don't match current settings`,
      data: result
    })
  } catch (error) {
    logger.error('Error finding incorrect earnings:', error)
    res.status(500).json({
      success: false,
      message: 'Error finding incorrect earnings',
      error: error.message
    })
  }
}

/**
 * @desc    Validate admin earnings totals
 * @route   POST /admin/earnings/validate-totals
 */
const validateTotals = async (req, res) => {
  try {
    const { startDate, endDate } = req.query

    const result = await validateAdminEarningsTotals(startDate, endDate)

    res.status(200).json({
      success: result.valid,
      message: result.valid
        ? 'Total validation passed'
        : 'Total validation failed',
      data: result
    })
  } catch (error) {
    logger.error('Error validating totals:', error)
    res.status(500).json({
      success: false,
      message: 'Error validating totals',
      error: error.message
    })
  }
}

module.exports = {
  verifyRideEarnings,
  verifyDriverEarnings,
  findMissingEarningsRecords,
  triggerBackfill,
  findIncorrectEarningsRecords,
  validateTotals
}

