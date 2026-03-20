const Driver = require('../Models/Driver/driver.model')
const DriverOnlineSession = require('../Models/Driver/driverOnlineSession.model')

const roundMinutes = milliseconds =>
  Math.max(0, Math.round(milliseconds / (60 * 1000)))

const startDriverOnlineSession = async (driverId, source = 'manual_toggle') => {
  const driver = await Driver.findById(driverId)
  if (!driver) {
    throw new Error('Driver not found')
  }

  if (driver.currentOnlineSessionStartedAt) {
    return driver
  }

  const startedAt = new Date()
  driver.currentOnlineSessionStartedAt = startedAt
  driver.isOnline = true
  driver.lastSeen = startedAt
  await driver.save()

  await DriverOnlineSession.create({
    driver: driver._id,
    loginAt: startedAt,
    source,
    status: 'active'
  })

  return driver
}

const stopDriverOnlineSession = async (
  driverId,
  source = 'manual_toggle',
  socketId = null
) => {
  const driver = await Driver.findById(driverId)
  if (!driver) {
    throw new Error('Driver not found')
  }

  const endedAt = new Date()
  let durationMinutes = 0

  if (driver.currentOnlineSessionStartedAt) {
    durationMinutes = roundMinutes(
      endedAt.getTime() - new Date(driver.currentOnlineSessionStartedAt).getTime()
    )
  }

  driver.totalOnlineMinutes = (driver.totalOnlineMinutes || 0) + durationMinutes
  driver.currentOnlineSessionStartedAt = null
  driver.isOnline = false
  driver.lastSeen = endedAt
  if (socketId && driver.socketId === socketId) {
    driver.socketId = undefined
  }
  await driver.save()

  await DriverOnlineSession.findOneAndUpdate(
    { driver: driver._id, status: 'active' },
    {
      $set: {
        logoutAt: endedAt,
        durationMinutes,
        source,
        status: 'closed'
      }
    },
    { sort: { loginAt: -1 } }
  )

  return driver
}

const getDriverOnlineHoursSummary = async (
  driverId,
  startDate,
  endDate,
  groupBy = 'daily'
) => {
  const sessions = await DriverOnlineSession.find({
    driver: driverId,
    loginAt: { $gte: startDate, $lte: endDate }
  }).sort({ loginAt: 1 })

  const buckets = {}
  for (const session of sessions) {
    const keyDate = session.loginAt || session.createdAt
    let key
    if (groupBy === 'monthly') {
      key = new Date(keyDate).toISOString().slice(0, 7)
    } else if (groupBy === 'weekly') {
      const date = new Date(keyDate)
      const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
      const day = utcDate.getUTCDay() || 7
      utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day)
      key = `${utcDate.getUTCFullYear()}-W${String(
        Math.ceil((((utcDate - new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7)
      ).padStart(2, '0')}`
    } else {
      key = new Date(keyDate).toISOString().slice(0, 10)
    }

    if (!buckets[key]) {
      buckets[key] = {
        period: key,
        totalMinutes: 0,
        sessionCount: 0
      }
    }

    buckets[key].totalMinutes += session.durationMinutes || 0
    buckets[key].sessionCount += 1
  }

  return {
    summary: Object.values(buckets),
    totalMinutes: Object.values(buckets).reduce(
      (sum, item) => sum + item.totalMinutes,
      0
    ),
    totalSessions: sessions.length
  }
}

module.exports = {
  startDriverOnlineSession,
  stopDriverOnlineSession,
  getDriverOnlineHoursSummary
}
