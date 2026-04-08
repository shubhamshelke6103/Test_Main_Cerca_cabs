const { Worker } = require('bullmq')
const { redis } = require('../../config/redis')
const logger = require('../../utils/logger')
const { deliverExternalAlertById } = require('../../utils/alerting.service')
const { QUEUE_NAME } = require('../queues/externalAlertEmail.queue')

/**
 * Delivers queued ExternalAlert email rows (vendor password reset, etc.).
 * Uses same Redis connection as other BullMQ workers.
 */
const externalAlertEmailWorker = new Worker(
  QUEUE_NAME,
  async job => {
    const { alertId } = job.data
    if (!alertId) {
      logger.warn('externalAlertEmail worker: missing alertId')
      return
    }
    await deliverExternalAlertById(alertId)
  },
  { connection: redis }
)

void externalAlertEmailWorker

logger.info(`✅ externalAlertEmail worker listening on ${QUEUE_NAME}`)
