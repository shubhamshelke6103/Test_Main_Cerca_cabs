/**
 * Driver bank-payout ledger: cash rides → −outstanding platform fee only;
 * non-cash → +driverEarning + tips. Cash ride driver share never counts toward bank payout.
 */

const roundCurrency = (n) => Math.round((Number(n) || 0) * 100) / 100

function resolvePaymentMethodFromEarning (earning) {
  const snap = earning?.paymentMethodSnapshot
  if (snap != null && String(snap).trim() !== '') {
    return String(snap).toUpperCase()
  }
  const ride = earning?.rideId
  const m = ride && (ride.paymentMethod ?? ride.payment_method)
  return String(m || '').toUpperCase()
}

function isCashPaymentMethod (methodUpper) {
  return methodUpper === 'CASH'
}

/**
 * @param {object[]} earnings AdminEarnings with optional rideId populated (paymentMethod, tips)
 * @param {Set<string>|string[]} paidEarningIds Earning _ids already tied to a payout request
 */
function computeDriverNetSettlementFromEarnings (earnings, paidEarningIds) {
  const paid =
    paidEarningIds instanceof Set
      ? paidEarningIds
      : new Set((paidEarningIds || []).map((id) => id.toString()))

  let net = 0
  let cashOwed = 0
  let onlineCredit = 0
  let unpaidOnlineEarningsCount = 0
  let tipsIncludedInNet = 0

  for (const e of earnings) {
    const id = e._id != null ? e._id.toString() : null
    if (!id || paid.has(id)) continue
    if (e.paymentStatus !== 'completed') continue

    const method = resolvePaymentMethodFromEarning(e)
    const tips = e.rideId?.tips || 0

    if (isCashPaymentMethod(method)) {
      if (e.cashPlatformReceivable?.status === 'outstanding') {
        const owed = roundCurrency(
          e.cashPlatformReceivable?.amount ?? e.platformFee ?? 0
        )
        net -= owed
        cashOwed += owed
      }
    } else {
      const add = roundCurrency((e.driverEarning || 0) + tips)
      net += add
      onlineCredit += add
      unpaidOnlineEarningsCount += 1
      tipsIncludedInNet += roundCurrency(tips)
    }
  }

  const netSettlementBalance = roundCurrency(net)
  const payoutableAmount = roundCurrency(Math.max(0, netSettlementBalance))

  return {
    netSettlementBalance,
    payoutableAmount,
    cashOwedToPlatformTotal: roundCurrency(cashOwed),
    onlineCreditInNet: roundCurrency(onlineCredit),
    unpaidOnlineEarningsCount,
    tipsIncludedInNet: roundCurrency(tipsIncludedInNet)
  }
}

/**
 * Earnings not yet on a payout, non-cash, completed — FIFO payout selection.
 * @param {import('mongoose').Document[]|object[]} earnings
 * @param {Set<string>} paidEarningIds
 */
function listUnpaidOnlineEarningsSortedForPayout (earnings, paidEarningIds) {
  const paid =
    paidEarningIds instanceof Set
      ? paidEarningIds
      : new Set((paidEarningIds || []).map((id) => id.toString()))

  return earnings
    .filter((e) => {
      const id = e._id != null ? e._id.toString() : null
      if (!id || paid.has(id)) return false
      if (e.paymentStatus !== 'completed') return false
      return !isCashPaymentMethod(resolvePaymentMethodFromEarning(e))
    })
    .sort((a, b) => {
      const ta = new Date(a.rideDate || 0).getTime()
      const tb = new Date(b.rideDate || 0).getTime()
      return ta - tb
    })
}

async function buildPaidEarningIdsSet (driverId, payoutStatuses) {
  const Payout = require('../Models/Driver/payout.model')
  const statuses = payoutStatuses || [
    'COMPLETED',
    'PROCESSING',
    'PENDING'
  ]
  const payouts = await Payout.find({
    driver: driverId,
    status: { $in: statuses }
  })
    .select('relatedEarnings')
    .lean()

  const set = new Set()
  for (const p of payouts) {
    for (const id of p.relatedEarnings || []) {
      if (id) set.add(id.toString())
    }
  }
  return set
}

/**
 * All completed earnings for driver (populate ride for method/tips fallback).
 */
async function loadEarningsForDriverLedger (driverId) {
  const AdminEarnings = require('../Models/Admin/adminEarnings.model')
  return AdminEarnings.find({ driverId, paymentStatus: 'completed' })
    .populate('rideId', 'paymentMethod tips')
    .sort({ rideDate: 1 })
    .lean()
}

async function fetchDriverNetSettlement (driverId, payoutStatuses) {
  const paid = await buildPaidEarningIdsSet(driverId, payoutStatuses)
  const earnings = await loadEarningsForDriverLedger(driverId)
  const computed = computeDriverNetSettlementFromEarnings(earnings, paid)
  return { ...computed, paidEarningIds: paid, earnings }
}

module.exports = {
  roundCurrency,
  resolvePaymentMethodFromEarning,
  isCashPaymentMethod,
  computeDriverNetSettlementFromEarnings,
  listUnpaidOnlineEarningsSortedForPayout,
  buildPaidEarningIdsSet,
  loadEarningsForDriverLedger,
  fetchDriverNetSettlement
}
