/**
 * Migrate city-wide farePricing.distanceTiers (0-10, 11-20, 21-30, 31+ km)
 * to per-vehicle 3-slab distanceTiers (0-5, 5-10, 10+ km) on vehicleServices.
 *
 * Usage (from Test_Main_Cerca_cabs):
 *   node scripts/migrate-vehicle-distance-tiers.js
 *   node scripts/migrate-vehicle-distance-tiers.js --dry-run
 *
 * Safe to run multiple times — skips vehicles that already have distanceTiers rates set.
 */

require('dotenv').config()
const mongoose = require('mongoose')
const Settings = require('../Models/Admin/settings.modal')
const {
  VEHICLE_SERVICE_KEYS,
  perKmDefaultForKey,
} = require('../utils/vehicleServicesKeys')
const {
  migrateLegacyCityTiersToVehicle,
  seedVehicleDistanceTiers,
} = require('../utils/farePricingEngine')

const DRY_RUN = process.argv.includes('--dry-run')

const hasVehicleDistanceTiers = (service) => {
  const dt = service?.distanceTiers
  if (!dt) return false
  return (
    dt.tier1?.ratePerKm != null ||
    dt.tier2?.ratePerKm != null ||
    dt.beyondTier2RatePerKm != null
  )
}

async function migrate() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) {
    console.error('Set MONGODB_URI or MONGO_URI')
    process.exit(1)
  }

  await mongoose.connect(uri)
  console.log(DRY_RUN ? '[DRY RUN] Connected to MongoDB' : 'Connected to MongoDB')

  const settings = await Settings.findOne()
  if (!settings) {
    console.log('No Settings document found — nothing to migrate')
    await mongoose.disconnect()
    return
  }

  const pc = settings.pricingConfigurations || {}
  const perKmRate = Number(pc.perKmRate) || 12
  const legacyTiers = pc.farePricing?.distanceTiers
  const intercityRates = settings.intercityPricingConfigurations?.perKmRates || {}

  let changed = false
  const log = []

  for (const serviceKey of VEHICLE_SERVICE_KEYS) {
    const existing = settings.vehicleServices?.[serviceKey] || {}
    if (hasVehicleDistanceTiers(existing)) {
      log.push(`  ${serviceKey}: already has distanceTiers — skipped`)
      continue
    }

    const vehiclePerKm = Number(intercityRates[serviceKey]) || perKmDefaultForKey(serviceKey)
    let newTiers
    if (legacyTiers && (legacyTiers.tier1 || legacyTiers.tier2 || legacyTiers.tier3)) {
      newTiers = migrateLegacyCityTiersToVehicle(legacyTiers, perKmRate, vehiclePerKm)
      log.push(
        `  ${serviceKey}: migrated from legacy city tiers → 0-5=${newTiers.tier1.ratePerKm}, 5-10=${newTiers.tier2.ratePerKm}, 10+=${newTiers.beyondTier2RatePerKm}`
      )
    } else {
      newTiers = seedVehicleDistanceTiers(perKmRate, serviceKey, {})
      log.push(
        `  ${serviceKey}: seeded defaults → 0-5=${newTiers.tier1.ratePerKm}, 5-10=${newTiers.tier2.ratePerKm}, 10+=${newTiers.beyondTier2RatePerKm}`
      )
    }

    if (!settings.vehicleServices) settings.vehicleServices = {}
    if (!settings.vehicleServices[serviceKey]) settings.vehicleServices[serviceKey] = {}
    settings.vehicleServices[serviceKey].distanceTiers = newTiers
    changed = true
  }

  if (pc.farePricing?.distanceTiers) {
    if (pc.farePricing.distanceTiers.tier3) {
      pc.farePricing.distanceTiers.tier3 = undefined
    }
    if (pc.farePricing.distanceTiers.beyondTier3RatePerKm != null) {
      pc.farePricing.distanceTiers.beyondTier3RatePerKm = undefined
    }
    delete pc.farePricing.distanceTiers.tier3
    delete pc.farePricing.distanceTiers.beyondTier3RatePerKm
    if (
      !pc.farePricing.distanceTiers.tier1 &&
      !pc.farePricing.distanceTiers.tier2
    ) {
      delete pc.farePricing.distanceTiers
    }
    settings.markModified('pricingConfigurations.farePricing')
    log.push('  Removed legacy city farePricing.distanceTiers (tier3 / beyond 30)')
    changed = true
  }

  console.log('Migration summary:')
  log.forEach((line) => console.log(line))

  if (!changed) {
    console.log('No changes needed')
  } else if (DRY_RUN) {
    console.log('[DRY RUN] Would save Settings — no write performed')
  } else {
    settings.markModified('vehicleServices')
    await settings.save()
    console.log('Settings saved successfully')
  }

  await mongoose.disconnect()
}

migrate().catch((err) => {
  console.error(err)
  process.exit(1)
})
