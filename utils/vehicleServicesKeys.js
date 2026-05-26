/**
 * Canonical vehicle tier keys (Zip / Glide / Titan).
 * Legacy persisted keys cercaSmall|cercaMedium|cercaLarge are remapped for reads/writes.
 *
 * priceDefaultForKey / perMinuteDefaultForKey: bootstrap fallbacks when merging
 * incomplete payloads only — live fare calculations must use Mongo `Settings.vehicleServices`.
 */

const VEHICLE_SERVICE_KEYS = ['cercaZip', 'cercaGlide', 'cercaTitan']

const LEGACY_VEHICLE_SERVICE_KEY_MAP = {
  cercaSmall: 'cercaZip',
  cercaMedium: 'cercaGlide',
  cercaLarge: 'cercaTitan'
}

function perMinuteDefaultForKey (serviceKey) {
  if (serviceKey === 'cercaZip') return 2
  if (serviceKey === 'cercaGlide') return 3
  return 4
}

function priceDefaultForKey (serviceKey) {
  if (serviceKey === 'cercaZip') return 299
  if (serviceKey === 'cercaGlide') return 499
  return 699
}

/** Default per-km rate for vehicle distance tiers (matches intercity perKmRates). */
function perKmDefaultForKey (serviceKey) {
  if (serviceKey === 'cercaZip') return 10
  if (serviceKey === 'cercaGlide') return 12
  return 16
}

/**
 * Remap legacy vehicleServices keys to canonical keys (mutates shallow copy).
 */
function remapVehicleServicesInput (vehicleServices) {
  if (!vehicleServices || typeof vehicleServices !== 'object') {
    return vehicleServices
  }
  const out = { ...vehicleServices }
  for (const [legacyKey, canonicalKey] of Object.entries(
    LEGACY_VEHICLE_SERVICE_KEY_MAP
  )) {
    if (out[legacyKey] != null) {
      out[canonicalKey] = { ...(out[canonicalKey] || {}), ...out[legacyKey] }
      delete out[legacyKey]
    }
  }
  return out
}

/**
 * Normalize stored vehicleServices for API / pricing (read path).
 */
function normalizeVehicleServicesForResponse (vs) {
  if (!vs || typeof vs !== 'object') return {}
  return remapVehicleServicesInput({ ...vs })
}

const CANONICAL_TIER_DISPLAY_NAME = {
  cercaZip: 'Cerca Zip',
  cercaGlide: 'Cerca Glide',
  cercaTitan: 'Cerca Titan'
}

function isLegacyZipDisplayName (n, compact) {
  return (
    n === 'small' ||
    n === 'cerca small' ||
    compact === 'cercasmall' ||
    n === 'hatchback' ||
    n === 'auto'
  )
}

function isLegacyGlideDisplayName (n, compact) {
  return n === 'medium' || n === 'cerca medium' || compact === 'cercamedium' || n === 'sedan'
}

function isLegacyTitanDisplayName (n, compact) {
  return n === 'large' || n === 'cerca large' || compact === 'cercalarge' || n === 'suv'
}

/**
 * Remap legacy Small/Medium/Large (and related) display names to Cerca Zip / Glide / Titan.
 * @param {Record<string, any>|null|undefined} vs
 * @returns {Record<string, any>}
 */
function normalizeVehicleServiceDisplayNames (vs) {
  if (!vs || typeof vs !== 'object') return vs
  const out = { ...vs }
  for (const key of VEHICLE_SERVICE_KEYS) {
    const svc = out[key]
    if (!svc || typeof svc !== 'object') continue
    const merged = { ...svc }
    const raw = String(merged.name ?? '').trim()
    const n = raw.toLowerCase().replace(/\s+/g, ' ')
    const compact = n.replace(/\s/g, '')
    if (key === 'cercaZip' && isLegacyZipDisplayName(n, compact)) {
      merged.name = CANONICAL_TIER_DISPLAY_NAME.cercaZip
    } else if (key === 'cercaGlide' && isLegacyGlideDisplayName(n, compact)) {
      merged.name = CANONICAL_TIER_DISPLAY_NAME.cercaGlide
    } else if (key === 'cercaTitan' && isLegacyTitanDisplayName(n, compact)) {
      merged.name = CANONICAL_TIER_DISPLAY_NAME.cercaTitan
    }
    out[key] = merged
  }
  return out
}

/**
 * Resolve tier input to a canonical key, null if absent, or false if unrecognized.
 * @param {string|null|undefined} raw
 * @returns {'cercaZip'|'cercaGlide'|'cercaTitan'|null|false}
 */
function resolveCanonicalVehicleTier (raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const n = s.toLowerCase().replace(/\s+/g, '')

  if (VEHICLE_SERVICE_KEYS.includes(n)) return n

  const legacy = {
    cercasmall: 'cercaZip',
    cercamedium: 'cercaGlide',
    cercalarge: 'cercaTitan'
  }
  if (legacy[n]) return legacy[n]

  if (n === 'small' || n === 'zip') return 'cercaZip'
  if (n === 'medium' || n === 'glide') return 'cercaGlide'
  if (n === 'large' || n === 'titan') return 'cercaTitan'

  if (n === 'sedan') return 'cercaGlide'
  if (n === 'suv') return 'cercaTitan'
  if (n === 'hatchback' || n === 'auto') return 'cercaZip'

  if (n.includes('glide') || n.includes('medium')) return 'cercaGlide'
  if (n.includes('titan') || n.includes('large')) return 'cercaTitan'
  if (n.includes('zip') || n.includes('small')) return 'cercaZip'

  return false
}

module.exports = {
  VEHICLE_SERVICE_KEYS,
  LEGACY_VEHICLE_SERVICE_KEY_MAP,
  remapVehicleServicesInput,
  normalizeVehicleServicesForResponse,
  normalizeVehicleServiceDisplayNames,
  perMinuteDefaultForKey,
  priceDefaultForKey,
  perKmDefaultForKey,
  resolveCanonicalVehicleTier
}
