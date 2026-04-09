/**
 * One-time backfill for vendorDriverCategory on drivers.
 * Run: node scripts/backfill-vendor-driver-category.js
 */
require('dotenv').config()
const mongoose = require('mongoose')
const Driver = require('../Models/Driver/driver.model')

async function run () {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) {
    console.error('Set MONGODB_URI or MONGO_URI')
    process.exit(1)
  }
  await mongoose.connect(uri)
  const r1 = await Driver.updateMany(
    { vendorId: null, $or: [{ vendorDriverCategory: null }, { vendorDriverCategory: { $exists: false } }] },
    { $set: { vendorDriverCategory: 'SELF' } }
  )
  const r2 = await Driver.updateMany(
    { vendorId: { $ne: null }, $or: [{ vendorDriverCategory: null }, { vendorDriverCategory: { $exists: false } }] },
    { $set: { vendorDriverCategory: 'OTHER' } }
  )
  console.log('Updated SELF (no vendor):', r1.modifiedCount)
  console.log('Updated OTHER (has vendor):', r2.modifiedCount)
  await mongoose.disconnect()
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
