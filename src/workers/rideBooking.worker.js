console.log('🔥 rideBooking.worker.js (BullMQ) loaded')

const { Worker } = require('bullmq')
const { redis } = require('../../config/redis')
const logger = require('../../utils/logger')

const { QUEUE_NAME } = require('../queues/rideBooking.queue') // ✅ IMPORTANT

const Ride = require('../../Models/Driver/ride.model')
const Driver = require('../../Models/Driver/driver.model')

const {
  searchDriversWithProgressiveRadius,
  createNotification,
  cancelRide,
  clearWorkerLock
} = require('../../utils/ride_booking_functions')

const { getSocketIO } = require('../../utils/socket')

/**
 * BullMQ Worker — Ride Booking
 * ⚠️ RUN ONLY ON ONE SERVER
 * ✅ Redis Cluster–safe
 */
const rideBookingWorker = new Worker(
  QUEUE_NAME, // ✅ FIXED — NO MORE 'ride-booking'
  async job => {
    const { rideId, phase } = job.data

    logger.info(`🚀 Processing ride job | rideId: ${rideId}${phase ? ` | phase: ${phase}` : ''}`)

    // ============================
    // 🔒 REDIS WORKER LOCK (cluster-safe)
    // ============================
    const workerLockKey = `{ride-booking}:lock:${rideId}`
    const locked = await redis.set(workerLockKey, '1', 'NX', 'EX', 30)

    if (!locked) {
      logger.warn(`⏭️ Ride ${rideId} already being processed`)
      return
    }

    // ============================
    // FETCH RIDE
    // ============================
    const ride = await Ride.findById(rideId)
      .populate('rider', 'fullName name phone email')
      .select('+bookingType +bookingMeta')

    if (!ride) {
      logger.warn(`Ride not found | rideId: ${rideId}`)
      return
    }

    if (ride.status !== 'requested') {
      logger.info(`Ride ${rideId} already ${ride.status}, skipping`)
      return
    }

    const io = getSocketIO()

    const vehicleType = ride.vehicleType || null
    const radii = [3000, 6000, 9000, 12000, 15000, 20000]
    const bookingType = ride.bookingType || null

    if (vehicleType) {
      logger.info(`🚗 Searching drivers for vehicle type: ${vehicleType}`)
    }

    let drivers
    let radiusUsed
    let discoveryPhase = null

    // ============================
    // PHASE 'normal': notify only non-priority drivers (after priority rejections)
    // ============================
    if (phase === 'normal') {
      const { drivers: normalDrivers, radiusUsed: ru } =
        await searchDriversWithProgressiveRadius(
          ride.pickupLocation,
          radii,
          bookingType,
          vehicleType,
          { priorityOnly: false, excludeDriverIds: ride.rejectedDrivers || [] }
        )
      drivers = normalDrivers
      radiusUsed = ru
      discoveryPhase = 'normal'

      if (!drivers.length) {
        logger.warn(`❌ No normal drivers found for ride ${rideId} (phase normal)`)

        const cancelledRide = await cancelRide(
          rideId,
          'system',
          `No drivers available after priority rejections`
        )

        if (ride.userSocketId) {
          io.to(ride.userSocketId).emit('noDriverFound', {
            rideId,
            message: 'No drivers available. All nearby drivers have declined.'
          })
          io.to(ride.userSocketId).emit('rideCancelled', {
            ride: cancelledRide,
            reason: 'No drivers available',
            cancelledBy: 'system'
          })
        }
        await createNotification({
          recipientId: ride.rider._id || ride.rider,
          recipientModel: 'User',
          title: 'Ride Cancelled',
          message: 'No drivers available. All nearby drivers have declined.',
          type: 'ride_cancelled',
          relatedRide: rideId
        })
        return
      }
    } else {
      // ============================
      // DEFAULT: try priority drivers first, else fall back to all drivers
      // ============================
      const { drivers: priorityDrivers, radiusUsed: ruPriority } =
        await searchDriversWithProgressiveRadius(
          ride.pickupLocation,
          radii,
          bookingType,
          vehicleType,
          { priorityOnly: true }
        )

      if (priorityDrivers.length > 0) {
        drivers = priorityDrivers
        radiusUsed = ruPriority
        discoveryPhase = 'priority'
        logger.info(`📍 Found ${drivers.length} priority drivers within ${radiusUsed}m for ride ${rideId}`)
      } else {
        // No priority drivers: same as current behavior (all drivers, no options)
        const result = await searchDriversWithProgressiveRadius(
          ride.pickupLocation,
          radii,
          bookingType,
          vehicleType
        )
        drivers = result.drivers
        radiusUsed = result.radiusUsed
        discoveryPhase = null
        logger.info(`📍 No priority drivers; found ${drivers.length} drivers within ${radiusUsed}m for ride ${rideId}`)
      }
    }

    // ============================
    // NO DRIVERS → CANCEL RIDE (default phase when no drivers at all)
    // ============================
    if (!drivers.length) {
      logger.warn(`❌ No drivers found for ride ${rideId}`)

      const cancelledRide = await cancelRide(
        rideId,
        'system',
        `No drivers found within ${Math.round(radiusUsed / 1000)}km radius`
      )

      if (ride.userSocketId) {
        io.to(ride.userSocketId).emit('noDriverFound', {
          rideId,
          message: 'No drivers available nearby'
        })

        io.to(ride.userSocketId).emit('rideCancelled', {
          ride: cancelledRide,
          reason: 'No drivers available',
          cancelledBy: 'system'
        })
      }

      await createNotification({
        recipientId: ride.rider._id || ride.rider,
        recipientModel: 'User',
        title: 'Ride Cancelled',
        message: 'No drivers available nearby',
        type: 'ride_cancelled',
        relatedRide: rideId
      })

      return
    }

    // ============================
    // NOTIFY DRIVERS
    // ============================
    const notifiedDriverIds = []

    for (const driver of drivers) {
      if (!driver.socketId) continue

      io.to(driver.socketId).emit('newRideRequest', ride)
      notifiedDriverIds.push(driver._id)

      try {
        await createNotification({
          recipientId: driver._id,
          recipientModel: 'Driver',
          title: 'New Ride Request',
          message: 'Ride available near you',
          type: 'ride_request',
          relatedRide: rideId
        })
      } catch (err) {
        logger.warn(
          `Notification failed for driver ${driver._id}: ${err.message}`
        )
      }
    }

    const updatePayload = { $set: { notifiedDrivers: phase === 'normal' ? [...(ride.notifiedDrivers || []), ...notifiedDriverIds] : notifiedDriverIds } }
    if (discoveryPhase !== null) {
      updatePayload.$set.discoveryPhase = discoveryPhase
    }

    await Ride.findByIdAndUpdate(rideId, updatePayload)

    logger.info(
      `✅ Ride ${rideId} processed | notifiedDrivers: ${notifiedDriverIds.length}${discoveryPhase ? ` | discoveryPhase: ${discoveryPhase}` : ''}`
    )

    // ============================
    // REDIS LOCK CLEANUP (Multi-Instance Safe)
    // ============================
    // Lock will expire via TTL (30s), but explicit cleanup ensures immediate release
    // This is especially important if ride is cancelled/completed while worker is processing
    try {
      await clearWorkerLock(rideId)
    } catch (cleanupError) {
      // Don't fail job if cleanup fails - lock will expire via TTL
      logger.warn(`⚠️ Failed to clear worker lock for ride ${rideId}: ${cleanupError.message}`)
    }
  },
  {
    connection: redis,
    concurrency: 5
  }
)

rideBookingWorker.on('completed', job => {
  logger.info(`✅ Ride job completed | jobId: ${job.id}`)
})

rideBookingWorker.on('failed', (job, err) => {
  logger.error(`❌ Ride job failed | jobId: ${job?.id}`, err)
})

module.exports = rideBookingWorker
