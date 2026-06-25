const mongoose = require('mongoose')
const Ride = require('../Models/Driver/ride.model')
const {
  REPORT_TZ,
  getReportDayKey,
} = require('./adminReportTimezone')

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
        monthKey: {
          $dateToString: { format: '%Y-%m', date: '$d', timezone: timeZone },
        },
      },
    },
  ])
  return (
    row || {
      dayKey: getReportDayKey(date, timeZone),
      weekKey: null,
      monthKey: null,
    }
  )
}

function buildCompletedRideMatch({ driverId, startDate, endDate }) {
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

function formatPeriodSummary(bucket) {
  const row = bucket?.[0] || { totalKm: 0, rideCount: 0 }
  return {
    totalKm: roundKm(row.totalKm),
    rideCount: row.rideCount || 0,
    avgKmPerRide:
      (row.rideCount || 0) > 0
        ? roundKm(row.totalKm / row.rideCount)
        : 0,
  }
}

module.exports = {
  REPORT_TZ,
  roundKm,
  getMongoPeriodKeys,
  buildCompletedRideMatch,
  formatPeriodSummary,
}
