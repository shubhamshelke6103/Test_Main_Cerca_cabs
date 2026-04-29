#!/usr/bin/env node
/**
 * Ops / debug: dump ride fields relevant to fare drift (quote vs completion).
 * Usage: MONGODB_URI=... node scripts/dump-ride-fare-lineage.js <rideId>
 */
const mongoose = require('mongoose')
require('dotenv').config()

const rideId = process.argv[2]
if (!rideId) {
  console.error('Usage: node scripts/dump-ride-fare-lineage.js <rideId>')
  process.exit(1)
}

const Ride = require('../Models/Driver/ride.model')

async function main () {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) {
    console.error('Set MONGODB_URI (or MONGO_URI)')
    process.exit(1)
  }
  await mongoose.connect(uri)
  const ride = await Ride.findById(rideId).lean()
  if (!ride) {
    console.error('Ride not found:', rideId)
    process.exit(1)
  }
  const out = {
    _id: ride._id,
    status: ride.status,
    fare: ride.fare,
    fareAtBooking: ride.fareAtBooking,
    discount: ride.discount,
    promoCode: ride.promoCode,
    distanceInKm: ride.distanceInKm,
    estimatedDistanceInKm: ride.estimatedDistanceInKm,
    actualDistanceInKm: ride.actualDistanceInKm,
    estimatedDuration: ride.estimatedDuration,
    actualDuration: ride.actualDuration,
    routePointCount: Array.isArray(ride.routePoints) ? ride.routePoints.length : 0,
    fareBreakdown: ride.fareBreakdown,
    vehicleService: ride.vehicleService,
    service: ride.service,
    bookingType: ride.bookingType,
    paymentMethod: ride.paymentMethod,
    createdAt: ride.createdAt,
    updatedAt: ride.updatedAt
  }
  console.log(JSON.stringify(out, null, 2))
  await mongoose.disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
