const mongoose = require('mongoose')
const Ride = require('../../Models/Driver/ride.model')
const logger = require('../../utils/logger')
const {
  REPORT_TZ,
  roundKm,
  getMongoPeriodKeys,
  buildCompletedRideMatch,
  formatPeriodSummary,
} = require('../../utils/driverDistanceReport')

/**
 * @desc    Driver mileage KPIs: today, this week, this month
 * @route   GET /drivers/:id/distance/summary
 */
const getDriverDistanceSummaryForDriver = async (req, res) => {
  try {
    const driverId = req.params.id
    const { date } = req.query

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({ message: 'Invalid driverId' })
    }

    const refDate = date ? new Date(date) : new Date()
    const { dayKey, weekKey, monthKey } = await getMongoPeriodKeys(refDate)

    const driverObjectId = new mongoose.Types.ObjectId(driverId)
    const baseStages = [
      {
        $match: {
          status: 'completed',
          driver: driverObjectId,
          driverTravelledKm: { $gt: 0 },
        },
      },
      {
        $addFields: {
          effectiveEnd: { $ifNull: ['$actualEndTime', '$updatedAt'] },
        },
      },
      {
        $addFields: {
          dayKey: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$effectiveEnd',
              timezone: REPORT_TZ,
            },
          },
          weekKey: {
            $dateToString: {
              format: '%G-W%V',
              date: '$effectiveEnd',
              timezone: REPORT_TZ,
            },
          },
          monthKey: {
            $dateToString: {
              format: '%Y-%m',
              date: '$effectiveEnd',
              timezone: REPORT_TZ,
            },
          },
        },
      },
    ]

    const [result] = await Ride.aggregate([
      ...baseStages,
      {
        $facet: {
          today: [
            { $match: { dayKey } },
            {
              $group: {
                _id: null,
                totalKm: { $sum: '$driverTravelledKm' },
                rideCount: { $sum: 1 },
              },
            },
          ],
          thisWeek: [
            { $match: { weekKey } },
            {
              $group: {
                _id: null,
                totalKm: { $sum: '$driverTravelledKm' },
                rideCount: { $sum: 1 },
              },
            },
          ],
          thisMonth: [
            { $match: { monthKey } },
            {
              $group: {
                _id: null,
                totalKm: { $sum: '$driverTravelledKm' },
                rideCount: { $sum: 1 },
              },
            },
          ],
        },
      },
    ])

    return res.status(200).json({
      success: true,
      data: {
        driverId,
        timezone: REPORT_TZ,
        dayKey,
        weekKey,
        monthKey,
        today: formatPeriodSummary(result?.today),
        thisWeek: formatPeriodSummary(result?.thisWeek),
        thisMonth: formatPeriodSummary(result?.thisMonth),
      },
    })
  } catch (error) {
    logger.error('Error fetching driver mileage summary:', error)
    const status = error.statusCode || 500
    return res.status(status).json({
      message: 'Error fetching driver mileage summary',
      error: error.message,
    })
  }
}

/**
 * @desc    Paginated completed rides with A→B→C km breakdown
 * @route   GET /drivers/:id/distance/rides
 */
const getDriverDistanceRidesForDriver = async (req, res) => {
  try {
    const driverId = req.params.id
    const { startDate, endDate, page = '1', limit = '20' } = req.query

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({ message: 'Invalid driverId' })
    }

    const now = new Date()
    const rangeStart = startDate
      ? new Date(startDate)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const rangeEnd = endDate ? new Date(endDate) : now

    const pageNum = Math.max(parseInt(page, 10) || 1, 1)
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50)
    const skip = (pageNum - 1) * limitNum

    let match
    try {
      match = buildCompletedRideMatch({
        driverId,
        startDate: rangeStart,
        endDate: rangeEnd,
      })
    } catch (err) {
      return res.status(err.statusCode || 400).json({ message: err.message })
    }

    const [countResult, rides, periodSummaryRows] = await Promise.all([
      Ride.aggregate([{ $match: match }, { $count: 'total' }]),
      Ride.find(match)
        .select(
          'pickupAddress dropoffAddress driverAcceptAt driverTravelledKm driverDistanceBreakdown actualEndTime updatedAt'
        )
        .sort({ actualEndTime: -1, updatedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Ride.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            totalKm: { $sum: '$driverTravelledKm' },
            rideCount: { $sum: 1 },
          },
        },
      ]),
    ])

    const totalRides = countResult[0]?.total || 0
    const totalPages = Math.ceil(totalRides / limitNum) || 1

    const items = rides.map(ride => {
      const breakdown = ride.driverDistanceBreakdown || {}
      return {
        rideId: ride._id,
        actualEndTime: ride.actualEndTime || ride.updatedAt,
        pickupAddress: ride.pickupAddress || null,
        dropoffAddress: ride.dropoffAddress || null,
        driverAcceptAt: ride.driverAcceptAt || null,
        driverTravelledKm: roundKm(ride.driverTravelledKm),
        acceptToPickupKm: roundKm(breakdown.acceptToPickupKm),
        pickupToDropKm: roundKm(breakdown.pickupToDropKm),
        distanceSource: breakdown.source || 'estimated',
      }
    })

    const periodSummary = periodSummaryRows[0] || { totalKm: 0, rideCount: 0 }
    const summary = {
      totalKm: roundKm(periodSummary.totalKm),
      rideCount: periodSummary.rideCount || 0,
      avgKmPerRide:
        (periodSummary.rideCount || 0) > 0
          ? roundKm(periodSummary.totalKm / periodSummary.rideCount)
          : 0,
    }

    return res.status(200).json({
      success: true,
      data: {
        timezone: REPORT_TZ,
        startDate: rangeStart,
        endDate: rangeEnd,
        summary,
        pagination: {
          currentPage: pageNum,
          totalPages,
          totalRides,
          limit: limitNum,
          hasMore: pageNum < totalPages,
        },
        items,
      },
    })
  } catch (error) {
    logger.error('Error fetching driver mileage rides:', error)
    return res.status(500).json({
      message: 'Error fetching driver mileage rides',
      error: error.message,
    })
  }
}

module.exports = {
  getDriverDistanceSummaryForDriver,
  getDriverDistanceRidesForDriver,
}
