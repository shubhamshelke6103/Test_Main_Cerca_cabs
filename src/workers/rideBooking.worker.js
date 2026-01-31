console.log('🔥 rideBooking.worker.js (BullMQ) loaded')

const { Worker } = require('bullmq')
const redis = require('../../config/redis')
const logger = require('../../utils/logger')

const { QUEUE_NAME } = require('../queues/rideBooking.queue') // ✅ IMPORTANT

const Ride = require('../../Models/Driver/ride.model')
const Driver = require('../../Models/Driver/driver.model')

const {
  searchDriversWithProgressiveRadius,
  createNotification,
  cancelRide
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
    const { rideId } = job.data

    logger.info(`🚀 Processing ride job | rideId: ${rideId}`)

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

    // ============================
    // FIND DRIVERS
    // ============================
    const { drivers, radiusUsed } =
      await searchDriversWithProgressiveRadius(
        ride.pickupLocation,
        [3000, 6000, 9000, 12000, 15000, 20000],
        ride.bookingType || null
      )

    logger.info(
      `📍 Found ${drivers.length} drivers within ${radiusUsed}m for ride ${rideId}`
    )

    // ============================
    // NO DRIVERS → CANCEL RIDE
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

    await Ride.findByIdAndUpdate(rideId, {
      $set: { notifiedDrivers: notifiedDriverIds }
    })

    logger.info(
      `✅ Ride ${rideId} processed | notifiedDrivers: ${notifiedDriverIds.length}`
    )
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
