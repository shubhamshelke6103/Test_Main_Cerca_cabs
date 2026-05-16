const { reconcileAllRidersWithOpenDisputes } = require('./dues.service')
const logger = require('../logger')

const runDuesReconcileJob = async () => {
  const result = await reconcileAllRidersWithOpenDisputes()
  logger.info(`paymentDispute.duesReconcile: processed ${result.ridersProcessed} rider(s)`)
  return result
}

module.exports = { runDuesReconcileJob }
