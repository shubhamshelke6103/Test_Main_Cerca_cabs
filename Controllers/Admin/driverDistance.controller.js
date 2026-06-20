const mongoose = require('mongoose')
const Ride = require('../../Models/Driver/ride.model')
const Driver = require('../../Models/Driver/driver.model')
const logger = require('../../utils/logger')
const {
  REPORT_TZ,
  getReportDayKey,
} = require('../../utils/adminReportTimezone')

const roundKm = value =>
  value == null || !Number.isFinite(Number(value))
    ? 0
    : Math.round(Number(value) * 100) / 100

async function getMongoPeriodKeys(date = new Date(), timeZone = REPORT_TZ) {
  const [row] = await Ride.aggregate([
    { $documents: [{ d: date }] },
    {
      $project: {
        dayKey: {
          $dateToString: { format: '%Y-%m-%d', date: '$d', timezone: timeZone },
        },
        weekKey: {
          $dateToString: { format: '%G-W%V', date: '$d', timezone: timeZone },
        },
      },
    },
  ])
  return row || { dayKey: getReportDayKey(date, timeZone), weekKey: null }
}

function buildCompletedRideMatch({
  driverId,
  startDate,
  endDate,
}) {
  const match = {
    status: 'completed',
    driver: { $exists: true, $ne: null },
    driverTravelledKm: { $gt: 0 },
  }

  if (driverId) {
    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      const err = new Error('Invalid driverId')
      err.statusCode = 400
      throw err
    }
    match.driver = new mongoose.Types.ObjectId(driverId)
  }

  if (startDate || endDate) {
    match.$expr = {
      $and: [
        startDate
          ? {
              $gte: [
                { $ifNull: ['$actualEndTime', '$updatedAt'] },
                new Date(startDate),
              ],
            }
          : true,
        endDate
          ? {
              $lte: [
                { $ifNull: ['$actualEndTime', '$updatedAt'] },
                new Date(endDate),
              ],
            }
          : true,
      ].filter(v => v !== true),
    }
  }

  return match
}

const getDriverDistanceSummary = async (req, res) => {
  try {
    const { driverId, date } = req.query
    if (!driverId) {
      return res.status(400).json({ message: 'driverId is required' })
    }
    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({ message: 'Invalid driverId' })
    }

    const refDate = date ? new Date(date) : new Date()
    const { dayKey, weekKey } = await getMongoPeriodKeys(refDate)

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
        },
      },
    ])

    const today = result?.today?.[0] || { totalKm: 0, rideCount: 0 }
    const thisWeek = result?.thisWeek?.[0] || { totalKm: 0, rideCount: 0 }

    return res.status(200).json({
      success: true,
      data: {
        driverId,
        timezone: REPORT_TZ,
        dayKey,
        weekKey,
        today: {
          totalKm: roundKm(today.totalKm),
          rideCount: today.rideCount || 0,
        },
        thisWeek: {
          totalKm: roundKm(thisWeek.totalKm),
          rideCount: thisWeek.rideCount || 0,
        },
      },
    })
  } catch (error) {
    logger.error('Error fetching driver distance summary:', error)
    const status = error.statusCode || 500
    return res.status(status).json({
      message: 'Error fetching driver distance summary',
      error: error.message,
    })
  }
}

