/**
 * Shared payment-mode helpers for ride completion and cancel settlement.
 */

function isPostRideRazorpay (ride) {
  if (!ride) return false
  const pm = String(ride.paymentMethod || '').toUpperCase()
  const walletUsed = Number(ride.walletAmountUsed || 0) > 0.01
  return pm === 'RAZORPAY' && !ride.razorpayPaymentId && !walletUsed
}

function getAllowedSettlementMethodsForRide (ride) {
  if (isPostRideRazorpay(ride)) {
    return ['razorpay', 'cash']
  }
  const pm = String(ride.paymentMethod || '').toUpperCase()
  if (pm === 'WALLET') {
    return ['wallet', 'razorpay', 'cash']
  }
  return ['wallet', 'razorpay', 'cash']
}

function assertWalletSettlementAllowed (ride) {
  if (!isPostRideRazorpay(ride)) return
  const err = new Error(
    'This trip was booked as Pay Online. Please pay online or pay the driver in cash.'
  )
  err.code = 'PAYMENT_MODE_ONLINE_REQUIRED'
  err.statusCode = 409
  throw err
}

module.exports = {
  isPostRideRazorpay,
  getAllowedSettlementMethodsForRide,
  assertWalletSettlementAllowed
}
