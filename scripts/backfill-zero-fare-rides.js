#!/usr/bin/env node
'use strict'

/**
 * One-off: set ride.fare from fareBreakdown.finalFare when fare is 0 but finalFare > 0.
 * Targets completed post-ride RAZORPAY with paymentStatus pending.
 *
 * Usage: node scripts/backfill-zero-fare-rides.js [--dry-run]
 */

require('dotenv').config()
const mongoose = require('mongoose')
const Ride = require('../Models/Driver/ride.model')

const dryRun = process.argv.includes('--dry-run')

async function main () {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) {
    console.error('Set MONGODB_URI or MONGO_URI')
    process.exit(1)
  }
  await mongoose.connect(uri)

  const rides = await Ride.find({
    status: 'completed',
    paymentMethod: 'RAZORPAY',
    paymentStatus: 'pending',
    $or: [{ fare: { $lte: 0 } }, { fare: null }, { fare: { $exists: false } }],
    'fareBreakdown.finalFare': { $gt: 0 }
  }).select('_id fare fareBreakdown.finalFare')

  console.log(`Found ${rides.length} ride(s) to backfill (dryRun=${dryRun})`)

  for (const r of rides) {
    const next = Number(r.fareBreakdown?.finalFare)
    console.log(`${r._id}: fare ${r.fare} -> ${next}`)
    if (!dryRun) {
      await Ride.updateOne({ _id: r._id }, { $set: { fare: next } })
    }
  }

  await mongoose.disconnect()
  console.log('Done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