const getDriverDistanceReport = async (req, res) => {
  try {
    const {
      driverId,
      startDate,
      endDate,
      groupBy = 'day',
      includeRides = 'false',
    } = req.query

    if (!['day', 'week'].includes(groupBy)) {
      return res.status(400).json({ message: 'groupBy must be day or week' })
    }

    const now = new Date()
    const rangeStart = startDate
      ? new Date(startDate)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const rangeEnd = endDate ? new Date(endDate) : now

    let match
    try {
      match = buildCompletedRideMatch({ driverId, startDate: rangeStart, endDate: rangeEnd })
    } catch (err) {
      return res.status(err.statusCode || 400).json({ message: err.message })
    }

    const periodField = groupBy === 'week' ? 'weekKey' : 'dayKey'
    const periodFormat = groupBy === 'week' ? '%G-W%V' : '%Y-%m-%d'

    const rows = await Ride.aggregate([
      { $match: match },
      {
        $addFields: {
          effectiveEnd: { $ifNull: ['$actualEndTime', '$updatedAt'] },
        },
      },
      {
        $addFields: {
          periodKey: {
            $dateToString: {
              format: periodFormat,
              date: '$effectiveEnd',
              timezone: REPORT_TZ,
            },
          },
        },
      },
      {
        $group: {
          _id: {
            driver: '$driver',
            period: '$periodKey',
          },
          totalKm: { $sum: '$driverTravelledKm' },
          rideCount: { $sum: 1 },
          rides: {
            $push: {
              rideId: '$_id',
              driverTravelledKm: '$driverTravelledKm',
              actualEndTime: '$effectiveEnd',
            },
          },
        },
      },
      { $sort: { '_id.period': -1, totalKm: -1 } },
    ])

    const driverIds = [...new Set(rows.map(r => String(r._id.driver)))]
    const drivers = await Driver.find({ _id: { $in: driverIds } })
      .select('name phone')
      .lean()
    const driverMap = Object.fromEntries(
      drivers.map(d => [String(d._id), d])
    )

    const items = rows.map(row => {
      const driver = driverMap[String(row._id.driver)]
      const totalKm = roundKm(row.totalKm)
      const rideCount = row.rideCount || 0
      const item = {
        driverId: row._id.driver,
        driverName: driver?.name || null,
        driverPhone: driver?.phone || null,
        period: row._id.period,
        periodField,
        rideCount,
        totalKm,
        avgKmPerRide: rideCount > 0 ? roundKm(totalKm / rideCount) : 0,
      }
      if (includeRides === 'true') {
        item.rides = (row.rides || []).map(r => ({
          rideId: r.rideId,
          driverTravelledKm: roundKm(r.driverTravelledKm),
          actualEndTime: r.actualEndTime,
        }))
      }
      return item
    })

    const summary = items.reduce(
      (acc, row) => {
        acc.totalKm += row.totalKm
        acc.rideCount += row.rideCount
        return acc
      },
      { totalKm: 0, rideCount: 0 }
    )
    summary.totalKm = roundKm(summary.totalKm)
    summary.avgKmPerRide =
      summary.rideCount > 0
        ? roundKm(summary.totalKm / summary.rideCount)
        : 0

    return res.status(200).json({
      success: true,
      data: {
        timezone: REPORT_TZ,
        groupBy,
        startDate: rangeStart,
        endDate: rangeEnd,
        summary,
        items,
      },
    })
  } catch (error) {
    logger.error('Error fetching driver distance report:', error)
    return res.status(500).json({
      message: 'Error fetching driver distance report',
      error: error.message,
    })
  }
}

const getDriverDistanceLeaderboard = async (req, res) => {
  try {
    const { startDate, endDate, limit = 20, driverId } = req.query
    const now = new Date()
    const rangeStart = startDate
      ? new Date(startDate)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const rangeEnd = endDate ? new Date(endDate) : now
    const maxLimit = Math.min(parseInt(limit, 10) || 20, 100)

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

    const rows = await Ride.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$driver',
          totalKm: { $sum: '$driverTravelledKm' },
          rideCount: { $sum: 1 },
        },
      },
      { $sort: { totalKm: -1 } },
      { $limit: maxLimit },
    ])

    const driverIds = rows.map(r => r._id)
    const drivers = await Driver.find({ _id: { $in: driverIds } })
      .select('name phone')
      .lean()
    const driverMap = Object.fromEntries(
      drivers.map(d => [String(d._id), d])
    )

    const items = rows.map((row, index) => {
      const driver = driverMap[String(row._id)]
      const totalKm = roundKm(row.totalKm)
      const rideCount = row.rideCount || 0
      return {
        rank: index + 1,
        driverId: row._id,
        driverName: driver?.name || null,
        driverPhone: driver?.phone || null,
        totalKm,
        rideCount,
        avgKmPerRide: rideCount > 0 ? roundKm(totalKm / rideCount) : 0,
      }
    })

    return res.status(200).json({
      success: true,
      data: {
        timezone: REPORT_TZ,
        startDate: rangeStart,
        endDate: rangeEnd,
        items,
      },
    })
  } catch (error) {
    logger.error('Error fetching driver distance leaderboard:', error)
    return res.status(500).json({
      message: 'Error fetching driver distance leaderboard',
      error: error.message,
    })
  }
}

module.exports = {
  getDriverDistanceSummary,
  getDriverDistanceReport,
  getDriverDistanceLeaderboard,
}
