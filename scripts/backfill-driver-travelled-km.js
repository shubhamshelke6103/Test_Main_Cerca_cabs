#!/usr/bin/env node
'use strict'

/**
 * One-off: compute driverTravelledKm for completed rides with routePoints.
 *
 * Usage: node scripts/backfill-driver-travelled-km.js [--dry-run] [--batch=200]
 */

require('dotenv').config()
const mongoose = require('mongoose')
const Ride = require('../Models/Driver/ride.model')
const {
  computeDriverDistanceFromRide,
} = require('../utils/ride_booking_functions')

const dryRun = process.argv.includes('--dry-run')
const batchArg = process.argv.find(a => a.startsWith('--batch='))
const batchSize = batchArg ? parseInt(batchArg.split('=')[1], 10) : 200

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) {
    console.error('Set MONGODB_URI or MONGO_URI')
    process.exit(1)
  }
  await mongoose.connect(uri)

  const query = {
    status: 'completed',
    $or: [
      { driverTravelledKm: { $exists: false } },
      { driverTravelledKm: null },
      { driverTravelledKm: { $lte: 0 } },
    ],
    $expr: { $gte: [{ $size: { $ifNull: ['$routePoints', []] } }, 2] },
  }

  const total = await Ride.countDocuments(query)
  console.log(`Found ${total} ride(s) to backfill (dryRun=${dryRun}, batch=${batchSize})`)

  let processed = 0
  let updated = 0

  while (processed < total) {
    const rides = await Ride.find(query)
      .select(
        'routePoints driverAcceptLocation pickupLocation dropoffLocation actualStartTime driverArrivedAt status'
      )
      .sort({ actualEndTime: 1 })
      .limit(batchSize)
      .lean()

    if (!rides.length) break

    for (const ride of rides) {
      processed += 1
      const computed = computeDriverDistanceFromRide(ride)
      if (!computed) {
        console.log(`${ride._id}: skipped (could not compute)`)
        continue
      }

      console.log(
        `${ride._id}: driverTravelledKm=${computed.driverTravelledKm} source=${computed.driverDistanceBreakdown?.source}`
      )

      if (!dryRun) {
        await Ride.updateOne(
          { _id: ride._id },
          {
            $set: {
              driverTravelledKm: computed.driverTravelledKm,
              driverTravelledKmComputedAt: new Date(),
              driverDistanceBreakdown: computed.driverDistanceBreakdown,
            },
          }
        )
      }
      updated += 1
    }
  }

  await mongoose.disconnect()
  console.log(`Done. processed=${processed} updated=${updated}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
