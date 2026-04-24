/**
 * One-time migration: Settings.vehicleServices legacy keys → cercaZip | cercaGlide | cercaTitan.
 * Rollback: restore from backup or reverse-map keys in Mongo (not automated).
 *
 * Run: node scripts/migrate-settings-vehicle-services-keys.js
 */
require('dotenv').config()
const mongoose = require('mongoose')
const Settings = require('../Models/Admin/settings.modal')
const {
  VEHICLE_SERVICE_KEYS,
  remapVehicleServicesInput
} = require('../utils/vehicleServicesKeys')

const TIER_DEFAULTS = {
  cercaZip: {
    name: 'Cerca Zip',
    price: 299,
    perMinuteRate: 2,
    seats: 4,
    enabled: true,
    imagePath: 'assets/cars/cerca-small.png'
  },
  cercaGlide: {
    name: 'Cerca Glide',
    price: 499,
    perMinuteRate: 3,
    seats: 6,
    enabled: true,
    imagePath: 'assets/cars/Cerca-medium.png'
  },
  cercaTitan: {
    name: 'Cerca Titan',
    price: 699,
    perMinuteRate: 4,
    seats: 8,
    enabled: true,
    imagePath: 'assets/cars/cerca-large.png'
  }
}

async function run () {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) {
    console.error('Set MONGODB_URI or MONGO_URI')
    process.exit(1)
  }
  await mongoose.connect(uri)
  const doc = await Settings.findOne()
  if (!doc) {
    console.log('No settings document found; nothing to migrate.')
    await mongoose.disconnect()
    return
  }

  const raw =
    doc.vehicleServices && doc.vehicleServices.toObject
      ? doc.vehicleServices.toObject()
      : { ...(doc.vehicleServices || {}) }

  const merged = remapVehicleServicesInput({ ...raw })
  const out = {}
  for (const k of VEHICLE_SERVICE_KEYS) {
    out[k] = { ...TIER_DEFAULTS[k], ...(merged[k] || {}) }
  }

  await Settings.updateOne(
    { _id: doc._id },
    { $set: { vehicleServices: out } }
  )
  console.log('Migrated vehicleServices to keys:', VEHICLE_SERVICE_KEYS.join(', '))
  await mongoose.disconnect()
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
