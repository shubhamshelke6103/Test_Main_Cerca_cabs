/**
 * Pure helpers for rider cancel before start OTP: distance policy and prepaid split.
 */

const {
  roundMoney,
  computeRideEarningsSplit
} = require('./rideEarningsSplit')

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

function computePlatformSplitFromGrossFare (grossFare, pricingConfigurations) {
  return computeRideEarningsSplit(grossFare)
}

module.exports = {
  roundMoney,
  resolveTravelledDistanceKmBeforeStart,
  splitBeforeStartCancelPrepaid,
  walletBalanceAfterBeforeStartCancel,
  computePlatformSplitFromGrossFare
}
