/**
 * One-time: cash rides with completed rider payment but no cashPlatformReceivable get an outstanding row.
 *
 *   node scripts/backfillCashPlatformReceivable.js
 *
 * Requires MONGO_URI / connectDB via .env (same as main API).
 */

require('dotenv').config()
const { connectDB } = require('../db')
const AdminEarnings = require('../Models/Admin/adminEarnings.model')
const Ride = require('../Models/Driver/ride.model')

async function run () {
  await connectDB()
  const cursor = AdminEarnings.find({}).cursor()
  let updated = 0
  for await (const e of cursor) {
    const ride = await Ride.findById(e.rideId)
      .select('paymentMethod paymentStatus')
      .lean()
    if (!ride) continue
    if (String(ride.paymentMethod || '').toUpperCase() !== 'CASH') continue
    if (ride.paymentStatus !== 'completed') continue
    if (e.cashPlatformReceivable?.status) continue

    const amount = Math.round((e.platformFee || 0) * 100) / 100
    await AdminEarnings.updateOne(
      { _id: e._id },
      {
        $set: {
          riderFundsStatus: 'captured',
          cashPlatformReceivable: {
            amount,
            status: 'outstanding',
            collectedAt: null,
            collectedBy: null,
            notes: 'backfillCashPlatformReceivable'
          },
          driverPayoutEligible: false
        }
      }
    )
    updated++
  }
  console.log(`backfillCashPlatformReceivable: updated ${updated} document(s)`)
  process.exit(0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
