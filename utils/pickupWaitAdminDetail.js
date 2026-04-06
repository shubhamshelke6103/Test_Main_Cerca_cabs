/**
 * Admin-facing pickup wait breakdown. Parses ride.pickupWait.policyVersion as
 * "freeMinutes:tier1EndMinute:rate1:rate2" (must match pickupWaitPricing.policyVersionString).
 */

const { DEFAULT_POLICY } = require('./pickupWaitPricing')

const roundMoney = (n) => Math.round(Number(n || 0) * 100) / 100

function formatDurationLabel (totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m === 0) return `${r}s`
  if (r === 0) return `${m}m`
  return `${m}m ${r}s`
}

function parsePolicyVersion (policyVersion) {
  if (!policyVersion || typeof policyVersion !== 'string') {
    return {
      policy: {
        pickupWaitFreeMinutes: DEFAULT_POLICY.pickupWaitFreeMinutes,
        pickupWaitTier1EndMinute: DEFAULT_POLICY.pickupWaitTier1EndMinute,
        pickupWaitTier1RatePerMin: DEFAULT_POLICY.pickupWaitTier1RatePerMin,
        pickupWaitTier2RatePerMin: DEFAULT_POLICY.pickupWaitTier2RatePerMin
      },
      policySource: 'default_fallback'
    }
  }
  const parts = policyVersion.split(':').map((x) => Number(x))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return {
      policy: {
        pickupWaitFreeMinutes: DEFAULT_POLICY.pickupWaitFreeMinutes,
        pickupWaitTier1EndMinute: DEFAULT_POLICY.pickupWaitTier1EndMinute,
        pickupWaitTier1RatePerMin: DEFAULT_POLICY.pickupWaitTier1RatePerMin,
        pickupWaitTier2RatePerMin: DEFAULT_POLICY.pickupWaitTier2RatePerMin
      },
      policySource: 'default_fallback'
    }
  }
  return {
    policy: {
      pickupWaitFreeMinutes: parts[0],
      pickupWaitTier1EndMinute: parts[1],
      pickupWaitTier1RatePerMin: parts[2],
      pickupWaitTier2RatePerMin: parts[3]
    },
    policySource: 'snapshot'
  }
}

/**
 * @param {object} ride — Mongoose doc or plain object
 * @returns {object|null} null if no pickup-wait window applies
 */
