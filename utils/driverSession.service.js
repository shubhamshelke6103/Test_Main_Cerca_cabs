const Driver = require('../Models/Driver/driver.model')
const DriverOnlineSession = require('../Models/Driver/driverOnlineSession.model')
const FleetVehicle = require('../Models/Vendor/fleetVehicle.model')

const DEFAULT_MAX_ONLINE_MINUTES = parseInt(
  process.env.DRIVER_MAX_ONLINE_MINUTES || '300',
  10
)

const roundMinutes = milliseconds =>
  Math.max(0, Math.round(milliseconds / (60 * 1000)))

const getGroupKey = (dateValue, groupBy = 'daily') => {
  if (groupBy === 'monthly') {
    return new Date(dateValue).toISOString().slice(0, 7)
  }
  if (groupBy === 'weekly') {
    const date = new Date(dateValue)
    const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    const day = utcDate.getUTCDay() || 7
    utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day)
    return `${utcDate.getUTCFullYear()}-W${String(
      Math.ceil((((utcDate - new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7)
    ).padStart(2, '0')}`
  }
  return new Date(dateValue).toISOString().slice(0, 10)
}

const addBucketMinutes = (buckets, key, minutes) => {
  if (!buckets[key]) {
    buckets[key] = { period: key, totalMinutes: 0, sessionCount: 0 }
  }
  buckets[key].totalMinutes += minutes
}

const startDriverOnlineSession = async (driverId, source = 'manual_toggle') => {
  let driver = await Driver.findById(driverId)
  if (!driver) {
    throw new Error('Driver not found')
  }

  if (driver.vendorId) {
    if (!driver.isVerified) {
      throw new Error('Driver account is not approved yet')
    }
    const hasLegacyVehicle =
      driver.vehicleInfo &&
      (driver.vehicleInfo.licensePlate || driver.vehicleInfo.make)
    if (driver.assignedFleetVehicleId) {
      const fv = await FleetVehicle.findById(driver.assignedFleetVehicleId).lean()
      if (
        !fv ||
        fv.approvalStatus !== 'APPROVED' ||
        String(fv.vendorId) !== String(driver.vendorId)
      ) {
        throw new Error('Assigned fleet vehicle is missing or not approved for your vendor')
      }
    } else if (!hasLegacyVehicle) {
      throw new Error(
        'Assign an approved fleet vehicle from your vendor (or complete vehicle onboarding) before going online'
      )
    }
  }

  if (driver.currentOnlineSessionStartedAt && driver.isOnline) {
    return driver
  }

  if (driver.currentOnlineSessionStartedAt && !driver.isOnline) {
    await stopDriverOnlineSession(driverId, `${source}_orphan_repair`)
    driver = await Driver.findById(driverId)
    if (!driver) {
      throw new Error('Driver not found')
    }
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
  const driver = await Driver.findById(driverId).select(
    'currentOnlineSessionStartedAt'
  )
  const sessions = await DriverOnlineSession.find({
    driver: driverId,
    loginAt: { $gte: startDate, $lte: endDate }
  }).sort({ loginAt: 1 })

  const buckets = {}
  for (const session of sessions) {
    const keyDate = session.loginAt || session.createdAt
    const key = getGroupKey(keyDate, groupBy)
    addBucketMinutes(buckets, key, session.durationMinutes || 0)
    buckets[key].sessionCount += 1
  }

  // Include currently-active session contribution clipped to requested range.
  if (driver?.currentOnlineSessionStartedAt) {
    const activeStart = new Date(driver.currentOnlineSessionStartedAt)
    const clippedStart = activeStart < startDate ? startDate : activeStart
    const clippedEnd = new Date() < endDate ? new Date() : endDate
    if (clippedStart < clippedEnd) {
      const liveMinutes = roundMinutes(clippedEnd.getTime() - clippedStart.getTime())
      const liveKey = getGroupKey(clippedStart, groupBy)
      addBucketMinutes(buckets, liveKey, liveMinutes)
    }
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

const getFleetOnlineHoursSummary = async ({
  driverIds = [],
  startDate,
  endDate,
  groupBy = 'daily'
}) => {
  const sessions = await DriverOnlineSession.find({
    driver: { $in: driverIds },
    loginAt: { $gte: startDate, $lte: endDate }
  })
    .select('driver loginAt createdAt durationMinutes')
    .sort({ loginAt: 1 })
    .lean()

  const buckets = {}
  const driverBreakdown = new Map()

  for (const session of sessions) {
    const keyDate = session.loginAt || session.createdAt
    const key = getGroupKey(keyDate, groupBy)
    addBucketMinutes(buckets, key, session.durationMinutes || 0)

    const driverKey = session.driver.toString()
    if (!driverBreakdown.has(driverKey)) {
      driverBreakdown.set(driverKey, { totalMinutes: 0, sessionCount: 0 })
    }
    const info = driverBreakdown.get(driverKey)
    info.totalMinutes += session.durationMinutes || 0
    info.sessionCount += 1
  }

  // Add active session contribution for online drivers.
  const activeDrivers = await Driver.find({
    _id: { $in: driverIds },
    currentOnlineSessionStartedAt: { $ne: null }
  }).select('_id currentOnlineSessionStartedAt')

  for (const driver of activeDrivers) {
    const activeStart = new Date(driver.currentOnlineSessionStartedAt)
    const clippedStart = activeStart < startDate ? startDate : activeStart
    const clippedEnd = new Date() < endDate ? new Date() : endDate
    if (clippedStart >= clippedEnd) continue

    const liveMinutes = roundMinutes(clippedEnd.getTime() - clippedStart.getTime())
    const key = getGroupKey(clippedStart, groupBy)
    addBucketMinutes(buckets, key, liveMinutes)

    const driverKey = driver._id.toString()
    if (!driverBreakdown.has(driverKey)) {
      driverBreakdown.set(driverKey, { totalMinutes: 0, sessionCount: 0 })
    }
    const info = driverBreakdown.get(driverKey)
    info.totalMinutes += liveMinutes
  }

  return {
    summary: Object.values(buckets),
    totalMinutes: Object.values(buckets).reduce((sum, item) => sum + item.totalMinutes, 0),
    totalSessions: sessions.length,
    driverBreakdown: Object.fromEntries(driverBreakdown)
  }
}

const autoStopExpiredDriverSessions = async ({
  maxOnlineMinutes = DEFAULT_MAX_ONLINE_MINUTES,
  limit = 100
} = {}) => {
  const safeMaxOnlineMinutes = Math.max(1, Number(maxOnlineMinutes) || DEFAULT_MAX_ONLINE_MINUTES)
  const safeLimit = Math.max(1, Number(limit) || 100)
  const threshold = new Date(Date.now() - safeMaxOnlineMinutes * 60 * 1000)

  const expiredDrivers = await Driver.find({
    isOnline: true,
    currentOnlineSessionStartedAt: { $ne: null, $lte: threshold }
  })
    .select('_id socketId currentOnlineSessionStartedAt isOnline isBusy')
    .limit(safeLimit)

  const stoppedDrivers = []

  for (const driver of expiredDrivers) {
    const updatedDriver = await stopDriverOnlineSession(driver._id, 'auto_timeout')
    stoppedDrivers.push(updatedDriver)
  }

  return {
    checkedAt: new Date(),
    maxOnlineMinutes: safeMaxOnlineMinutes,
    threshold,
    stoppedDrivers
  }
}

module.exports = {
  startDriverOnlineSession,
  stopDriverOnlineSession,
  autoStopExpiredDriverSessions,
  getDriverOnlineHoursSummary,
  getFleetOnlineHoursSummary
}
