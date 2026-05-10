/**
 * Derive AdminEarnings settlement fields from Ride payment state.
 * @param {object} ride - Ride doc or lean object (paymentMethod, paymentStatus)
 * @param {number} platformFee - rounded platform fee for this earning row
 */
function deriveAdminEarningsSettlementFields (ride, platformFee) {
  const method = String(ride?.paymentMethod || '').toUpperCase()
  const riderPaid = ride?.paymentStatus === 'completed'
  const isCash = method === 'CASH'

  let paymentStatus = 'pending'
  let riderFundsStatus = 'none'
  let driverPayoutEligible = false
  let cashPlatformReceivable

  if (isCash) {
    paymentStatus = riderPaid ? 'completed' : 'pending'
    riderFundsStatus = riderPaid ? 'captured' : 'none'
    if (riderPaid && platformFee > 0) {
      cashPlatformReceivable = {
        amount: Math.round(platformFee * 100) / 100,
        status: 'outstanding',
        collectedAt: null,
        collectedBy: null,
        notes: null
      }
      driverPayoutEligible = false
    }
  } else {
    paymentStatus = riderPaid ? 'completed' : 'pending'
    if (riderPaid) {
      riderFundsStatus = 'captured'
      driverPayoutEligible = true
    } else if (method === 'RAZORPAY') {
      riderFundsStatus = 'authorized'
    } else if (ride?.paymentStatus === 'refunded') {
      riderFundsStatus = 'refunded'
    } else {
      riderFundsStatus = 'none'
    }
  }

  return {
    paymentStatus,
    riderFundsStatus,
    driverPayoutEligible,
    cashPlatformReceivable
  }
}

/**
 * After ride.paymentStatus becomes completed (wallet / Razorpay / webhook), sync existing AdminEarnings row.
 */
async function syncAdminEarningsAfterRidePaid (rideId) {
  const AdminEarnings = require('../Models/Admin/adminEarnings.model')
  const Ride = require('../Models/Driver/ride.model')

  const ride = await Ride.findById(rideId)
    .select('paymentMethod paymentStatus')
    .lean()
  if (!ride) return null

  const earning = await AdminEarnings.findOne({ rideId })
  if (!earning) return null

  const fields = deriveAdminEarningsSettlementFields(ride, earning.platformFee || 0)
  const isCash = String(ride.paymentMethod || '').toUpperCase() === 'CASH'

  if (isCash) {
    const update = {
      paymentStatus: fields.paymentStatus,
      riderFundsStatus: fields.riderFundsStatus
    }
    if (earning.cashPlatformReceivable?.status === 'settled') {
      update.driverPayoutEligible = true
    } else if (fields.cashPlatformReceivable) {
      update.cashPlatformReceivable = fields.cashPlatformReceivable
      update.driverPayoutEligible = false
    } else {
      update.driverPayoutEligible = fields.driverPayoutEligible
    }
    await AdminEarnings.updateOne({ _id: earning._id }, { $set: update })
  } else {
    await AdminEarnings.updateOne(
      { _id: earning._id },
      {
        $set: {
          paymentStatus: fields.paymentStatus,
          riderFundsStatus: fields.riderFundsStatus,
          driverPayoutEligible: fields.driverPayoutEligible
        },
        $unset: { cashPlatformReceivable: '' }
      }
    )
  }

  return earning._id
}

module.exports = {
  deriveAdminEarningsSettlementFields,
  syncAdminEarningsAfterRidePaid
}
