const Settings = require('../../Models/Admin/settings.modal')

const DEFAULT_POLICY = {
  bookingBlockThresholdInr: 1,
  maxPendingDuesBeforeHardBlock: 2000,
  autoConfirmMinutes: 30,
  disputeReportGraceMinutes: 15,
  reminderIntervalHours: 6,
  maxReminders: 10,
  riderFraudSuspendThreshold: 3,
  driverFalseComplaintSuspendThreshold: 3,
}

let cachedPolicy = null
let cachedAt = 0
const CACHE_MS = 60 * 1000

const getPaymentDisputePolicy = async () => {
  const now = Date.now()
  if (cachedPolicy && now - cachedAt < CACHE_MS) {
    return cachedPolicy
  }
  try {
    const settings = await Settings.findOne().lean()
    cachedPolicy = {
      ...DEFAULT_POLICY,
      ...(settings?.paymentDisputePolicy || {}),
    }
  } catch {
    cachedPolicy = { ...DEFAULT_POLICY }
  }
  cachedAt = now
  return cachedPolicy
}

const clearPolicyCache = () => {
  cachedPolicy = null
  cachedAt = 0
}

module.exports = {
  DEFAULT_POLICY,
  getPaymentDisputePolicy,
  clearPolicyCache,
}
