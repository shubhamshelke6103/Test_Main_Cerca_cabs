/**
 * Pickup waiting charges: free period, tier-1 (₹/min), tier-2 (₹/min).
 * Billable wait uses ceiling of total wait to whole minutes (documented).
 */

const roundMoney = (n) => Math.round(Number(n || 0) * 100) / 100

/** Defaults when settings.pricingConfigurations omit pickup wait keys */
const DEFAULT_POLICY = {
  pickupWaitFreeMinutes: 5,
  pickupWaitTier1EndMinute: 8,
  pickupWaitTier1RatePerMin: 4,
  pickupWaitTier2RatePerMin: 2,
  pickupWaitDriverCancelAfterMinutes: 8
}

function getPickupWaitPolicyFromSettings (settings) {
  const pc = settings?.pricingConfigurations || {}
  return {
    pickupWaitFreeMinutes:
      Number(pc.pickupWaitFreeMinutes) || DEFAULT_POLICY.pickupWaitFreeMinutes,
    pickupWaitTier1EndMinute:
      Number(pc.pickupWaitTier1EndMinute) || DEFAULT_POLICY.pickupWaitTier1EndMinute,
    pickupWaitTier1RatePerMin:
      Number(pc.pickupWaitTier1RatePerMin) || DEFAULT_POLICY.pickupWaitTier1RatePerMin,
    pickupWaitTier2RatePerMin:
      Number(pc.pickupWaitTier2RatePerMin) || DEFAULT_POLICY.pickupWaitTier2RatePerMin,
    pickupWaitDriverCancelAfterMinutes:
      Number(pc.pickupWaitDriverCancelAfterMinutes) ||
      DEFAULT_POLICY.pickupWaitDriverCancelAfterMinutes
  }
}

function policyVersionString (policy) {
  return [
    policy.pickupWaitFreeMinutes,
    policy.pickupWaitTier1EndMinute,
    policy.pickupWaitTier1RatePerMin,
    policy.pickupWaitTier2RatePerMin
  ].join(':')
}

/**
 * @param {number} waitSeconds — non-negative seconds from driver arrived to ride start (OTP)
 * @param {object} policy — from getPickupWaitPolicyFromSettings
 * @returns {{ waitSeconds, waitMinutesCeil, tier1BillableMinutes, tier2BillableMinutes, amountTier1, amountTier2, totalPickupWaitCharge }}
 */
function computePickupWaitingCharge (waitSeconds, policy) {
  const p = { ...DEFAULT_POLICY, ...policy }
  const sec = Math.max(0, Math.floor(Number(waitSeconds) || 0))
  const waitMinutesCeil = sec === 0 ? 0 : Math.ceil(sec / 60)

  const free = p.pickupWaitFreeMinutes
  const t1End = p.pickupWaitTier1EndMinute
  const r1 = p.pickupWaitTier1RatePerMin
  const r2 = p.pickupWaitTier2RatePerMin

  let tier1BillableMinutes = 0
  let tier2BillableMinutes = 0

  if (waitMinutesCeil <= free) {
    tier1BillableMinutes = 0
    tier2BillableMinutes = 0
  } else {
    const cappedForTier1 = Math.min(waitMinutesCeil, t1End)
    tier1BillableMinutes = Math.max(0, cappedForTier1 - free)
    if (waitMinutesCeil > t1End) {
      tier2BillableMinutes = waitMinutesCeil - t1End
    }
  }

  const amountTier1 = roundMoney(tier1BillableMinutes * r1)
  const amountTier2 = roundMoney(tier2BillableMinutes * r2)
  const totalPickupWaitCharge = roundMoney(amountTier1 + amountTier2)

  return {
    waitSeconds: sec,
    waitMinutesCeil,
    tier1BillableMinutes,
    tier2BillableMinutes,
    amountTier1,
    amountTier2,
    totalPickupWaitCharge
  }
}

/**
 * Build Mongo subdocument for ride.pickupWait at ride start.
 * @param {Date|null|undefined} driverArrivedAt
 * @param {Date} waitEndedAt — same as actualStartTime / start OTP
 * @param {object} policy
 */
function buildPickupWaitSnapshot (driverArrivedAt, waitEndedAt, policy) {
  const end = waitEndedAt instanceof Date ? waitEndedAt : new Date(waitEndedAt)
  if (!driverArrivedAt) {
    return {
      waitStartedAt: null,
      waitEndedAt: end,
      waitDurationSeconds: 0,
      freeMinutesApplied: policy.pickupWaitFreeMinutes,
      tier1BillableMinutes: 0,
      tier2BillableMinutes: 0,
      amountTier1: 0,
      amountTier2: 0,
      totalPickupWaitCharge: 0,
      computedAt: end,
      policyVersion: policyVersionString(policy)
    }
  }
  const start = driverArrivedAt instanceof Date ? driverArrivedAt : new Date(driverArrivedAt)
  const waitMs = Math.max(0, end.getTime() - start.getTime())
  const waitSeconds = Math.floor(waitMs / 1000)
  const calc = computePickupWaitingCharge(waitSeconds, policy)

  return {
    waitStartedAt: start,
    waitEndedAt: end,
    waitDurationSeconds: calc.waitSeconds,
    freeMinutesApplied: policy.pickupWaitFreeMinutes,
    tier1BillableMinutes: calc.tier1BillableMinutes,
    tier2BillableMinutes: calc.tier2BillableMinutes,
    amountTier1: calc.amountTier1,
    amountTier2: calc.amountTier2,
    totalPickupWaitCharge: calc.totalPickupWaitCharge,
    computedAt: end,
    policyVersion: policyVersionString(policy)
  }
}

module.exports = {
  DEFAULT_POLICY,
  roundMoney,
  getPickupWaitPolicyFromSettings,
  policyVersionString,
  computePickupWaitingCharge,
  buildPickupWaitSnapshot
}
