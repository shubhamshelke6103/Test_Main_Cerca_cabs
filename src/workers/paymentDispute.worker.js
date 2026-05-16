const logger = require('../../utils/logger')
const { runAutoConfirmJob } = require('../../utils/paymentDispute/autoConfirm.job')
const { runReminderJob } = require('../../utils/paymentDispute/reminder.job')
const { runDuesReconcileJob } = require('../../utils/paymentDispute/duesReconcile.job')
const {
  reconcileUnderReviewGatewayDisputes,
} = require('../../utils/paymentDispute/gatewayReconcile.service')

const AUTO_CONFIRM_MS = 5 * 60 * 1000
const REMINDER_MS = 60 * 60 * 1000
const RECONCILE_MS = 24 * 60 * 60 * 1000
const GATEWAY_MS = 15 * 60 * 1000

const safeRun = async (name, fn) => {
  try {
    await fn()
  } catch (err) {
    logger.error(`paymentDispute.worker ${name} failed:`, err)
  }
}

const initPaymentDisputeWorker = () => {
  if (process.env.PAYMENT_DISPUTE_WORKER_ENABLED === 'false') {
    logger.info('Payment dispute worker disabled')
    return
  }

  setInterval(() => safeRun('autoConfirm', runAutoConfirmJob), AUTO_CONFIRM_MS)
  setInterval(() => safeRun('reminder', runReminderJob), REMINDER_MS)
  setInterval(() => safeRun('duesReconcile', runDuesReconcileJob), RECONCILE_MS)
  setInterval(
    () => safeRun('gatewayReconcile', reconcileUnderReviewGatewayDisputes),
    GATEWAY_MS
  )

  logger.info('Payment dispute worker started')
}

module.exports = initPaymentDisputeWorker
