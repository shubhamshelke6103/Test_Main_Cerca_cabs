const mongoose = require('mongoose')
const {
  REPORT_TZ,
  getReportDayKey,
} = require('./adminReportTimezone')

const roundKm = value =>
  value == null || !Number.isFinite(Number(value))
    ? 0
    : Math.round(Number(value) * 100) / 100

async function getMongoPeriodKeys(date = new Date(), timeZone = REPORT_TZ) {
  const localDate = new Date(
    date.toLocaleString('en-US', { timeZone })
  )

  const dayKey = localDate.toISOString().slice(0, 10)
  const monthKey = dayKey.slice(0, 7)

  const temp = new Date(localDate)
  temp.setHours(0, 0, 0, 0)
  temp.setDate(temp.getDate() + 3 - ((temp.getDay() + 6) % 7))

  const weekYear = temp.getFullYear()

  const week1 = new Date(weekYear, 0, 4)
  week1.setDate(week1.getDate() - ((week1.getDay() + 6) % 7))

  const weekNo =
    1 +
    Math.round(
      ((temp - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7
    )

  const weekKey = `${weekYear}-W${String(weekNo).padStart(2, '0')}`

  return {
    dayKey,
    weekKey,
    monthKey,
  }
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
        ...(startDate
          ? [
              {
                $gte: [
                  { $ifNull: ['$actualEndTime', '$updatedAt'] },
                  new Date(startDate),
                ],
              },
            ]
          : []),
        ...(endDate
          ? [
              {
                $lte: [
                  { $ifNull: ['$actualEndTime', '$updatedAt'] },
                  new Date(endDate),
                ],
              },
            ]
          : []),
      ],
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
      row.rideCount > 0
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