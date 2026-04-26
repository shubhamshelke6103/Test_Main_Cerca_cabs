/**
 * One-time migration: legacy tier strings on rides, drivers, fleet, coupons + settings vehicleServices.
 * Run: node scripts/migrate-all-vehicle-tier-fields.js
 */
require('dotenv').config()
const mongoose = require('mongoose')
const Settings = require('../Models/Admin/settings.modal')
const Ride = require('../Models/Driver/ride.model')
const Driver = require('../Models/Driver/driver.model')
const FleetVehicle = require('../Models/Vendor/fleetVehicle.model')
const Coupon = require('../Models/Admin/coupon.modal')
const { mapServiceToVehicleService } = require('../utils/ride_booking_functions')
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

const LEGACY_VEHICLE_TYPE_STRINGS = [
  'cercaSmall',
  'cercaMedium',
  'cercaLarge',
  'hatchback',
  'sedan',
  'suv',
  'small',
  'medium',
  'large',
  'zip',
  'glide',
  'titan'
]

function canonicalFrom (raw) {
  if (raw == null || raw === '') return null
  const s = String(raw).trim()
  if (!s) return null
  if (s === 'auto') return 'auto'
  try {
    return mapServiceToVehicleService(s)
  } catch {
    return null
  }
}

async function migrateSettingsVehicleServices () {
  const doc = await Settings.findOne()
  if (!doc) {
    console.log('No settings document.')
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
  await Settings.updateOne({ _id: doc._id }, { $set: { vehicleServices: out } })
  console.log('Settings.vehicleServices migrated.')
}

async function migrateRides () {
  const cursor = Ride.find({
    $or: [
      { vehicleType: { $in: LEGACY_VEHICLE_TYPE_STRINGS } },
      { vehicleService: { $in: LEGACY_VEHICLE_TYPE_STRINGS } }
    ]
  }).cursor()

  let n = 0
  for await (const ride of cursor) {
    const patch = {}
    if (ride.vehicleType && ride.vehicleType !== 'auto') {
      const c = canonicalFrom(ride.vehicleType)
      if (c && c !== ride.vehicleType) patch.vehicleType = c
    }
    if (ride.vehicleService) {
      const c = canonicalFrom(ride.vehicleService)
      if (c && c !== ride.vehicleService) patch.vehicleService = c
    }
    if (ride.service) {
      const c = canonicalFrom(ride.service)
      if (c && c !== ride.service) patch.service = c
    }
    if (Object.keys(patch).length) {
      await Ride.updateOne({ _id: ride._id }, { $set: patch })
      n++
    }
  }
  console.log('Rides patched (documents):', n)
}

async function migrateDrivers () {
  const drivers = await Driver.find({
    $or: [
      { 'vehicleInfo.vehicleType': { $in: LEGACY_VEHICLE_TYPE_STRINGS } },
      { 'vehicles.vehicleType': { $in: LEGACY_VEHICLE_TYPE_STRINGS } }
    ]
  }).lean()

  let count = 0
  for (const d of drivers) {
    const patch = {}
    if (d.vehicleInfo && d.vehicleInfo.vehicleType) {
      const c = canonicalFrom(d.vehicleInfo.vehicleType)
      if (c && c !== d.vehicleInfo.vehicleType) {
        patch['vehicleInfo.vehicleType'] = c
      }
    }
    if (Array.isArray(d.vehicles)) {
      const vehicles = d.vehicles.map((v) => {
        if (!v || !v.vehicleType) return v
        const c = canonicalFrom(v.vehicleType)
        if (c && c !== v.vehicleType) {
          return { ...v, vehicleType: c }
        }
        return v
      })
      const changed = JSON.stringify(vehicles) !== JSON.stringify(d.vehicles)
      if (changed) patch.vehicles = vehicles
    }
    if (Object.keys(patch).length) {
      await Driver.updateOne({ _id: d._id }, { $set: patch })
      count++
    }
  }
  console.log('Drivers patched:', count)
}

async function migrateFleet () {
  const res = await FleetVehicle.updateMany(
    { vehicleType: { $in: LEGACY_VEHICLE_TYPE_STRINGS } },
    [
      {
        $set: {
          vehicleType: {
            $switch: {
              branches: [
                { case: { $in: ['$vehicleType', ['cercaSmall', 'hatchback', 'small', 'zip']] }, then: 'cercaZip' },
                { case: { $in: ['$vehicleType', ['cercaMedium', 'sedan', 'medium', 'glide']] }, then: 'cercaGlide' },
                { case: { $in: ['$vehicleType', ['cercaLarge', 'suv', 'large', 'titan']] }, then: 'cercaTitan' }
              ],
              default: '$vehicleType'
            }
          }
        }
      }
    ]
  )
  console.log('Fleet vehicles matched:', res.matchedCount, 'modified:', res.modifiedCount)
}

async function migrateCoupons () {
  const coupons = await Coupon.find({ applicableServices: { $exists: true, $ne: [] } })
  let n = 0
  for (const c of coupons) {
    const arr = c.applicableServices || []
    const next = arr.map(s => canonicalFrom(s) || s)
    const same = JSON.stringify(arr) === JSON.stringify(next)
    if (!same) {
      await Coupon.updateOne({ _id: c._id }, { $set: { applicableServices: next } })
      n++
    }
  }
  console.log('Coupons patched:', n)
}

async function run () {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) {
    console.error('Set MONGODB_URI or MONGO_URI')
    process.exit(1)
  }
  await mongoose.connect(uri)
  await migrateSettingsVehicleServices()
  await migrateRides()
  await migrateDrivers()
  try {
    await migrateFleet()
  } catch (e) {
    console.warn('Fleet migration skipped or failed:', e.message)
  }
  await migrateCoupons()
  await mongoose.disconnect()
  console.log('Done.')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
