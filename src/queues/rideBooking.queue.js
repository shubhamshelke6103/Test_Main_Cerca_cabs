const logger = require('../../utils/logger')
const { rideBookingQueue } = require('../queues/rideBooking.queue')

module.exports = {
  /**
   * Add ride to Redis-backed queue (BullMQ)
   * Multi-server safe & idempotent
   */
  async add (jobName, data) {
    if (jobName !== 'process-ride') return
    if (!data?.rideId) return

    const rideId = data.rideId.toString()
    const jobId = `ride:${rideId}`

    try {
      // 🔒 Prevent duplicate jobs
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
        { jobId }
      )

      logger.info(
        `📥 Ride job queued (BullMQ) | rideId: ${rideId}`
      )
    } catch (err) {
      logger.error(
        `❌ Failed to queue ride job | rideId: ${rideId}`,
        err
      )
    }
  }
}
