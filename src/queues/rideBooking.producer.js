// src/producers/rideBooking.producer.js

const logger = require('../../utils/logger')
const {
  rideBookingQueue,
  QUEUE_NAME,
} = require('../queues/rideBooking.queue')

/**
 * Ride Booking Producer (BullMQ)
 * ✅ Redis Cluster–safe
 * ✅ Idempotent (no duplicate jobs)
 * ✅ Multi-server safe
 */
module.exports = {
  /**
   * Add ride booking job to queue
   * @param {string} jobName
   * @param {{ rideId: string }} data
   */
  async add(jobName, data) {
    if (jobName !== 'process-ride') return
    if (!data?.rideId) return

    const rideId = data.rideId.toString()

    /**
     * Job ID must be deterministic to prevent duplicates
     */
    const jobId = `ride:${rideId}`

    try {
      // 🔒 Prevent duplicate jobs (idempotency)
      const existingJob = await rideBookingQueue.getJob(jobId)
      if (existingJob) {
        logger.info(
          `⏭️ Ride job already queued | rideId: ${rideId}`
        )
        return
      }

      await rideBookingQueue.add(
        'process-ride',
        { rideId },
        {
          jobId,
          attempts: 3,                 // retry on failure
          backoff: {
            type: 'exponential',
            delay: 5000,               // 5s → 10s → 20s
          },
          removeOnComplete: true,
          removeOnFail: 100,
        }
      )

      logger.info(
        `📥 Ride job queued (BullMQ) | rideId: ${rideId} | queue: ${QUEUE_NAME}`
      )
    } catch (err) {
      logger.error(
        `❌ Failed to queue ride job | rideId: ${rideId}`,
        err
      )
    }
  },
}
