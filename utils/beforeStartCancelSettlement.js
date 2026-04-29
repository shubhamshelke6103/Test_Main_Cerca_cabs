/**
 * Pure helpers for rider cancel before start OTP: distance policy and prepaid split.
 */

function roundMoney (n) {
  return Math.round(Number(n) * 100) / 100
}

/**
 * @param {object} opts
 * @param {number} opts.polylineKm - sum of segment haversine on routePoints
 * @param {number} opts.straightKm - pickup to driver position
 * @param {string} [opts.policy] - env BEFORE_START_DISTANCE_POLICY: 'max' (default) | 'polyline_first'
 */
function resolveTravelledDistanceKmBeforeStart ({
  polylineKm,
  straightKm,
  policy = 'max'
}) {
  const p = Number(polylineKm) || 0
  const s = Number(straightKm) || 0
  if (policy === 'polyline_first') {
    return roundMoney(p > 0 ? p : s)
  }
  return roundMoney(Math.max(p, s))
}

/**
 * Allocate cancellation charge across wallet-prepaid and Razorpay-prepaid.
 * Pw = wallet RIDE_PAYMENT total for ride; Pr = razorpayAmountPaid; O = totalCharge.
 *
 * use_w = wallet portion consumed toward O
 * use_r = razorpay portion consumed toward O
 * shortfall = extra owed beyond Pw+Pr (deducted from wallet)
 * razorpayRefund = amount to refund via Razorpay gateway
 *
 * Wallet after: W_current + (Pw - use_w) - shortfall
 */
function splitBeforeStartCancelPrepaid ({ Pw, Pr, O }) {
  const pw = Math.max(0, Number(Pw) || 0)
  const pr = Math.max(0, Number(Pr) || 0)
  const obligation = Math.max(0, Number(O) || 0)
  const use_w = Math.min(pw, obligation)
  let rem = obligation - use_w
  const use_r = Math.min(pr, rem)
  rem -= use_r
  const shortfall = Math.max(0, rem)
  const razorpayRefund = roundMoney(pr - use_r)
  return {
    use_w: roundMoney(use_w),
    use_r: roundMoney(use_r),
    shortfall: roundMoney(shortfall),
    razorpayRefund,
    prepaidWallet: roundMoney(pw),
    prepaidRazorpay: roundMoney(pr)
  }
}

function walletBalanceAfterBeforeStartCancel (W_current, Pw, { use_w, shortfall }) {
  return roundMoney(W_current + (Pw - use_w) - shortfall)
}

/**
 * Match storeRideEarnings split in socket.js
 */
function computePlatformSplitFromGrossFare (grossFare, pricingConfigurations) {
  const g = Math.max(0, Number(grossFare) || 0)
  if (g <= 0) {
    return { platformFee: 0, driverEarning: 0, grossFare: 0 }
  }
  const platformFees = Number(pricingConfigurations?.platformFees)
  const driverCommissions = Number(pricingConfigurations?.driverCommissions)
  const pfPct = Number.isFinite(platformFees) && platformFees >= 0 ? platformFees : 0
  const dcPct = Number.isFinite(driverCommissions) && driverCommissions >= 0
    ? driverCommissions
    : null

  let platformFee = pfPct ? g * (pfPct / 100) : 0
  let driverEarning = dcPct != null ? g * (dcPct / 100) : g - platformFee
  platformFee = roundMoney(platformFee)
  driverEarning = roundMoney(driverEarning)
  const tolerance = 0.01
  if (Math.abs(g - platformFee - driverEarning) > tolerance) {
    driverEarning = roundMoney(g - platformFee)
  }
  return { platformFee, driverEarning, grossFare: g }
}

module.exports = {
  roundMoney,
  resolveTravelledDistanceKmBeforeStart,
  splitBeforeStartCancelPrepaid,
  walletBalanceAfterBeforeStartCancel,
  computePlatformSplitFromGrossFare
}