function buildPickupWaitAdminDetail (ride) {
  if (!ride) return null

  const pw = ride.pickupWait
  const arrived = ride.driverArrivedAt
  const started = ride.actualStartTime || ride.startOtpVerifiedAt
  const fbCharge =
    ride.fareBreakdown && ride.fareBreakdown.pickupWaitCharge != null
      ? roundMoney(ride.fareBreakdown.pickupWaitCharge)
      : null

  let durationSeconds = 0
  if (pw && pw.waitDurationSeconds != null && pw.waitDurationSeconds >= 0) {
    durationSeconds = Math.floor(Number(pw.waitDurationSeconds))
  } else if (arrived && started) {
    const a = new Date(arrived).getTime()
    const b = new Date(started).getTime()
    if (!Number.isNaN(a) && !Number.isNaN(b) && b >= a) {
      durationSeconds = Math.floor((b - a) / 1000)
    }
  }

  const hasWindow =
    (arrived && started) ||
    (pw &&
      (pw.waitStartedAt ||
        pw.waitEndedAt ||
        (pw.waitDurationSeconds != null && pw.waitDurationSeconds > 0)))

  if (!hasWindow && (!pw || durationSeconds === 0)) {
    return {
      present: false,
      message: 'No pickup wait data (ride not started at pickup or no arrival timestamp).'
    }
  }

  const { policy, policySource } = parsePolicyVersion(pw?.policyVersion)
  const freeM = policy.pickupWaitFreeMinutes
  const rate1 = policy.pickupWaitTier1RatePerMin
  const rate2 = policy.pickupWaitTier2RatePerMin
  const tier1End = policy.pickupWaitTier1EndMinute

  const billingLines = []
  billingLines.push({
    kind: 'free_window',
    text: `First ${freeM} min free`,
    minutes: freeM,
    ratePerMin: 0,
    amount: 0
  })

  const t1min = pw ? Math.floor(Number(pw.tier1BillableMinutes) || 0) : 0
  const t2min = pw ? Math.floor(Number(pw.tier2BillableMinutes) || 0) : 0
  const amt1 = pw ? roundMoney(pw.amountTier1) : 0
  const amt2 = pw ? roundMoney(pw.amountTier2) : 0
  const totalSnap = pw ? roundMoney(pw.totalPickupWaitCharge) : 0

  if (t1min > 0) {
    billingLines.push({
      kind: 'tier_a',
      text: `Tier A (min ${freeM + 1}–${tier1End}): ${t1min} min × ₹${rate1}/min = ₹${amt1.toFixed(2)}`,
      minutes: t1min,
      ratePerMin: rate1,
      amount: amt1
    })
  }
  if (t2min > 0) {
    billingLines.push({
      kind: 'tier_b',
      text: `Tier B (after min ${tier1End}): ${t2min} min × ₹${rate2}/min = ₹${amt2.toFixed(2)}`,
      minutes: t2min,
      ratePerMin: rate2,
      amount: amt2
    })
  }

  const durationLabel = formatDurationLabel(durationSeconds)

  const parts = [`Wait ${durationLabel}`, `₹${totalSnap.toFixed(2)}`]
  if (amt1 > 0 || amt2 > 0) {
    const bits = []
    if (amt1 > 0) bits.push(`tier A ₹${amt1.toFixed(2)}`)
    if (amt2 > 0) bits.push(`tier B ₹${amt2.toFixed(2)}`)
    parts.push(`(${bits.join(' + ')})`)
  }
  const summaryLine = parts.join(' · ')

  let billingAligned = true
  let billingNote = null
  if (fbCharge != null && pw) {
    billingAligned = Math.abs(fbCharge - totalSnap) <= 0.02
    if (!billingAligned) {
      billingNote = `fareBreakdown.pickupWaitCharge (₹${fbCharge.toFixed(2)}) differs from snapshot total (₹${totalSnap.toFixed(2)}).`
    }
  } else if (fbCharge != null && !pw) {
    billingAligned = Math.abs(fbCharge) <= 0.02
    if (!billingAligned) {
      billingNote = 'fareBreakdown has pickupWaitCharge but ride has no pickupWait snapshot.'
    }
  } else if (fbCharge == null && pw && ride.status === 'completed' && totalSnap > 0) {
    billingNote =
      'Ride completed: pickup wait charged in snapshot but fareBreakdown.pickupWaitCharge not set on document.'
    billingAligned = false
  }

  return {
    present: true,
    durationSeconds,
    durationLabel,
    waitStartedAt: pw?.waitStartedAt || arrived || null,
    waitEndedAt: pw?.waitEndedAt || started || null,
    policyVersion: pw?.policyVersion || null,
    policyApplied: {
      freeMinutes: freeM,
      tier1EndMinute: tier1End,
      tier1RatePerMin: rate1,
      tier2RatePerMin: rate2
    },
    policySource,
    billingLines,
    totalPickupWaitCharge: totalSnap,
    fareBreakdownPickupWaitCharge: fbCharge,
    billingAligned,
    billingNote,
    summaryLine,
    snapshot: pw
      ? {
          tier1BillableMinutes: t1min,
          tier2BillableMinutes: t2min,
          amountTier1: amt1,
          amountTier2: amt2,
          freeMinutesApplied: pw.freeMinutesApplied
        }
      : null
  }
}

module.exports = {
  buildPickupWaitAdminDetail,
  formatDurationLabel,
  parsePolicyVersion
}
