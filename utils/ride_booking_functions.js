const Driver = require('../Models/Driver/driver.model')
const Ride = require('../Models/Driver/ride.model')
const User = require('../Models/User/user.model')
const Rating = require('../Models/Driver/rating.model')
const Message = require('../Models/Driver/message.model')
const Notification = require('../Models/User/notification.model')
const Emergency = require('../Models/User/emergency.model')
const {
  startDriverOnlineSession,
  stopDriverOnlineSession
} = require('./driverSession.service')
const { isGoToRideEligible } = require('./goToRoute.service')
const { persistDriverLocationWithGoTo } = require('./driverLocationPersistence')
const WalletTransaction = require('../Models/User/walletTransaction.model')
const AdminEarnings = require('../Models/Admin/adminEarnings.model')
const FleetVehicle = require('../Models/Vendor/fleetVehicle.model')
const Vendor = require('../Models/vendor/vendor.models')
const logger = require('./logger')
const { redis } = require('../config/redis')
const razorpay = require('razorpay')
const {
  resolveCanonicalVehicleTier
} = require('./vehicleServicesKeys')
const {
  CANCEL_BLOCK_WITHIN_DROP_RADIUS_METERS,
  PICKUP_SHIFT_REASON_THRESHOLD_METERS,
  normalizeCancellationReasonCode,
  shouldBlockCancelWithinDropRadius
} = require('./cancellationPolicy')
const {
  resolveTravelledDistanceKmBeforeStart,
  splitBeforeStartCancelPrepaid,
  walletBalanceAfterBeforeStartCancel,
  computePlatformSplitFromGrossFare
} = require('./beforeStartCancelSettlement')

const BEFORE_START_ROUTE_POINTS_MAX = Number(
  process.env.BEFORE_START_ROUTE_POINTS_MAX || 4000
)
const BEFORE_START_DISTANCE_POLICY =
  String(process.env.BEFORE_START_DISTANCE_POLICY || 'max').toLowerCase() ===
  'polyline_first'
    ? 'polyline_first'
    : 'max'

const BEFORE_START_FIXED_PENALTY_RUPEES = 20
const IN_PROGRESS_CANCEL_DISTANCE_THRESHOLD_KM = 1
const IN_PROGRESS_DRIVER_LOC_MAX_AGE_MS = Number(
  process.env.IN_PROGRESS_DRIVER_LOC_MAX_AGE_MS || 3 * 60 * 1000
)
const IN_PROGRESS_ROUTE_POINT_MAX_AGE_MS = Number(
  process.env.IN_PROGRESS_ROUTE_POINT_MAX_AGE_MS || 10 * 60 * 1000
)
const ENABLE_BEFORE_START_PARTIAL_CHARGE =
  String(process.env.FEATURE_BEFORE_START_PARTIAL_CHARGE || 'true').toLowerCase() !==
  'false'
const ENABLE_IN_PROGRESS_THRESHOLD_CANCEL =
  String(process.env.FEATURE_IN_PROGRESS_THRESHOLD_CANCEL || 'true').toLowerCase() !==
  'false'

// Initialize Razorpay instance
// Live keys (default fallback)
const razorpayInstance = new razorpay({
  key_id: process.env.RAZORPAY_ID || "rzp_live_S6q5OGF0WYChTn",
  key_secret: process.env.RAZORPAY_SECRET || "EZv5VecWiWi0FLyffYLDTM3H"
})
// Test keys (commented out for production)
// key_id: process.env.RAZORPAY_ID || "rzp_test_Rp3ejYlVfY449V",
// key_secret: process.env.RAZORPAY_SECRET || "FORM4hrZrQO8JFIiYsQSC83N"

// ============================
// REDIS CLEANUP UTILITIES (Multi-Instance Safe)
// ============================

/**
 * Clear all Redis keys related to a specific ride
 * Safe to call multiple times (idempotent)
 * Works across all instances (shared ElastiCache)
 * @param {string} rideId - Ride ID to clean up
 * @returns {Promise<Object>} Cleanup result
 */
const clearRideRedisKeys = async (rideId) => {
  if (!rideId) {
    logger.warn('clearRideRedisKeys: rideId is required')
    return { cleared: false, error: 'rideId is required' }
  }

  try {
    const keysToDelete = [
      `{ride-booking}:lock:${rideId}`, // Worker lock
      `ride_lock:${rideId}`, // Socket lock for driver acceptance
    ]

    // Delete all keys (DEL is idempotent - safe to call multiple times)
    const deletePromises = keysToDelete.map(key => redis.del(key))
    const results = await Promise.allSettled(deletePromises)

    let deletedCount = 0
    const errors = []

    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value > 0) {
        deletedCount++
        logger.info(`✅ Cleared Redis key: ${keysToDelete[index]}`)
      } else if (result.status === 'rejected') {
        errors.push(`${keysToDelete[index]}: ${result.reason?.message || result.reason}`)
        logger.warn(`⚠️ Failed to clear Redis key ${keysToDelete[index]}: ${result.reason?.message || result.reason}`)
      }
    })

    if (deletedCount > 0 || errors.length > 0) {
      logger.info(`🧹 Redis cleanup for ride ${rideId}: ${deletedCount} keys cleared, ${errors.length} errors`)
    }

    return {
      cleared: true,
      rideId,
      deletedCount,
      errors: errors.length > 0 ? errors : undefined
    }
  } catch (error) {
    logger.error(`❌ Error clearing Redis keys for ride ${rideId}:`, error)
    return {
      cleared: false,
      rideId,
      error: error.message
    }
  }
}

/**
 * Check for stale Redis locks (lock exists but ride doesn't in MongoDB)
 * Cleans up stale locks automatically
 * Multi-instance safe - all instances see same Redis state
 * @param {string} riderId - Rider ID to check
 * @returns {Promise<Object>} Cleanup result
 */
const checkAndCleanStaleRideLocks = async (riderId) => {
  if (!riderId) {
    return { cleaned: false, error: 'riderId is required' }
  }

  try {
    // Check MongoDB for active rides
    const activeRides = await Ride.find({
      rider: riderId,
      status: { $in: ['requested', 'accepted', 'arrived', 'in_progress'] }
    }).select('_id').lean()

    const activeRideIds = activeRides.map(ride => ride._id.toString())

    // If MongoDB has no active rides, check for common Redis lock patterns
    // Note: We can't easily scan all Redis keys, so we check known patterns
    if (activeRideIds.length === 0) {
      // No active rides in MongoDB - check if any Redis locks exist
      // Since we can't scan Redis easily, we'll rely on TTL expiration
      // But we can check for locks that might have been created recently
      logger.debug(`✅ No active rides found for rider ${riderId} in MongoDB - Redis locks should expire via TTL`)
      
      // Return success - locks will expire via TTL (15s for ride_lock, 30s for worker lock)
      return {
        cleaned: true,
        reason: 'No active rides found in MongoDB, Redis locks will expire via TTL',
        activeRideIds: []
      }
    }

    // If we have active rides, verify their locks exist (optional validation)
    // For now, just return the active rides - locks should exist for these
    return {
      cleaned: false,
      reason: 'Active rides found, locks should exist',
      activeRideIds
    }
  } catch (error) {
    logger.error(`❌ Error checking stale locks for rider ${riderId}:`, error)
    return {
      cleaned: false,
      error: error.message
    }
  }
}

/**
 * Clear Redis lock for a specific ride (used before checking for active rides)
 * Safe to call even if lock doesn't exist
 * @param {string} rideId - Ride ID
 * @returns {Promise<boolean>} True if lock was cleared or didn't exist
 */
const clearRideLock = async (rideId) => {
  if (!rideId) return false

  try {
    const lockKey = `ride_lock:${rideId}`
    const result = await redis.del(lockKey)
    if (result > 0) {
      logger.info(`✅ Cleared ride lock: ${lockKey}`)
    }
    return true
  } catch (error) {
    logger.warn(`⚠️ Failed to clear ride lock ${rideId}:`, error.message)
    return false
  }
}

/**
 * Clear worker lock for a specific ride
 * Safe to call even if lock doesn't exist
 * @param {string} rideId - Ride ID
 * @returns {Promise<boolean>} True if lock was cleared or didn't exist
 */
const clearWorkerLock = async (rideId) => {
  if (!rideId) return false

  try {
    const lockKey = `{ride-booking}:lock:${rideId}`
    const result = await redis.del(lockKey)
    if (result > 0) {
      logger.info(`✅ Cleared worker lock: ${lockKey}`)
    }
    return true
  } catch (error) {
    logger.warn(`⚠️ Failed to clear worker lock ${rideId}:`, error.message)
    return false
  }
}


//Helper Function
function toLngLat (input) {
  if (!input) throw new Error('Location required')

  // Case A: GeoJSON { type:'Point', coordinates:[lng,lat] }
  if (Array.isArray(input.coordinates) && input.coordinates.length === 2) {
    const [lng, lat] = input.coordinates
    if (typeof lng === 'number' && typeof lat === 'number') return [lng, lat]
  }

  // Case B: plain { longitude, latitude }
  if (
    typeof input.longitude === 'number' &&
    typeof input.latitude === 'number'
  ) {
    return [input.longitude, input.latitude]
  }

  throw new Error(
    'Invalid location (need {longitude,latitude} or GeoJSON Point)'
  )
}

const updateDriverStatus = async (driverId, status, socketId) => {
  try {
    const driver = await Driver.findByIdAndUpdate(
      driverId,
      { isActive: status, socketId: socketId },
      { new: true }
    )
    if (!driver) {
      throw new Error('Driver not found')
    }
    return driver
  } catch (error) {
    throw new Error(`Error updating driver status: ${error.message}`)
  }
}

const updateDriverLocation = async (driverId, location) => {
  try {
    // Extract coordinates - handle both formats
    let longitude, latitude

    if (location.coordinates && Array.isArray(location.coordinates)) {
      ;[longitude, latitude] = location.coordinates
    } else if (
      location.longitude !== undefined &&
      location.latitude !== undefined
    ) {
      longitude = location.longitude
      latitude = location.latitude
    } else {
      throw new Error(
        'Invalid location format. Provide either coordinates array or longitude/latitude'
      )
    }

    // Validate coordinates are valid numbers
    longitude = parseFloat(longitude)
    latitude = parseFloat(latitude)

    if (isNaN(longitude) || isNaN(latitude)) {
      throw new Error(
        'Invalid coordinates. Longitude and latitude must be valid numbers'
      )
    }

    // Validate range
    if (
      longitude < -180 ||
      longitude > 180 ||
      latitude < -90 ||
      latitude > 90
    ) {
      throw new Error(
        'Coordinates out of range. Longitude: -180 to 180, Latitude: -90 to 90'
      )
    }

    logger.info(
      `📍 Updating driver location - driverId: ${driverId}, coordinates: [${longitude}, ${latitude}]`
    )

    const { driver, goToRouteRefreshed } = await persistDriverLocationWithGoTo(
      driverId,
      longitude,
      latitude
    )

    logger.info(
      `✅ Driver location updated successfully - driverId: ${driverId}, saved location: [${driver.location.coordinates[0]}, ${driver.location.coordinates[1]}], goToRouteRefreshed: ${goToRouteRefreshed}`
    )

    return driver
  } catch (error) {
    logger.error(
      `❌ Error updating driver location - driverId: ${driverId}, error: ${error.message}`
    )
    throw new Error(`Error updating driver location: ${error.message}`)
  }
}

const searchNearbyDrivers = async (userId, location) => {
  try {
    const drivers = await Driver.find({
      location: {
        $geoWithin: {
          $centerSphere: [[location.longitude, location.latitude], 10 / 3963.1] // 10 miles radius
        }
      },
      isActive: true
    })
    return drivers
  } catch (error) {
    throw new Error(`Error searching nearby drivers: ${error.message}`)
  }
}

/**
 * Map service name to vehicleService key
 * @param {string} serviceName - Service name (e.g., "cercaGlide", "cercaTitan", "auto", "Cerca Zip", etc.)
 * @returns {string} - Vehicle service key ("cercaZip", "cercaGlide", "cercaTitan")
 */
/**
 * Map service name from user app to vehicle service key
 * Mapping: Cerca Glide → cercaGlide, Cerca Titan → cercaTitan, Cerca Zip → cercaZip
 * @param {string} serviceName - Service name from user app ('cercaGlide', 'cercaTitan', 'auto', 'cercaZip')
 * @returns {string} - Vehicle service key ('cercaZip', 'cercaGlide', 'cercaTitan')
 */
const mapServiceToVehicleService = (serviceName) => {
  const normalized = serviceName.toLowerCase()
  // Map service names to vehicle services
  // Cerca Glide → cercaGlide
  if (normalized === 'cercaGlide' || normalized === 'sedan' || normalized.includes('glide') || normalized.includes('medium')) {
    return 'cercaGlide'
  }
  // Cerca Titan → cercaTitan
  else if (normalized === 'cercaTitan' || normalized === 'suv' || normalized.includes('titan') || normalized.includes('large')) {
    return 'cercaTitan'
  }
  // Cerca Zip → cercaZip (also auto for legacy support)
  else if (normalized === 'cercaZip' || normalized === 'hatchback' || normalized === 'auto' || normalized.includes('zip') || normalized.includes('small')) {
    return 'cercaZip'
  }
  // Default to zip if unknown
  return 'cercaZip'
}

/**
 * Map vehicle service key to driver vehicle type
 * Used for filtering drivers by vehicle type
 * @param {string} vehicleServiceKey - Vehicle service key ('cercaZip', 'cercaGlide', 'cercaTitan')
 * @returns {string} - Driver vehicle type ('cercaZip', 'cercaGlide', 'cercaTitan')
 */
const mapVehicleServiceToDriverType = (vehicleServiceKey) => {
  const normalized = vehicleServiceKey.toLowerCase()
  if (normalized === 'cercazip') {
    return 'cercaZip'
  } else if (normalized === 'cercaglide') {
    return 'cercaGlide'
  } else if (normalized === 'cercatitan') {
    return 'cercaTitan'
  }
  // Default fallback
  return 'cercaZip'
}

/**
 * Map service name to driver vehicle type
 * Used for filtering drivers during ride matching
 * @param {string} serviceName - Service name from user app ('cercaGlide', 'cercaTitan', 'auto', 'cercaZip')
 * @returns {string} - Driver vehicle type ('cercaZip', 'cercaGlide', 'cercaTitan')
 */
const mapServiceToDriverType = (serviceName) => {
  const vehicleServiceKey = mapServiceToVehicleService(serviceName)
  return mapVehicleServiceToDriverType(vehicleServiceKey)
}

const DRIVER_RIDE_TYPE_ORDER = ['cercaZip', 'cercaGlide', 'cercaTitan']

const normalizeRideAccessPreferences = (rideAccess, vehicleType) => {
  const defaults = getRideAccessDefaultsForVehicleType(vehicleType)
  const availableToggles = defaults.availableToggles || []
  const normalized = String(vehicleType || '').trim()

  const allowZip = availableToggles.includes('allowZip')
    ? Boolean(rideAccess?.allowZip)
    : defaults.allowZip
  const allowGlide = availableToggles.includes('allowGlide')
    ? Boolean(rideAccess?.allowGlide)
    : defaults.allowGlide

  // Glide must keep at least one feed enabled. If both are false, default back
  // to receiving Glide rides so dispatch never becomes empty unexpectedly.
  if (normalized === 'cercaGlide' && !allowZip && !allowGlide) {
    return {
      allowZip: false,
      allowGlide: true
    }
  }

  return {
    allowZip,
    allowGlide
  }
}

const getRideAccessDefaultsForVehicleType = (vehicleType) => {
  const normalized = String(vehicleType || '').trim()

  if (normalized === 'cercaGlide') {
    return {
      allowZip: false,
      allowGlide: true,
      availableToggles: ['allowGlide', 'allowZip']
    }
  }

  if (normalized === 'cercaTitan') {
    return {
      allowZip: true,
      allowGlide: true,
      availableToggles: ['allowGlide', 'allowZip']
    }
  }

  return {
    allowZip: false,
    allowGlide: false,
    availableToggles: []
  }
}

const resolveDriverVehicleType = async (driver) => {
  const directVehicleType = String(driver?.vehicleInfo?.vehicleType || '').trim()
  if (DRIVER_RIDE_TYPE_ORDER.includes(directVehicleType)) {
    return directVehicleType
  }

  if (Array.isArray(driver?.vehicles) && driver.vehicles.length > 0) {
    const approvedVehicles = driver.vehicles.filter(
      vehicle => vehicle?.approvalStatus === 'APPROVED'
    )
    const activeVehicle =
      approvedVehicles.find(vehicle => vehicle?.isActive) || approvedVehicles[0]

    const activeVehicleType = String(activeVehicle?.vehicleType || '').trim()
    if (DRIVER_RIDE_TYPE_ORDER.includes(activeVehicleType)) {
      return activeVehicleType
    }
  }

  const assignedFleetVehicleId = driver?.assignedFleetVehicleId
  if (assignedFleetVehicleId) {
    const fleetVehicle = await FleetVehicle.findById(assignedFleetVehicleId)
      .select('vehicleType')
      .lean()

    const fleetVehicleType = String(fleetVehicle?.vehicleType || '').trim()
    if (DRIVER_RIDE_TYPE_ORDER.includes(fleetVehicleType)) {
      return fleetVehicleType
    }
  }

  return null
}

const getDriverRideAccessProfile = async (driver) => {
  const vehicleType = await resolveDriverVehicleType(driver)
  const preferences = normalizeRideAccessPreferences(driver?.rideAccess, vehicleType)
  const defaults = getRideAccessDefaultsForVehicleType(vehicleType)

  const allowedRideTypes = []
  if (vehicleType === 'cercaZip') {
    allowedRideTypes.push('cercaZip')
  }

  if (vehicleType === 'cercaGlide') {
    if (preferences.allowGlide) {
      allowedRideTypes.push('cercaGlide')
    }
    if (preferences.allowZip) {
      allowedRideTypes.push('cercaZip')
    }
  }

  if (vehicleType === 'cercaTitan') {
    allowedRideTypes.push('cercaTitan')
    if (preferences.allowGlide) {
      allowedRideTypes.push('cercaGlide')
    }
    if (preferences.allowZip) {
      allowedRideTypes.push('cercaZip')
    }
  }

  return {
    vehicleType,
    preferences,
    availableToggles: defaults.availableToggles,
    allowedRideTypes,
    rideAccess: {
      allowZip: preferences.allowZip,
      allowGlide: preferences.allowGlide
    }
  }
}

const driverCanAcceptRideType = async (driver, requestedVehicleType) => {
  const tier = resolveCanonicalVehicleTier(requestedVehicleType)
  if (tier === null) {
    return true
  }
  if (tier === false) {
    return false
  }

  const profile = await getDriverRideAccessProfile(driver)
  return profile.allowedRideTypes.includes(tier)
}

/**
 * Calculate fare with time component
 * @param {number} basePrice - Base price from service
 * @param {number} distance - Distance in km
 * @param {number} duration - Duration in minutes
 * @param {number} perKmRate - Per km rate from settings
 * @param {number} perMinuteRate - Per minute rate for vehicle type
 * @param {number} minimumFare - Minimum fare from settings
 * @returns {Object} - Fare breakdown
 */
const calculateFareWithTime = (basePrice, distance, duration, perKmRate, perMinuteRate, minimumFare) => {
  const baseFare = basePrice
  const distanceFare = distance * perKmRate
  const timeFare = (duration || 0) * (perMinuteRate || 0)
  const subtotal = baseFare + distanceFare + timeFare
  const fareAfterMinimum = Math.max(subtotal, minimumFare)
  
  return {
    baseFare: Math.round(baseFare * 100) / 100,
    distanceFare: Math.round(distanceFare * 100) / 100,
    timeFare: Math.round(timeFare * 100) / 100,
    subtotal: Math.round(subtotal * 100) / 100,
    fareAfterMinimum: Math.round(fareAfterMinimum * 100) / 100
  }
}

const DEFAULT_SUBSTANTIVE_MIN_DURATION_MIN = 2
const DEFAULT_SUBSTANTIVE_MIN_DISTANCE_KM = 0.3
const DEFAULT_SUBSTANTIVE_ESTIMATE_DISTANCE_FRACTION = 0.05

/**
 * Resolved substantive-trip thresholds from admin pricing (with safe defaults).
 * @param {object} [pricingConfigurations]
 */
const getPricingSubstantiveThresholds = (pricingConfigurations = {}) => {
  const pc = pricingConfigurations || {}
  const minDuration = Number.isFinite(Number(pc.substantiveTripMinDurationMinutes))
    ? Math.max(0, Number(pc.substantiveTripMinDurationMinutes))
    : DEFAULT_SUBSTANTIVE_MIN_DURATION_MIN
  const minKm = Number.isFinite(Number(pc.substantiveTripMinDistanceKm))
    ? Math.max(0, Number(pc.substantiveTripMinDistanceKm))
    : DEFAULT_SUBSTANTIVE_MIN_DISTANCE_KM
  const estFrac = Number.isFinite(Number(pc.substantiveTripEstimateDistanceFraction))
    ? Math.max(0, Number(pc.substantiveTripEstimateDistanceFraction))
    : DEFAULT_SUBSTANTIVE_ESTIMATE_DISTANCE_FRACTION
  return { minDuration, minKm, estFrac }
}

/**
 * Whether an INSTANT ride consumed enough actual time and distance to apply fareAtBooking as a floor.
 * No actual start (0 duration) or tiny distance → false (bill on actuals + minimumFare).
 */
const evaluateSubstantiveInstantTrip = ({
  thresholds,
  actualDurationMinutes,
  actualDistanceKm,
  estimatedDistanceKm
}) => {
  const { minDuration, minKm, estFrac } = thresholds
  const estimated = Math.max(0, Number(estimatedDistanceKm) || 0)
  const minDistanceKmRequired = Math.max(minKm, estimated * estFrac)
  const dur = Number(actualDurationMinutes) || 0
  const dist = Number(actualDistanceKm) || 0
  const durationOk = dur >= minDuration
  const distanceOk = dist >= minDistanceKmRequired
  return {
    substantiveTrip: durationOk && distanceOk,
    minDistanceKmRequired,
    durationOk,
    distanceOk
  }
}

const createRide = async rideData => {
  const riderId = rideData.riderId || rideData.rider
  if (!riderId) throw new Error('riderId (or rider) is required')

  // ============================
  // DISTRIBUTED LOCK (Optional - Prevents Race Conditions)
  // ============================
  // Use Redis lock to prevent multiple instances from creating duplicate rides
  // Can be disabled by setting ENABLE_DISTRIBUTED_LOCK=false
  const enableDistributedLock = process.env.ENABLE_DISTRIBUTED_LOCK !== 'false'
  const lockKey = `ride_creation_lock:${riderId}`
  let lockAcquired = false

  if (enableDistributedLock) {
    try {
      lockAcquired = await redis.set(lockKey, '1', 'NX', 'EX', 5) // 5 second lock
      if (!lockAcquired) {
        logger.warn(`🚫 Ride creation lock already held for rider ${riderId}, another instance is processing`)
        throw new Error('Another ride request is being processed. Please wait a moment and try again.')
      }
    } catch (lockError) {
      // If Redis is unavailable, fall back to MongoDB-only check (backward compatible)
      if (lockError.message.includes('Another ride request')) {
        throw lockError
      }
      logger.warn(`⚠️ Failed to acquire distributed lock for rider ${riderId}: ${lockError.message}, falling back to MongoDB-only check`)
    }
  }

  try {
    // ============================
    // STALE DATA CLEANUP (Multi-Instance Safe)
    // ============================
    // Check and clean up any stale Redis locks before checking MongoDB
    try {
      await checkAndCleanStaleRideLocks(riderId)
    } catch (cleanupError) {
      // Don't fail ride creation if cleanup check fails - log for monitoring
      logger.warn(`⚠️ Stale lock check failed for rider ${riderId}: ${cleanupError.message}`)
    }

    // Check for existing active ride to prevent duplicates
    const existingActiveRide = await Ride.findOne({
      rider: riderId,
      status: { $in: ['requested', 'accepted', 'in_progress'] }
    })

    if (existingActiveRide) {
      logger.warn(
        `Duplicate ride attempt prevented in createRide for rider ${riderId}. Active ride: ${existingActiveRide._id}`
      )
      throw new Error(
        'You already have an active ride. Please cancel it before booking a new one.'
      )
    }

    // Validate locations
    if (!rideData.pickupLocation) {
      throw new Error('pickupLocation is required')
    }
    if (!rideData.dropoffLocation) {
      throw new Error('dropoffLocation is required')
    }

    let pickupLngLat, dropoffLngLat
    try {
      pickupLngLat = toLngLat(rideData.pickupLocation)
    } catch (locError) {
      throw new Error(
        `Invalid pickupLocation: ${
          locError.message
        }. Received: ${JSON.stringify(rideData.pickupLocation)}`
      )
    }

    try {
      dropoffLngLat = toLngLat(rideData.dropoffLocation)
    } catch (locError) {
      throw new Error(
        `Invalid dropoffLocation: ${
          locError.message
        }. Received: ${JSON.stringify(rideData.dropoffLocation)}`
      )
    }

    // Use frontend distance - frontend calculates distance accurately using Google Maps API
    let distance = rideData.distanceInKm

    // Validate frontend distance is provided
    if (!distance || distance <= 0) {
      logger.warn(
        `[Distance Validation] Frontend distance not provided or invalid: ${distance}, calculating fallback`
      )
      // Fallback: Calculate distance only if frontend didn't provide it
      distance = calculateHaversineDistance(
        pickupLngLat[1],
        pickupLngLat[0],
        dropoffLngLat[1],
        dropoffLngLat[0]
      )
      logger.info(
        `[Distance Validation] Calculated fallback distance: ${distance}km`
      )
    } else {
      // Validate distance is reasonable (not suspiciously high)
      if (distance > 1000) {
        logger.warn(
          `[Distance Validation] Frontend distance ${distance}km seems too high (>1000km), using fallback calculation`
        )
        distance = calculateHaversineDistance(
          pickupLngLat[1],
          pickupLngLat[0],
          dropoffLngLat[1],
          dropoffLngLat[0]
        )
        logger.info(
          `[Distance Validation] Recalculated distance due to suspicious value: ${distance}km`
        )
      } else {
        logger.info(
          `[Distance Validation] Using frontend distance: ${distance}km`
        )
      }
    }

    // Fetch admin settings for fare calculation
    const Settings = require('../Models/Admin/settings.modal.js')
    const settings = await Settings.findOne()

    if (!settings) {
      throw new Error('Admin settings not found. Please configure pricing.')
    }

    // INSTANT fare kernel: perKmRate + minimumFare from pricingConfigurations;
    // tier base + perMinuteRate from settings.vehicleServices[vehicleServiceKey].
    const { perKmRate, minimumFare } = settings.pricingConfigurations

    // Validate service and map to vehicleService
    const selectedService = rideData.service
    if (!selectedService) {
      const availableVehicleServices = settings.vehicleServices 
        ? Object.keys(settings.vehicleServices).join(', ')
        : 'none'
      throw new Error(
        `Service is required. Available vehicle services: ${availableVehicleServices}`
      )
    }

    // Map service name to vehicleService key (canonical tier keys)
    const vehicleServiceKey = mapServiceToVehicleService(selectedService)
    const vehicleService = settings.vehicleServices?.[vehicleServiceKey]

    if (!vehicleService) {
      const availableVehicleServices = settings.vehicleServices 
        ? Object.keys(settings.vehicleServices).join(', ')
        : 'none'
      throw new Error(
        `Invalid service: "${selectedService}". Available vehicle services: ${availableVehicleServices}`
      )
    }

    // Check if vehicle service is enabled
    if (vehicleService.enabled === false) {
      throw new Error(
        `Vehicle service "${vehicleServiceKey}" is currently disabled. Please select another vehicle type.`
      )
    }

    // Get price and perMinuteRate from vehicleService
    const servicePrice = vehicleService.price || 0
    const perMinuteRate = vehicleService.perMinuteRate || 0

    // Map to driver vehicle type for filtering
    const driverVehicleType = mapServiceToDriverType(selectedService)

    // Get estimated duration from rideData (frontend should provide this)
    const estimatedDuration = rideData.estimatedDuration || 0

    // Log service mapping for debugging
    logger.info(
      `[Service Mapping] Frontend sent service: "${selectedService}" → vehicleService: "${vehicleServiceKey}" → driverType: "${driverVehicleType}", price: ₹${servicePrice}, perMinuteRate: ₹${perMinuteRate}/min, estimatedDuration: ${estimatedDuration}min`
    )

    // Calculate fare with time component
    let fareBreakdown
    let fare
    
    if (rideData.fare && rideData.fare > 0) {
      // Frontend provided fare - validate it but trust frontend calculation
      fare = rideData.fare
      logger.info(
        `[Fare Validation] Frontend fare: ₹${fare}, vehicleService: ${vehicleServiceKey}, servicePrice: ₹${servicePrice}, frontend distance: ${distance}km, estimatedDuration: ${estimatedDuration}min, minimumFare: ₹${minimumFare}`
      )
      
      // Calculate expected fare breakdown for logging/validation
      fareBreakdown = calculateFareWithTime(
        servicePrice,
        distance,
        estimatedDuration,
        perKmRate,
        perMinuteRate,
        minimumFare
      )
      
      // Validate: fare should be >= minimumFare
      if (fare < minimumFare) {
        logger.warn(
          `[Fare Validation] Frontend fare ₹${fare} below minimum ₹${minimumFare}, using minimum`
        )
        fare = minimumFare
      }
      // If fare is suspiciously high (> 10x expected fare), recalculate
      else if (fare > fareBreakdown.fareAfterMinimum * 10) {
        logger.warn(
          `[Fare Validation] Frontend fare ₹${fare} seems suspiciously high (>10x expected ₹${fareBreakdown.fareAfterMinimum}), recalculating`
        )
        fare = fareBreakdown.fareAfterMinimum
      } else {
        logger.info(
          `[Fare Validation] Frontend fare ₹${fare} accepted (expected: ₹${fareBreakdown.fareAfterMinimum})`
        )
        // Use frontend fare but keep breakdown for reference
      }
    } else {
      // No fare provided, calculate it with time component
      fareBreakdown = calculateFareWithTime(
        servicePrice,
        distance,
        estimatedDuration,
        perKmRate,
        perMinuteRate,
        minimumFare
      )
      fare = fareBreakdown.fareAfterMinimum
      logger.info(
        `[Fare Validation] Calculated fare: ₹${fare} for ride (vehicleService: ${vehicleServiceKey}, distance: ${distance}km, duration: ${estimatedDuration}min, base: ₹${servicePrice}, perMinuteRate: ₹${perMinuteRate}/min)`
      )
    }
    
    logger.info(
      `[Fare Validation] Final fare decision: ₹${fare} for ride (vehicleService: ${vehicleServiceKey}, distance: ${distance}km, duration: ${estimatedDuration}min)`
    )

    // Apply promo code if provided
    let discount = 0
    let finalFare = fare
    if (rideData.promoCode) {
      const Coupon = require('../Models/Admin/coupon.modal.js')
      const coupon = await Coupon.findOne({
        couponCode: rideData.promoCode.toUpperCase().trim()
      })

      if (coupon) {
        // Check if user can use this coupon
        const canUse = coupon.canUserUse(riderId)
        if (canUse.canUse) {
          // Check service applicability (coupons may use service names like 'sedan', 'suv', etc.)
          const serviceApplicable =
            !coupon.applicableServices ||
            coupon.applicableServices.length === 0 ||
            coupon.applicableServices.includes(selectedService) ||
            coupon.applicableServices.includes(vehicleServiceKey)

          // Check ride type applicability
          const rideTypeApplicable =
            !coupon.applicableRideTypes ||
            coupon.applicableRideTypes.length === 0 ||
            coupon.applicableRideTypes.includes(rideData.rideType || 'normal')

          if (serviceApplicable && rideTypeApplicable) {
            // Apply promo code discount to fare after minimum check
            const discountResult = coupon.calculateDiscount(fare)
            if (discountResult.discount > 0) {
              discount = discountResult.discount
              finalFare = discountResult.finalFare

              // Record coupon usage (will be saved after ride is created)
              rideData._couponToApply = {
                coupon,
                discount,
                originalFare: fare
              }
            }
          }
        }
      }
    }

    // ===============================
    // BOOKING TYPE LOGIC (CREATE RIDE)
    // ===============================
    const bookingType = rideData.bookingType || 'INSTANT'
    const bookingMeta = rideData.bookingMeta || {}

    if (bookingType === 'FULL_DAY') {
      if (!bookingMeta.startTime || !bookingMeta.endTime) {
        throw new Error('FULL_DAY booking requires startTime and endTime')
      }

      rideData.bookingType = 'FULL_DAY'
      rideData.bookingMeta = {
        startTime: new Date(bookingMeta.startTime),
        endTime: new Date(bookingMeta.endTime)
      }

      // optional fixed pricing
      finalFare = 1500
    }

    if (bookingType === 'RENTAL') {
      if (!bookingMeta.days || !bookingMeta.startTime) {
        throw new Error('RENTAL booking requires days and startTime')
      }

      const start = new Date(bookingMeta.startTime)
      const end = new Date(
        start.getTime() + bookingMeta.days * 24 * 60 * 60 * 1000
      )

      rideData.bookingType = 'RENTAL'
      rideData.bookingMeta = {
        days: bookingMeta.days,
        startTime: start,
        endTime: end
      }

      finalFare = bookingMeta.days * 700 // example
    }

    if (bookingType === 'DATE_WISE') {
      if (!Array.isArray(bookingMeta.dates) || bookingMeta.dates.length === 0) {
        throw new Error('DATE_WISE booking requires dates[]')
      }

      rideData.bookingType = 'DATE_WISE'
      rideData.bookingMeta = {
        dates: bookingMeta.dates.map(d => new Date(d))
      }

      finalFare = bookingMeta.dates.length * 500 // example
    }

    const rideDoc = {
      rider: riderId,
      pickupLocation: { type: 'Point', coordinates: pickupLngLat },
      dropoffLocation: { type: 'Point', coordinates: dropoffLngLat },
      fare: finalFare,
      fareAtBooking: finalFare,
      distanceInKm: Math.round(distance * 100) / 100, // Round to 2 decimal places
      estimatedDuration: estimatedDuration || null, // Store estimated duration
      rideType: rideData.rideType || 'normal',
      scheduleType: rideData.scheduleType || 'now',
      scheduledAt: rideData.scheduledAt ? new Date(rideData.scheduledAt) : null,
      bookingType: rideData.bookingType || 'INSTANT',
      bookingMeta: rideData.bookingMeta || {},
      userSocketId: rideData.userSocketId,
      status: 'requested',
      paymentMethod: rideData.paymentMethod || 'CASH',
      pickupAddress: rideData.pickupAddress,
      dropoffAddress: rideData.dropoffAddress,
      // Store vehicle type and service information
      vehicleType: driverVehicleType,
      vehicleService: vehicleServiceKey,
      service: selectedService, // Legacy field for backward compatibility
      promoCode: rideData.promoCode || null,
      discount: discount,
      // Store rideFor and passenger information
      rideFor: rideData.rideFor || 'SELF',
      passenger: rideData.passenger || null,
      // Store fare breakdown for transparency
      fareBreakdown: fareBreakdown ? {
        baseFare: fareBreakdown.baseFare,
        distanceFare: fareBreakdown.distanceFare,
        timeFare: fareBreakdown.timeFare,
        subtotal: fareBreakdown.subtotal,
        fareAfterMinimum: fareBreakdown.fareAfterMinimum,
        discount: discount,
        finalFare: finalFare
      } : null
      // startOtp & stopOtp come from schema defaults
    }

    // Add hybrid payment fields if present
    if (rideData.razorpayPaymentId) {
      rideDoc.razorpayPaymentId = rideData.razorpayPaymentId
    }
    if (rideData.walletAmountUsed !== undefined) {
      rideDoc.walletAmountUsed = rideData.walletAmountUsed
    }
    if (rideData.razorpayAmountPaid !== undefined) {
      rideDoc.razorpayAmountPaid = rideData.razorpayAmountPaid
    }

    // Generate share token for OTHER rides
    logger.info(
      `🔍 [ShareToken Check] rideData.rideFor = '${rideData.rideFor}' (type: ${typeof rideData.rideFor}), checking if === 'OTHER'`
    )
    if (rideData.rideFor === 'OTHER') {
      const crypto = require('crypto')
      const shareToken = crypto.randomBytes(32).toString('base64url')
      rideDoc.shareToken = shareToken
      // Set expiration to 24 hours from now
      rideDoc.shareTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
      logger.info(
        `✅ [ShareToken Generated] rideFor='OTHER' detected, shareToken: ${shareToken}, expires: ${rideDoc.shareTokenExpiresAt}`
      )
    } else {
      logger.info(
        `⏭️ [ShareToken Skipped] rideFor is '${rideData.rideFor}', not 'OTHER', skipping shareToken generation`
      )
    }

    // Single insert; returns the created document including generated OTPs
    const ride = await Ride.create(rideDoc)

    logger.info(
      `Ride created with rideFor: ${ride.rideFor}, passenger: ${
        ride.passenger ? ride.passenger.name : 'none'
      }, rideId: ${ride._id}`
    )

    // Log share link for OTHER rides
    if (ride.rideFor === 'OTHER' && ride.shareToken) {
      const shareLink = `https://api.cercacars.online/api/rides/shared/${ride.shareToken}`
      logger.info(
        `📤 Share link generated for ride ${ride._id} - ${shareLink} | Passenger: ${ride.passenger.name} | Phone: ${ride.passenger.phone}`
      )
    }

    // Apply coupon if provided and valid
    if (rideData._couponToApply) {
      const { coupon, discount, originalFare } = rideData._couponToApply
      try {
        await coupon.recordUsage(
          riderId,
          ride._id,
          discount,
          originalFare,
          finalFare
        )
        logger.info(
          `Coupon ${coupon.couponCode} applied to ride ${ride._id}, discount: ₹${discount}`
        )
      } catch (error) {
        logger.error(
          `Error recording coupon usage for ride ${ride._id}:`,
          error
        )
        // Don't fail ride creation if coupon recording fails
      }
    }

    return ride
  } catch (error) {
    throw new Error(`Error creating ride: ${error.message}`)
  } finally {
    // ============================
    // RELEASE DISTRIBUTED LOCK
    // ============================
    // Always release lock, even if ride creation fails
    if (enableDistributedLock && lockAcquired) {
      try {
        await redis.del(lockKey)
        logger.debug(`✅ Released ride creation lock for rider ${riderId}`)
      } catch (unlockError) {
        // Lock will expire via TTL (5s), so this is not critical
        logger.warn(`⚠️ Failed to release distributed lock for rider ${riderId}: ${unlockError.message}`)
      }
    }
  }
}

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} - Distance in kilometers
 */
const calculateHaversineDistance = (lat1, lon1, lat2, lon2) => {
  const toRadians = degrees => (degrees * Math.PI) / 180
  const R = 6371 // Earth's radius in kilometers

  const dLat = toRadians(lat2 - lat1)
  const dLon = toRadians(lon2 - lon1)

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100

const getIntercityPricingConfig = settings => {
  const config = settings?.intercityPricingConfigurations || {}
  return {
    enabled: config.enabled !== false,
    baseFare: Number(config.baseFare || settings?.pricingConfigurations?.baseFare || 0),
    perKmRates: {
      cercaZip: Number(config.perKmRates?.cercaZip ?? settings?.pricingConfigurations?.perKmRate ?? 0),
      cercaGlide: Number(config.perKmRates?.cercaGlide ?? settings?.pricingConfigurations?.perKmRate ?? 0),
      cercaTitan: Number(config.perKmRates?.cercaTitan ?? settings?.pricingConfigurations?.perKmRate ?? 0)
    },
    tollChargeDefault: Number(config.tollChargeDefault || 0),
    parkingChargeDefault: Number(config.parkingChargeDefault || 0),
    roundTripAllowance: {
      first24Hours: Number(config.roundTripAllowance?.first24Hours ?? 300),
      next24Hours: Number(config.roundTripAllowance?.next24Hours ?? 500),
      subsequent24Hours: Number(config.roundTripAllowance?.subsequent24Hours ?? 500)
    },
    dailyDistanceAllowance: {
      thresholdKm: Number(config.dailyDistanceAllowance?.thresholdKm ?? 300),
      cercaZipPerKm: Number(config.dailyDistanceAllowance?.cercaZipPerKm ?? 10),
      cercaGlidePerKm: Number(config.dailyDistanceAllowance?.cercaGlidePerKm ?? 12),
      cercaTitanPerKm: Number(config.dailyDistanceAllowance?.cercaTitanPerKm ?? 16)
    },
    matching: {
      batchSize: Number(config.matching?.batchSize ?? 5),
      batchWaitSeconds: Number(config.matching?.batchWaitSeconds ?? 45),
      scheduledMatchLeadMinutes: Number(config.matching?.scheduledMatchLeadMinutes ?? 1440),
      cronIntervalMinutes: Number(config.matching?.cronIntervalMinutes ?? 5)
    }
  }
}

const getIntercityPerKmRate = (vehicleType, settings) => {
  const config = getIntercityPricingConfig(settings)
  return Number(
    config.perKmRates?.[vehicleType] ??
      config.perKmRates?.cercaZip ??
      settings?.pricingConfigurations?.perKmRate ??
      0
  )
}

const getIntercityDailyAllowanceRate = vehicleType => {
  const map = {
    cercaZip: 10,
    cercaGlide: 12,
    cercaTitan: 16
  }
  return map[vehicleType] || 10
}

const calculateIntercityAllowance = ({
  durationMinutes = 0,
  distanceKm = 0,
  vehicleType = 'cercaZip',
  settings
}) => {
  const config = getIntercityPricingConfig(settings)
  const hours = Math.max(0, Number(durationMinutes) / 60)
  let allowance = 0

  if (hours > 0) {
    const firstBlock = Math.min(hours, 24)
    if (firstBlock > 0) allowance += config.roundTripAllowance.first24Hours
    if (hours > 24) {
      const remaining = hours - 24
      const extraBlocks = Math.ceil(remaining / 24)
      if (extraBlocks > 0) {
        allowance += config.roundTripAllowance.next24Hours
      }
      if (extraBlocks > 1) {
        allowance += (extraBlocks - 1) * config.roundTripAllowance.subsequent24Hours
      }
    }
  }

  const thresholdKm = config.dailyDistanceAllowance.thresholdKm
  if (Number(distanceKm) > thresholdKm) {
    const distanceAllowanceRate = getIntercityDailyAllowanceRate(vehicleType)
    const extraKm = Number(distanceKm) - thresholdKm
    allowance += extraKm * distanceAllowanceRate
  }

  return roundMoney(allowance)
}

const calculateIntercityFareBreakdown = ({
  pickupLocation,
  dropoffLocation,
  durationMinutes = 0,
  vehicleType = 'cercaZip',
  tripMode = 'one_way',
  tollCharges = 0,
  parkingCharges = 0,
  settings
}) => {
  if (!pickupLocation?.coordinates || !dropoffLocation?.coordinates) {
    throw new Error('Pickup and dropoff locations are required for intercity fare calculation')
  }

  const config = getIntercityPricingConfig(settings)
  const [pickupLng, pickupLat] = pickupLocation.coordinates
  const [dropoffLng, dropoffLat] = dropoffLocation.coordinates
  const distanceKm = calculateHaversineDistance(pickupLat, pickupLng, dropoffLat, dropoffLng)
  const perKmRate = getIntercityPerKmRate(vehicleType, settings)
  const baseFare = roundMoney(config.baseFare)
  const distanceFare = roundMoney(distanceKm * perKmRate)
  const roundedToll = roundMoney(tollCharges || config.tollChargeDefault || 0)
  const roundedParking = roundMoney(parkingCharges || config.parkingChargeDefault || 0)
  const driverAllowance = tripMode === 'round_trip'
    ? calculateIntercityAllowance({
        durationMinutes,
        distanceKm,
        vehicleType,
        settings
      })
    : 0

  const finalFare = roundMoney(
    baseFare + distanceFare + roundedToll + roundedParking + driverAllowance
  )

  return {
    distanceKm: roundMoney(distanceKm),
    durationMinutes: Math.max(0, Math.round(Number(durationMinutes) || 0)),
    perKmRate: roundMoney(perKmRate),
    baseFare,
    distanceFare,
    tollCharges: roundedToll,
    parkingCharges: roundedParking,
    driverAllowance,
    finalFare,
    tripMode
  }
}

const isIntercityRide = ride => String(ride?.rideType || '').toLowerCase() === 'intercity'

const getIntercityEligibleDrivers = async ({
  pickupLocation,
  dropoffLocation,
  vehicleType,
  batchSize = 5,
  excludeDriverIds = [],
  matchRadiusMeters = 20000
}) => {
  const drivers = await Driver.find({
    location: {
      $near: {
        $geometry: {
          type: 'Point',
          coordinates: pickupLocation.coordinates
        },
        $maxDistance: matchRadiusMeters
      }
    },
    isActive: true,
    isOnline: true,
    isBusy: false,
    intercityEnabled: true,
    socketId: { $exists: true, $ne: null, $ne: '' },
    ...(excludeDriverIds.length ? { _id: { $nin: excludeDriverIds } } : {})
  })
    .select('name socketId location vehicleInfo assignedFleetVehicleId rideAccess intercityEnabled isBusy isOnline')
    .limit(Math.max(batchSize, 20))

  // For intercity rides, don't filter by vehicle type since all intercity-enabled drivers
  // can accept any intercity ride (pricing is calculated based on requested vehicle type)
  const filtered = drivers

  return filtered.sort((a, b) => {
    const aCoords = a.location?.coordinates || []
    const bCoords = b.location?.coordinates || []
    const pickupCoords = pickupLocation.coordinates
    const aDist = aCoords.length === 2
      ? calculateHaversineDistance(pickupCoords[1], pickupCoords[0], aCoords[1], aCoords[0])
      : Number.MAX_SAFE_INTEGER
    const bDist = bCoords.length === 2
      ? calculateHaversineDistance(pickupCoords[1], pickupCoords[0], bCoords[1], bCoords[0])
      : Number.MAX_SAFE_INTEGER
    return aDist - bDist
  }).slice(0, batchSize)
}

const calculateRouteDistanceInKm = routePoints => {
  if (!Array.isArray(routePoints) || routePoints.length < 2) {
    return 0
  }

  let totalDistance = 0
  for (let i = 1; i < routePoints.length; i++) {
    const prev = routePoints[i - 1]
    const next = routePoints[i]
    if (
      !prev?.coordinates ||
      !next?.coordinates ||
      prev.coordinates.length < 2 ||
      next.coordinates.length < 2
    ) {
      continue
    }

    const [prevLng, prevLat] = prev.coordinates
    const [nextLng, nextLat] = next.coordinates
    totalDistance += calculateHaversineDistance(
      prevLat,
      prevLng,
      nextLat,
      nextLng
    )
  }

  return Math.round(totalDistance * 100) / 100
}

const appendRideRoutePoint = async (rideId, location) => {
  try {
    const coordinates = toLngLat(location)
    if (!coordinates || coordinates.length !== 2) {
      throw new Error('Invalid route point coordinates')
    }

    const [lng, lat] = coordinates
    return Ride.findByIdAndUpdate(
      rideId,
      {
        $push: {
          routePoints: {
            $each: [
              {
                type: 'Point',
                coordinates: [lng, lat],
                recordedAt: new Date()
              }
            ],
            $slice: -BEFORE_START_ROUTE_POINTS_MAX
          }
        }
      },
      { new: true }
    )
  } catch (error) {
    throw new Error(`Error appending route point: ${error.message}`)
  }
}

const assignDriverToRide = async (rideId, driverId, driverSocketId) => {
  try {
    logger.info(`🚗 Assigning driver ${driverId} to ride ${rideId}`)

    // 1️⃣ Ensure ride exists & is still available
    const rideForCheck = await Ride.findById(rideId)
    if (!rideForCheck) {
      throw new Error('Ride not found')
    }

    if (rideForCheck.status !== 'requested') {
      throw new Error(`Ride is no longer available (status: ${rideForCheck.status})`)
    }

    // 2️⃣ DATE_WISE conflict check
    if (rideForCheck.bookingType === 'DATE_WISE') {
      const conflict = await Ride.findOne({
        driver: driverId,
        bookingType: 'DATE_WISE',
        'bookingMeta.dates': { $in: rideForCheck.bookingMeta.dates },
        status: { $in: ['accepted', 'in_progress'] }
      })

      if (conflict) {
        throw new Error('Driver not available on selected dates')
      }
    }

    // 3️⃣ ATOMIC ASSIGN (THIS IS YOUR LOCK)
    // This query ensures only ONE driver can successfully accept:
    // - Ride must be in 'requested' status
    // - Ride must not have a driver assigned yet
    // MongoDB's findOneAndUpdate is atomic, preventing race conditions
    logger.info(
      `🔒 Attempting atomic assignment - rideId: ${rideId}, driverId: ${driverId}`
    )
    
    const ride = await Ride.findOneAndUpdate(
      {
        _id: rideId,
        status: 'requested',
        driver: { $exists: false }
      },
      {
        $set: {
          driver: driverId,
          driverSocketId,
          status: 'accepted'
        }
      },
      {
        new: true,
        runValidators: true
      }
    ).populate('driver rider')

    if (!ride) {
      // Check why assignment failed for better error message
      const currentRide = await Ride.findById(rideId).select('status driver').lean()
      if (currentRide) {
        if (currentRide.status !== 'requested') {
          logger.warn(
            `⚠️ Atomic assignment failed - ride ${rideId} status is ${currentRide.status}, not 'requested'`
          )
          throw new Error(`Ride is no longer available (status: ${currentRide.status})`)
        }
        if (currentRide.driver) {
          logger.warn(
            `⚠️ Atomic assignment failed - ride ${rideId} already has driver: ${currentRide.driver}`
          )
          throw new Error('Ride already accepted by another driver')
        }
      }
      logger.warn(
        `⚠️ Atomic assignment failed - ride ${rideId} not found or conditions not met`
      )
      throw new Error('Ride already accepted by another driver')
    }
    
    logger.info(
      `✅ Atomic assignment successful - rideId: ${rideId}, driverId: ${driverId}`
    )

    logger.info(`✅ Driver ${driverId} assigned to ride ${rideId}`)

    // For intercity rides, change status to 'upcoming' instead of 'accepted'
    if (isIntercityRide(ride)) {
      const updatedRide = await Ride.findByIdAndUpdate(
        rideId,
        { status: 'upcoming' },
        { new: true }
      ).populate('driver rider')
      if (updatedRide) {
        Object.assign(ride, updatedRide.toObject ? updatedRide.toObject() : updatedRide)
      }
      logger.info(`Status updated to 'upcoming' for intercity ride - rideId: ${rideId}`)
    }

    // 4️⃣ DRIVER BUSY LOGIC
    if (isIntercityRide(ride)) {
      // For all intercity rides, driver is NOT busy - they can accept other rides until they start the ride
      await Driver.findByIdAndUpdate(driverId, {
        isBusy: false, // Allow accepting other rides
        busyUntil: null,
        currentRideType: null,
        currentRideId: null
      })
    } else if (ride.scheduleType === 'scheduled') {
      // For scheduled non-intercity rides, driver is busy but doesn't have current active ride yet
      await Driver.findByIdAndUpdate(driverId, {
        isBusy: true,
        busyUntil: ride.scheduledAt || null,
        currentRideType: null, // Not active yet
        currentRideId: null
      })
    } else if (ride.bookingType === 'INSTANT') {
      await Driver.findByIdAndUpdate(driverId, {
        isBusy: true,
        busyUntil: null,
        currentRideType: 'normal',
        currentRideId: ride._id
      })
    } else {
      // FULL_DAY / RENTAL
      await Driver.findByIdAndUpdate(driverId, {
        isBusy: false,
        busyUntil: ride.bookingMeta?.endTime || null,
        currentRideType: ride.bookingType || null,
        currentRideId: ride._id
      })
    }

    return ride
  } catch (error) {
    throw new Error(`Error assigning driver: ${error.message}`)
  }
}

/**
 * Stacked / destination-reach driver assignment.
 *
 * The driver is currently busy on a normal INSTANT ride and is near the
 * active drop-off. We assign them this ride as their NEXT trip without
 * disturbing their current trip's busy state. The ride moves to status
 * 'accepted' (so other drivers stop seeing it), and the driver record gets
 * `queuedRideId` populated. On `completeRide` of the active trip the
 * promotion logic flips this queued ride into the new active ride.
 *
 * Errors thrown here are mapped to socket `rideError` codes by the caller:
 *   - 'queued ride'  → ALREADY_HAS_QUEUED_RIDE
 *   - 'not eligible' → NOT_ELIGIBLE_STACKED
 */
const assignStackedDriverToRide = async (rideId, driverId, driverSocketId) => {
  try {
    if (!rideId || !driverId) {
      throw new Error('Ride ID and Driver ID are required (stacked accept)')
    }

    const driverDoc = await Driver.findById(driverId)
      .select('isBusy currentRideId currentRideType queuedRideId')
      .lean()

    if (!driverDoc) {
      throw new Error('Driver not found')
    }

    if (driverDoc.queuedRideId) {
      const err = new Error('Driver already has a queued ride')
      err.code = 'ALREADY_HAS_QUEUED_RIDE'
      throw err
    }

    if (
      !driverDoc.isBusy ||
      !driverDoc.currentRideId ||
      driverDoc.currentRideType !== 'normal'
    ) {
      const err = new Error('Driver is not eligible for stacked acceptance')
      err.code = 'NOT_ELIGIBLE_STACKED'
      throw err
    }

    const targetRide = await Ride.findById(rideId)
      .select('status driver destinationReachDrivers bookingType')
      .lean()

    if (!targetRide) {
      throw new Error('Ride not found')
    }
    if (targetRide.bookingType && targetRide.bookingType !== 'INSTANT') {
      const err = new Error(
        'Stacked accept is only supported for INSTANT rides'
      )
      err.code = 'NOT_ELIGIBLE_STACKED'
      throw err
    }

    const isAuthorizedForStacked = (targetRide.destinationReachDrivers || [])
      .map(id => String(id))
      .includes(String(driverId))

    if (!isAuthorizedForStacked) {
      const err = new Error(
        'Driver was not offered this ride as a destination-reach candidate'
      )
      err.code = 'NOT_ELIGIBLE_STACKED'
      throw err
    }

    // Atomic ride assignment: only succeed if still requested and unassigned.
    const ride = await Ride.findOneAndUpdate(
      { _id: rideId, status: 'requested', driver: { $exists: false } },
      {
        $set: {
          driver: driverId,
          driverSocketId,
          status: 'accepted',
          acceptedAt: new Date()
        }
      },
      { new: true, runValidators: true }
    ).populate('driver rider')

    if (!ride) {
      const currentRide = await Ride.findById(rideId)
        .select('status driver')
        .lean()
      if (currentRide?.status !== 'requested' || currentRide?.driver) {
        throw new Error('Ride already accepted by another driver')
      }
      throw new Error('Ride no longer available')
    }

    // Atomic driver update: only succeed if queuedRideId is still null. This
    // is a second guard against a race between two stacked accepts.
    const driverUpdate = await Driver.findOneAndUpdate(
      { _id: driverId, queuedRideId: null },
      { $set: { queuedRideId: ride._id } },
      { new: true }
    )

    if (!driverUpdate) {
      // Another stacked accept won the race; roll back the ride assignment so
      // the offer can re-circulate.
      await Ride.findByIdAndUpdate(ride._id, {
        $unset: { driver: '', driverSocketId: '' },
        $set: { status: 'requested' }
      })
      const err = new Error('Driver already has a queued ride')
      err.code = 'ALREADY_HAS_QUEUED_RIDE'
      throw err
    }

    logger.info(
      `✅ Stacked assignment - rideId: ${rideId} queued for driver ${driverId} (currentRideId=${driverDoc.currentRideId})`
    )

    return ride
  } catch (error) {
    if (error.code) throw error
    throw new Error(`Error assigning stacked driver: ${error.message}`)
  }
}


const startRide = async rideId => {
  try {
    const ride = await Ride.findByIdAndUpdate(
      rideId,
      { status: 'in_progress' },
      { new: true }
    ).populate('driver rider')
    if (!ride) throw new Error('Ride not found')
    return ride
  } catch (error) {
    throw new Error(`Error starting ride: ${error.message}`)
  }
}

const completeRide = async (rideId, fare, options = {}) => {
  try {
    // Log fare information
    logger.info(
      `[Fare Tracking] completeRide called - rideId: ${rideId}, fare parameter: ₹${fare || 'not provided'}`
    )

    // Get current ride to compare fare
    const Ride = require('../Models/Driver/ride.model')
    const currentRide = await Ride.findById(rideId)
    if (currentRide) {
      logger.info(
        `[Fare Tracking] Current ride fare before completion: ₹${currentRide.fare || 'not set'}`
      )
    }

    // First update end time to calculate actualDuration (but don't update isBusy yet)
    const endTime = new Date()
    const actualDuration = currentRide?.actualStartTime
      ? Math.round((endTime - currentRide.actualStartTime) / 60000) // in minutes
      : 0

    // CRITICAL FIX: Persist actualDuration and actualEndTime BEFORE recalculating fare
    // This ensures recalculateRideFare can access the correct actualDuration from the database
    await Ride.findByIdAndUpdate(rideId, {
      actualEndTime: endTime,
      actualDuration: actualDuration,
      stopOtpVerifiedAt: endTime
    })
    logger.info(
      `[Fare Tracking] Persisted actualDuration: ${actualDuration}min, actualEndTime: ${endTime.toISOString()} before fare recalculation`
    )

    // Recalculate fare with actual duration and actual route distance
    let recalculatedFare =
      fare != null && Number.isFinite(Number(fare)) ? Number(fare) : Number(currentRide?.fare) || 0
    let fareBreakdown = null
    let oldFare = currentRide?.fare || fare || 0
    const agreedAtBookingForComplete =
      currentRide?.fareAtBooking != null && currentRide.fareAtBooking > 0
        ? Number(currentRide.fareAtBooking)
        : Number(currentRide?.fare || oldFare || 0)

    const actualDistanceFromRoute = calculateRouteDistanceInKm(
      currentRide?.routePoints || []
    )
    let measuredDistanceInKm =
      currentRide?.actualDistanceInKm > 0
        ? currentRide.actualDistanceInKm
        : actualDistanceFromRoute > 0
        ? actualDistanceFromRoute
        : currentRide.distanceInKm || 0

    if (!measuredDistanceInKm || measuredDistanceInKm <= 0) {
      const p = currentRide?.pickupLocation?.coordinates
      const d = currentRide?.dropoffLocation?.coordinates
      if (Array.isArray(p) && p.length >= 2 && Array.isArray(d) && d.length >= 2) {
        measuredDistanceInKm = calculateHaversineDistance(
          p[1],
          p[0],
          d[1],
          d[0]
        )
        logger.info(
          `[Fare Tracking] measuredDistance was 0; using haversine pickup→drop ${measuredDistanceInKm}km for rideId ${rideId}`
        )
      }
    }

    await Ride.findByIdAndUpdate(rideId, {
      actualDistanceInKm: measuredDistanceInKm,
      distanceInKm: measuredDistanceInKm,
      estimatedDistanceInKm:
        currentRide.estimatedDistanceInKm || currentRide.distanceInKm || measuredDistanceInKm
    })

    if (options?.forceFareMode === 'full_fare_to_destination') {
      logger.info(
        `[Fare Recalculation] forceFareMode=full_fare_to_destination for rideId ${rideId}; skipping recalculation`
      )
    } else {
      try {
        const recalculated = await recalculateRideFare(rideId)
        recalculatedFare = recalculated.finalFare
        fareBreakdown = recalculated
        logger.info(
          `[Fare Recalculation] Fare recalculated - rideId: ${rideId}, oldFare: ₹${oldFare}, newFare: ₹${recalculatedFare}`
        )
      } catch (recalcError) {
        logger.warn(
          `[Fare Recalculation] Failed to recalculate fare for rideId ${rideId}, using provided fare: ${recalcError.message}`
        )
        // Use provided fare if recalculation fails
      }
    }

    if (
      !fareBreakdown &&
      agreedAtBookingForComplete > 0 &&
      recalculatedFare < agreedAtBookingForComplete
    ) {
      try {
        const Settings = require('../Models/Admin/settings.modal.js')
        const settings = await Settings.findOne()
        const thresholds = getPricingSubstantiveThresholds(settings?.pricingConfigurations)
        const estimatedKmForSubstantive =
          currentRide.estimatedDistanceInKm != null &&
          Number(currentRide.estimatedDistanceInKm) > 0
            ? Number(currentRide.estimatedDistanceInKm)
            : Number(currentRide.distanceInKm) || measuredDistanceInKm || 0
        const substantiveEval = evaluateSubstantiveInstantTrip({
          thresholds,
          actualDurationMinutes: actualDuration,
          actualDistanceKm: measuredDistanceInKm,
          estimatedDistanceKm: estimatedKmForSubstantive
        })
        const instantBooking =
          currentRide.bookingType === 'INSTANT' || !currentRide.bookingType
        if (instantBooking && substantiveEval.substantiveTrip) {
          logger.info('fare.lineage', {
            rideId: String(rideId),
            phase: 'completeRide_floor_recalc_failed',
            substantiveTrip: true,
            quoteFloorApplied: true,
            recalculatedFare,
            agreedAtBooking: agreedAtBookingForComplete,
            actualDistanceKm: measuredDistanceInKm,
            estimatedDistanceInKm: estimatedKmForSubstantive,
            actualDurationMinutes: actualDuration
          })
          recalculatedFare = agreedAtBookingForComplete
        }
      } catch (floorErr) {
        logger.warn(
          `[Fare Recalculation] completeRide quote floor skipped (settings): ${floorErr.message}`
        )
      }
    }

    // Update ride with recalculated fare, fare breakdown, end time, duration, and status
    const updateData = {
      status: 'completed',
      fare: recalculatedFare,
      actualEndTime: endTime,
      actualDuration: actualDuration
    }
    if (options?.completionSource) {
      updateData.completionSource = options.completionSource
    }
    
    if (fareBreakdown) {
      updateData.fareBreakdown = {
        baseFare: fareBreakdown.baseFare,
        distanceFare: fareBreakdown.distanceFare,
        timeFare: fareBreakdown.timeFare,
        subtotal: fareBreakdown.subtotal,
        fareAfterMinimum: fareBreakdown.fareAfterMinimum,
        discount: fareBreakdown.discount,
        pickupWaitCharge: fareBreakdown.pickupWaitCharge || 0,
        finalFare: recalculatedFare
      }
      // Update discount if promo code was re-applied
      if (fareBreakdown.discount > 0) {
        updateData.discount = fareBreakdown.discount
      }
    }

    const ride = await Ride.findByIdAndUpdate(
      rideId,
      updateData,
      { new: true }
    ).populate('driver rider')
    if (!ride) throw new Error('Ride not found')

    // NOW update driver isBusy to false AFTER ride status is 'completed'
    // This ensures validateAndFixDriverStatus won't find this ride as active
    if (ride.driver) {
      const driverId = ride.driver._id || ride.driver
      
      // Ensure driver exists before updating
      const driverExists = await Driver.findById(driverId)
        .select('queuedRideId')
        .lean()
      if (!driverExists) {
        logger.warn(`completeRide: Driver ${driverId} not found, skipping isBusy reset`)
      } else if (driverExists.queuedRideId) {
        // ============================
        // PROMOTE QUEUED RIDE
        // ============================
        // Driver finished an active ride and has a destination-reach queued
        // ride waiting. Atomically promote it to the active slot and emit
        // `rideAssigned` so the driver app navigates to the new ActiveRideScreen.
        const queuedId = driverExists.queuedRideId
        await Driver.findByIdAndUpdate(driverId, {
          isBusy: true,
          busyUntil: null,
          currentRideType: 'normal',
          currentRideId: queuedId,
          queuedRideId: null
        })
        logger.info(
          `✅ completeRide: Driver ${driverId} promoted queued ride ${queuedId} to active`
        )

        try {
          const promoted = await Ride.findById(queuedId).populate(
            'driver rider'
          )
          if (promoted) {
            const { getSocketIO } = require('./socket.js')
            const io = getSocketIO()
            const promotedSocketId =
              promoted.driverSocketId || ride.driver?.socketId
            const payload = promoted.toObject
              ? promoted.toObject()
              : promoted
            if (promotedSocketId) {
              io.to(promotedSocketId).emit('rideAssigned', payload)
              logger.info(
                `📤 Emitted rideAssigned for promoted queued ride ${queuedId} to driver socket ${promotedSocketId}`
              )
            } else {
              io.to(`driver_${driverId}`).emit('rideAssigned', payload)
            }
          }
        } catch (promoteErr) {
          logger.warn(
            `⚠️ Failed to emit rideAssigned for promoted queued ride: ${promoteErr.message}`
          )
        }
      } else {
        // Reset isBusy for this completed ride
        await Driver.findByIdAndUpdate(driverId, {
          isBusy: false,
          busyUntil: null,
          currentRideType: null,
          currentRideId: null
        })
        
        logger.info(
          `✅ completeRide: Driver ${driverId} isBusy reset to false after ride ${rideId} completion`
        )

        // Validate driver status to check for OTHER active rides
        // This ensures if driver has multiple rides, we only set isBusy=false if no other active rides exist
        const validationResult = await validateAndFixDriverStatus(driverId)
        if (validationResult.corrected) {
          logger.info(
            `✅ completeRide: Driver ${driverId} status validated and corrected: ${validationResult.reason}`
          )
        }
      }
    }

    if (ride.rideType === 'intercity' && ride.driver) {
      await Driver.findByIdAndUpdate(ride.driver._id || ride.driver, {
        $inc: { intercityRideCount: 1 }
      })
    } else if (ride.driver) {
      await Driver.findByIdAndUpdate(ride.driver._id || ride.driver, {
        $inc: { completedStandardRideCount: 1 }
      })
    }

    // Structured logging for fare calculation
    logger.info('fare.calculated', {
      rideId,
      baseFare: fareBreakdown?.baseFare || 0,
      distanceFare: fareBreakdown?.distanceFare || 0,
      timeFare: fareBreakdown?.timeFare || 0,
      subtotal: fareBreakdown?.subtotal || 0,
      finalFare: recalculatedFare,
      minimumFareApplied: recalculatedFare > (fareBreakdown?.subtotal || 0),
      oldFare,
      fareAtBooking: currentRide?.fareAtBooking,
      agreedAtBooking: agreedAtBookingForComplete,
      fareDifference: recalculatedFare - oldFare,
      timestamp: new Date().toISOString()
    })

    // Return ride with fare difference info for payment adjustment
    ride._fareDifference = recalculatedFare - oldFare
    ride._oldFare = oldFare

    // ============================
    // REDIS CLEANUP (Multi-Instance Safe)
    // ============================
    // Clear all Redis locks related to this ride
    try {
      await clearRideRedisKeys(rideId)
      logger.info(`✅ Redis cleanup completed for ride ${rideId}`)
    } catch (cleanupError) {
      // Don't fail ride completion if cleanup fails - log for monitoring
      logger.warn(`⚠️ Redis cleanup failed for ride ${rideId}: ${cleanupError.message}`)
    }

    return ride
  } catch (error) {
    throw new Error(`Error completing ride: ${error.message}`)
  }
}

/**
 * Rider cancellation: retained wallet fee split between platform and driver (AdminEarnings upsert).
 */
async function recordCancellationFeeAdminEarnings (ride, cancellationFee, settings) {
  try {
    if (!cancellationFee || cancellationFee <= 0) return
    const driverId = ride.driver?._id || ride.driver
    const riderId = ride.rider?._id || ride.rider
    if (!driverId || !riderId) return

    const pPct = Number(settings?.cancellationSettlement?.cancellationFeeSplitPlatformPercent)
    const dPct = Number(settings?.cancellationSettlement?.cancellationFeeSplitDriverPercent)
    const platformPct = Number.isFinite(pPct) ? pPct : 50
    const driverPct = Number.isFinite(dPct) ? dPct : 50
    const platformShare =
      Math.round(((cancellationFee * platformPct) / 100) * 100) / 100
    const driverShare =
      Math.round((cancellationFee - platformShare) * 100) / 100

    const vehicleSnapshot = await getDriverVehicleSnapshotForEarnings(driverId)

    const pmSnap = String(ride.paymentMethod || '').toUpperCase()
    await AdminEarnings.findOneAndUpdate(
      { rideId: ride._id },
      {
        rideId: ride._id,
        driverId,
        riderId,
        grossFare: cancellationFee,
        platformFee: platformShare,
        driverEarning: driverShare,
        rideDate: new Date(),
        vehicleSnapshot,
        paymentStatus: 'completed',
        riderFundsStatus: 'captured',
        driverPayoutEligible: true,
        ...(pmSnap ? { paymentMethodSnapshot: pmSnap } : {}),
        settlementType: 'rider_cancel_fee_retained',
        cancellationFeeSplit: {
          totalFee: cancellationFee,
          platformShare,
          driverShare,
          platformPercent: platformPct,
          driverPercent: driverPct
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )

    try {
      const { getSocketIO } = require('./socket.js')
      const io = getSocketIO()
      if (io) {
        io.to(`driver_${driverId}`).emit('driverEarningAdded', {
          driverId: String(driverId),
          rideId: String(ride._id),
          driverEarning: driverShare,
          grossFare: cancellationFee,
          platformFee: platformShare,
          settlementType: 'rider_cancel_fee_retained',
          cancellationFeeSplit: {
            platformPercent: platformPct,
            driverPercent: driverPct
          }
        })
      }
    } catch (e) {
      logger.warn(`recordCancellationFeeAdminEarnings socket ${e.message}`)
    }
  } catch (err) {
    logger.error(`recordCancellationFeeAdminEarnings ${err.message}`)
  }
}

/**
 * Process wallet refund for a cancelled ride
 * @param {Object} ride - The ride document (must be populated with rider)
 * @param {String} originalStatus - The original ride status before cancellation
 * @param {String} cancelledBy - Who cancelled the ride ('rider', 'driver', 'system')
 * @param {String} cancellationReason - Reason for cancellation
 * @returns {Promise<Object>} Refund information or null if no refund needed
 */
const processWalletRefund = async (ride, originalStatus, cancelledBy, cancellationReason = null) => {
  try {
    // 1. Check if payment method is WALLET (case-insensitive)
    const paymentMethodUpper = (ride.paymentMethod || '').toUpperCase()
    if (paymentMethodUpper !== 'WALLET') {
      logger.info(
        `processWalletRefund: Early return - payment method not WALLET (rideId: ${ride._id}, paymentMethod: ${ride.paymentMethod}, cancelledBy: ${cancelledBy})`
      )
      return null
    }

    // 2. Check if already refunded (prevent double refunds)
    if (ride.paymentStatus === 'refunded') {
      logger.info(
        `processWalletRefund: Early return - already refunded (rideId: ${ride._id}, cancelledBy: ${cancelledBy})`
      )
      return null
    }

    // 3. Check if ride is completed (shouldn't refund completed rides)
    if (originalStatus === 'completed') {
      logger.info(
        `processWalletRefund: Early return - ride already completed (rideId: ${ride._id}, cancelledBy: ${cancelledBy})`
      )
      return null
    }

    // 4. Find the RIDE_PAYMENT transaction for this ride
    const paymentTransaction = await WalletTransaction.findOne({
      relatedRide: ride._id,
      transactionType: 'RIDE_PAYMENT',
      status: 'COMPLETED'
    })

    if (!paymentTransaction) {
      logger.info(
        `processWalletRefund: Early return - no RIDE_PAYMENT transaction (rideId: ${ride._id}, cancelledBy: ${cancelledBy}) - payment may not have been deducted`
      )
      return null
    }

    // 5. Check if refund transaction already exists (additional double-refund check)
    const existingRefund = await WalletTransaction.findOne({
      relatedRide: ride._id,
      transactionType: 'REFUND',
      status: 'COMPLETED'
    })

    if (existingRefund) {
      logger.info(
        `processWalletRefund: Early return - refund transaction already exists (rideId: ${ride._id}, cancelledBy: ${cancelledBy})`
      )
      return null
    }

    // 6. Determine cancellation fee based on ride status, cancellation reason, and admin settings
    const Settings = require('../Models/Admin/settings.modal.js')
    const settings = await Settings.findOne()
    
    let cancellationFee = 0
    const shouldApplyCancellationFee = 
      // Fee applies only if:
      // - Original ride status is 'accepted' or 'arrived' (driver was assigned)
      // - AND cancelled by rider (not system or driver)
      // - AND not a system cancellation reason
      (originalStatus === 'accepted' || originalStatus === 'arrived') &&
      cancelledBy === 'rider' &&
      cancellationReason !== 'NO_DRIVER_FOUND' &&
      cancellationReason !== 'NO_DRIVER_ACCEPTED_TIMEOUT' &&
      cancellationReason !== 'ALL_DRIVERS_REJECTED'

    if (shouldApplyCancellationFee) {
      const rawFee = Number(settings?.pricingConfigurations?.cancellationFees)
      cancellationFee = Number.isFinite(rawFee) && rawFee >= 0 ? rawFee : 0
      if (!Number.isFinite(rawFee) || rawFee < 0) {
        logger.warn(
          'processWalletRefund: cancellationFees missing or invalid in settings; using 0'
        )
      }
      logger.info(`processWalletRefund: Cancellation fee applies - ₹${cancellationFee} (original ride status: ${originalStatus}, cancelled by: ${cancelledBy})`)
    } else {
      logger.info(`processWalletRefund: No cancellation fee - original ride status: ${originalStatus}, cancelled by: ${cancelledBy}, reason: ${cancellationReason || 'none'}`)
    }

    // 7. Calculate refund amount (fare - cancellation fee)
    const refundAmount = Math.max(0, ride.fare - cancellationFee)

    if (refundAmount === 0) {
      logger.info(`processWalletRefund: Refund amount is ₹0 (fare: ₹${ride.fare}, cancellation fee: ₹${cancellationFee}), skipping transaction creation`)
      
      // Still update ride with cancellation fee and refund amount (0)
      await Ride.findByIdAndUpdate(ride._id, {
        cancellationFee,
        refundAmount: 0,
        paymentStatus: 'refunded'
      })

      if (cancellationFee > 0) {
        await recordCancellationFeeAdminEarnings(ride, cancellationFee, settings)
      }

      return {
        refunded: true,
        refundAmount: 0,
        cancellationFee,
        originalFare: ride.fare,
        reason: 'Cancellation fee equals fare'
      }
    }

    // 8. Get rider user document to update wallet balance
    const riderId = ride.rider?._id || ride.rider
    const user = await User.findById(riderId)
    
    if (!user) {
      logger.error(`processWalletRefund: User not found for rider ${riderId}`)
      throw new Error(`User not found for rider ${riderId}`)
    }

    // 9. Calculate new wallet balance
    const balanceBefore = user.walletBalance || 0
    const balanceAfter = balanceBefore + refundAmount

    // 10. Create REFUND transaction
    const refundTransaction = await WalletTransaction.create({
      user: riderId,
      transactionType: 'REFUND',
      amount: refundAmount,
      balanceBefore,
      balanceAfter,
      relatedRide: ride._id,
      paymentMethod: 'WALLET',
      status: 'COMPLETED',
      description: `Refund for cancelled ride${cancellationFee > 0 ? ` (cancellation fee: ₹${cancellationFee} deducted)` : ''}${cancellationReason ? ` - ${cancellationReason}` : ''}`,
      metadata: {
        originalFare: ride.fare,
        cancellationFee,
        cancelledBy,
        cancellationReason: cancellationReason || null,
        originalPaymentTransactionId: paymentTransaction._id
      }
    })

    // 11. Update user wallet balance
    user.walletBalance = balanceAfter
    await user.save()

    // 12. Update ride with refund details
    await Ride.findByIdAndUpdate(ride._id, {
      refundAmount,
      cancellationFee,
      paymentStatus: 'refunded'
    })

    if (cancellationFee > 0) {
      await recordCancellationFeeAdminEarnings(ride, cancellationFee, settings)
    }

    // 13. Log refund details
    logger.info(`💰 Wallet refund processed successfully:`)
    logger.info(`   Ride ID: ${ride._id}`)
    logger.info(`   Rider: ${riderId}`)
    logger.info(`   Original Fare: ₹${ride.fare}`)
    logger.info(`   Cancellation Fee: ₹${cancellationFee}`)
    logger.info(`   Refund Amount: ₹${refundAmount}`)
    logger.info(`   Wallet Balance: ₹${balanceBefore} → ₹${balanceAfter}`)
    logger.info(`   Cancelled By: ${cancelledBy}`)
    logger.info(`   Cancellation Reason: ${cancellationReason || 'none'}`)
    logger.info(`   Refund Transaction ID: ${refundTransaction._id}`)

    return {
      refunded: true,
      refundAmount,
      cancellationFee,
      originalFare: ride.fare,
      balanceBefore,
      balanceAfter,
      refundTransactionId: refundTransaction._id,
      cancelledBy,
      cancellationReason: cancellationReason || null
    }
  } catch (error) {
    logger.error(`❌ Error processing wallet refund for ride ${ride._id}: ${error.message}`)
    logger.error(`   Stack: ${error.stack}`)
    // Don't throw error - refund failure shouldn't prevent cancellation
    // Log error for manual review
    return {
      refunded: false,
      error: error.message
    }
  }
}

/**
 * Process Razorpay refund for a cancelled ride
 * @param {Object} ride - The ride document (must be populated with rider)
 * @param {String} originalStatus - The original ride status before cancellation
 * @param {String} cancelledBy - Who cancelled the ride ('rider', 'driver', 'system')
 * @param {String} cancellationReason - Reason for cancellation
 * @returns {Promise<Object>} Refund information or null if no refund needed
 */
const processRazorpayRefund = async (ride, originalStatus, cancelledBy, cancellationReason = null) => {
  try {
    // 1. Check if razorpayPaymentId exists (handles both pure RAZORPAY and hybrid)
    if (!ride.razorpayPaymentId) {
      logger.debug(`processRazorpayRefund: Skipping refund - no razorpayPaymentId found for ride ${ride._id}`)
      return null
    }

    // 2. Check if already refunded (prevent double refunds)
    if (ride.paymentStatus === 'refunded') {
      logger.warn(`processRazorpayRefund: Ride ${ride._id} already refunded, skipping duplicate refund`)
      return null
    }

    // 3. Check if ride is completed (shouldn't refund completed rides)
    if (originalStatus === 'completed') {
      logger.warn(`processRazorpayRefund: Ride ${ride._id} is completed, skipping refund`)
      return null
    }

    // 4. Check if refund transaction already exists (additional double-refund check)
    const existingRefund = await WalletTransaction.findOne({
      relatedRide: ride._id,
      transactionType: 'TOP_UP',
      'metadata.razorpayRefundId': { $exists: true },
      status: 'COMPLETED'
    })

    if (existingRefund) {
      logger.warn(`processRazorpayRefund: Refund transaction already exists for ride ${ride._id}, skipping duplicate refund`)
      return null
    }

    // 5. Determine cancellation fee based on ride status, cancellation reason, and admin settings
    const Settings = require('../Models/Admin/settings.modal.js')
    const settings = await Settings.findOne()
    
    let cancellationFee = 0
    const shouldApplyCancellationFee = 
      // Fee applies only if:
      // - Original ride status is 'accepted' or 'arrived' (driver was assigned)
      // - AND cancelled by rider (not system or driver)
      // - AND not a system cancellation reason
      (originalStatus === 'accepted' || originalStatus === 'arrived') &&
      cancelledBy === 'rider' &&
      cancellationReason !== 'NO_DRIVER_FOUND' &&
      cancellationReason !== 'NO_DRIVER_ACCEPTED_TIMEOUT' &&
      cancellationReason !== 'ALL_DRIVERS_REJECTED'

    if (shouldApplyCancellationFee) {
      const rawFeeRz = Number(settings?.pricingConfigurations?.cancellationFees)
      cancellationFee = Number.isFinite(rawFeeRz) && rawFeeRz >= 0 ? rawFeeRz : 0
      if (!Number.isFinite(rawFeeRz) || rawFeeRz < 0) {
        logger.warn(
          'processRazorpayRefund: cancellationFees missing or invalid in settings; using 0'
        )
      }
      logger.info(`processRazorpayRefund: Cancellation fee applies - ₹${cancellationFee} (original ride status: ${originalStatus}, cancelled by: ${cancelledBy})`)
    } else {
      logger.info(`processRazorpayRefund: No cancellation fee - original ride status: ${originalStatus}, cancelled by: ${cancelledBy}, reason: ${cancellationReason || 'none'}`)
    }

    // 6. Calculate refund amount
    // For pure RAZORPAY (including wallet-selected-but-₹0-balance case): refundAmount = razorpayAmountPaid - cancellationFee
    // For hybrid: refundAmount = razorpayAmountPaid (full Razorpay portion, cancellation fee deducted from wallet portion)
    const razorpayAmountPaid = ride.razorpayAmountPaid || ride.fare || 0
    const walletAmountUsed = ride.walletAmountUsed || 0
    const isHybrid = walletAmountUsed > 0

    let refundAmount = 0
    if (isHybrid) {
      // Hybrid payment: Refund full Razorpay portion (cancellation fee deducted from wallet portion)
      refundAmount = razorpayAmountPaid
    } else {
      // Pure RAZORPAY: Deduct cancellation fee from Razorpay refund
      refundAmount = Math.max(0, razorpayAmountPaid - cancellationFee)
    }

    if (refundAmount === 0) {
      logger.info(`processRazorpayRefund: Refund amount is ₹0 (razorpayAmountPaid: ₹${razorpayAmountPaid}, cancellation fee: ₹${cancellationFee}), skipping refund`)
      
      // Still update ride with cancellation fee and refund amount (0)
      await Ride.findByIdAndUpdate(ride._id, {
        cancellationFee,
        refundAmount: 0,
        paymentStatus: 'refunded'
      })

      return {
        refunded: true,
        refundAmount: 0,
        cancellationFee,
        originalFare: ride.fare,
        razorpayAmountPaid,
        reason: 'Cancellation fee equals or exceeds Razorpay amount'
      }
    }

    // 7. Get rider user document
    const riderId = ride.rider?._id || ride.rider
    const user = await User.findById(riderId)
    
    if (!user) {
      logger.error(`processRazorpayRefund: User not found for rider ${riderId}`)
      throw new Error(`User not found for rider ${riderId}`)
    }

    // 8. Call Razorpay refund API
    let razorpayRefundId = null
    let razorpayRefundStatus = null
    
    try {
      logger.info(`processRazorpayRefund: Initiating Razorpay refund - Payment ID: ${ride.razorpayPaymentId}, Amount: ₹${refundAmount}`)
      
      const refund = await razorpayInstance.payments.refund(ride.razorpayPaymentId, {
        amount: Math.round(refundAmount * 100), // Convert to paise
        speed: 'normal', // Use 'optimum' for instant refunds (charges apply)
        notes: {
          rideId: ride._id.toString(),
          cancellationReason: cancellationReason || 'Ride cancelled',
          cancelledBy: cancelledBy,
          originalFare: ride.fare.toString(),
          cancellationFee: cancellationFee.toString()
        }
      })

      razorpayRefundId = refund.id
      razorpayRefundStatus = refund.status
      
      logger.info(`processRazorpayRefund: Razorpay refund initiated successfully - Refund ID: ${razorpayRefundId}, Status: ${razorpayRefundStatus}`)
    } catch (razorpayError) {
      logger.error(`processRazorpayRefund: Razorpay refund API error for ride ${ride._id}:`, razorpayError)
      // Don't throw - log error but continue to credit wallet (assume refund will process)
      // In production, you might want to handle this differently based on error type
      logger.warn(`processRazorpayRefund: Continuing with wallet credit despite Razorpay API error`)
    }

    // 9. Credit refunded amount to user's wallet
    const balanceBefore = user.walletBalance || 0
    const balanceAfter = balanceBefore + refundAmount

    // 10. Create TOP_UP transaction for refund
    const refundTransaction = await WalletTransaction.create({
      user: riderId,
      transactionType: 'TOP_UP',
      amount: refundAmount,
      balanceBefore,
      balanceAfter,
      relatedRide: ride._id,
      paymentMethod: 'RAZORPAY',
      status: 'COMPLETED',
      description: `Refund for cancelled ride${cancellationFee > 0 ? ` (cancellation fee: ₹${cancellationFee} deducted)` : ''}${cancellationReason ? ` - ${cancellationReason}` : ''}`,
      metadata: {
        razorpayRefundId: razorpayRefundId,
        razorpayRefundStatus: razorpayRefundStatus,
        razorpayPaymentId: ride.razorpayPaymentId,
        originalFare: ride.fare,
        razorpayAmountPaid: razorpayAmountPaid,
        cancellationFee,
        cancelledBy,
        cancellationReason: cancellationReason || null,
        isHybrid: isHybrid,
        walletAmountUsed: walletAmountUsed
      }
    })

    // 11. Update user wallet balance
    user.walletBalance = balanceAfter
    await user.save()

    // 12. Update ride with refund details
    await Ride.findByIdAndUpdate(ride._id, {
      refundAmount,
      cancellationFee,
      paymentStatus: 'refunded',
      razorpayRefundId: razorpayRefundId,
      razorpayRefundStatus: razorpayRefundStatus
    })

    // 13. Log refund details
    logger.info(`💰 Razorpay refund processed successfully:`)
    logger.info(`   Ride ID: ${ride._id}`)
    logger.info(`   Rider: ${riderId}`)
    logger.info(`   Payment ID: ${ride.razorpayPaymentId}`)
    logger.info(`   Razorpay Amount Paid: ₹${razorpayAmountPaid}`)
    logger.info(`   Wallet Amount Used: ₹${walletAmountUsed}`)
    logger.info(`   Is Hybrid: ${isHybrid}`)
    logger.info(`   Original Fare: ₹${ride.fare}`)
    logger.info(`   Cancellation Fee: ₹${cancellationFee}`)
    logger.info(`   Refund Amount: ₹${refundAmount}`)
    logger.info(`   Wallet Balance: ₹${balanceBefore} → ₹${balanceAfter}`)
    logger.info(`   Cancelled By: ${cancelledBy}`)
    logger.info(`   Cancellation Reason: ${cancellationReason || 'none'}`)
    logger.info(`   Razorpay Refund ID: ${razorpayRefundId || 'N/A'}`)
    logger.info(`   Refund Transaction ID: ${refundTransaction._id}`)

    return {
      refunded: true,
      refundAmount,
      cancellationFee,
      originalFare: ride.fare,
      razorpayAmountPaid,
      walletAmountUsed,
      isHybrid,
      balanceBefore,
      balanceAfter,
      refundTransactionId: refundTransaction._id,
      razorpayRefundId: razorpayRefundId,
      razorpayRefundStatus: razorpayRefundStatus,
      cancelledBy,
      cancellationReason: cancellationReason || null
    }
  } catch (error) {
    logger.error(`❌ Error processing Razorpay refund for ride ${ride._id}: ${error.message}`)
    logger.error(`   Stack: ${error.stack}`)
    // Don't throw error - refund failure shouldn't prevent cancellation
    // Log error for manual review
    return {
      refunded: false,
      error: error.message
    }
  }
}

// --- Driver in-progress cancellation settlement ---------------------------------
function resolveRideCurrentCoordinates (ride) {
  if (ride?.driver?.location?.coordinates?.length >= 2) {
    return ride.driver.location.coordinates
  }
  if (Array.isArray(ride?.routePoints) && ride.routePoints.length > 0) {
    const last = ride.routePoints[ride.routePoints.length - 1]
    if (last?.coordinates?.length >= 2) {
      return last.coordinates
    }
  }
  return null
}

async function getPerKmRateFromSettings () {
  const Settings = require('../Models/Admin/settings.modal.js')
  const settings = await Settings.findOne()
  const perKmRate = Number(settings?.pricingConfigurations?.perKmRate)
  if (!Number.isFinite(perKmRate) || perKmRate < 0) {
    throw new Error('Invalid perKmRate in admin settings')
  }
  return perKmRate
}

async function buildBeforeStartOtpRiderCancelSettlement (originalRide) {
  const perKmRate = await getPerKmRateFromSettings()
  const pickupCoords = originalRide?.pickupLocation?.coordinates
  const currentCoords = resolveRideCurrentCoordinates(originalRide)

  const polylineKm = calculateRouteDistanceInKm(originalRide?.routePoints)

  let straightKm = 0
  if (
    Array.isArray(pickupCoords) &&
    pickupCoords.length >= 2 &&
    Array.isArray(currentCoords) &&
    currentCoords.length >= 2
  ) {
    straightKm = calculateHaversineDistance(
      pickupCoords[1],
      pickupCoords[0],
      currentCoords[1],
      currentCoords[0]
    )
  }

  const travelledDistanceKm = resolveTravelledDistanceKmBeforeStart({
    polylineKm,
    straightKm,
    policy: BEFORE_START_DISTANCE_POLICY
  })

  const travelledAmount = roundMoney(travelledDistanceKm * perKmRate)
  const fixedPenaltyAmount = roundMoney(BEFORE_START_FIXED_PENALTY_RUPEES)
  const totalCharge = roundMoney(travelledAmount + fixedPenaltyAmount)

  logger.info(
    `metric.ride.before_start_cancel_distance rideId=${originalRide._id} polylineKm=${polylineKm} straightKm=${straightKm} finalKm=${travelledDistanceKm} policy=${BEFORE_START_DISTANCE_POLICY}`
  )

  return {
    travelledDistanceKm: roundMoney(travelledDistanceKm),
    travelledDistancePolylineKm: roundMoney(polylineKm),
    travelledDistanceStraightKm: roundMoney(straightKm),
    distancePolicy: BEFORE_START_DISTANCE_POLICY,
    perKmRateUsed: perKmRate,
    travelledAmount,
    fixedPenaltyAmount,
    totalCharge,
    walletDebited: 0,
    outstandingDue: totalCharge,
    driverCoordsAtCancel: currentCoords,
    riderPaymentStatus: totalCharge > 0 ? 'pending' : 'none_due',
    settlementVersion: 1,
    computedAt: new Date(),
    computedByFlow: 'rider_cancel_before_start_otp',
    idempotencyToken: `before-start-${originalRide._id}`
  }
}

async function getWalletRidePaymentSumForRide (rideId) {
  const txs = await WalletTransaction.find({
    relatedRide: rideId,
    transactionType: 'RIDE_PAYMENT',
    status: 'COMPLETED'
  })
    .select('amount')
    .lean()
  let sum = txs.reduce((s, t) => s + (Number(t.amount) || 0), 0)
  sum = roundMoney(sum)
  if (sum <= 0) {
    const r = await Ride.findById(rideId).select('walletAmountUsed').lean()
    sum = roundMoney(Number(r?.walletAmountUsed || 0))
  }
  return sum
}

async function executeRazorpayGatewayRefundBeforeStart (ride, refundRupees) {
  const amt = roundMoney(Number(refundRupees) || 0)
  if (amt <= 0 || !ride.razorpayPaymentId) return { applied: false }

  const existing = await WalletTransaction.findOne({
    relatedRide: ride._id,
    status: 'COMPLETED',
    'metadata.beforeStartOtpRiderCancelRazorpayGatewayRefund': true
  }).lean()
  if (existing) {
    return { applied: true, skipped: true, refundAmount: existing.amount }
  }

  let razorpayRefundId = null
  let razorpayRefundStatus = null
  try {
    const refund = await razorpayInstance.payments.refund(
      ride.razorpayPaymentId,
      {
        amount: Math.round(amt * 100),
        speed: 'normal',
        notes: {
          rideId: ride._id.toString(),
          flow: 'before_start_rider_cancel'
        }
      }
    )
    razorpayRefundId = refund.id
    razorpayRefundStatus = refund.status
    logger.info(
      `beforeStartCancel: Razorpay refund ok rideId=${ride._id} amount=${amt} refundId=${razorpayRefundId}`
    )
  } catch (err) {
    logger.error(
      `beforeStartCancel: Razorpay refund failed rideId=${ride._id} amount=${amt} ${err.message}`
    )
    throw err
  }

  const riderId = ride.rider?._id || ride.rider
  const user = riderId ? await User.findById(riderId) : null
  const balSnap = roundMoney(Number(user?.walletBalance || 0))

  await WalletTransaction.create({
    user: riderId,
    transactionType: 'REFUND',
    amount: amt,
    balanceBefore: balSnap,
    balanceAfter: balSnap,
    relatedRide: ride._id,
    paymentMethod: 'RAZORPAY',
    status: 'COMPLETED',
    description: `Gateway refund (before-start cancel) ₹${amt}`,
    metadata: {
      beforeStartOtpRiderCancelRazorpayGatewayRefund: true,
      razorpayRefundId,
      razorpayRefundStatus,
      razorpayPaymentId: ride.razorpayPaymentId,
      gatewayOnly: true
    }
  })

  await Ride.findByIdAndUpdate(ride._id, {
    razorpayRefundId: razorpayRefundId || ride.razorpayRefundId,
    razorpayRefundStatus: razorpayRefundStatus || ride.razorpayRefundStatus,
    refundAmount: amt
  })

  return { applied: true, refundAmount: amt, razorpayRefundId }
}

async function settleRiderWalletAndRazorpayForBeforeStartCancel (
  rideId,
  riderId,
  settlement,
  originalRide
) {
  const due = Number(settlement?.totalCharge || 0)
  if (due <= 0) {
    return {
      walletDebited: 0,
      outstandingDue: 0,
      riderPaymentStatus: 'none_due',
      razorpayRefundAmount: 0,
      prepaidWallet: 0,
      prepaidRazorpay: 0
    }
  }

  const existingTxn = await WalletTransaction.findOne({
    relatedRide: rideId,
    transactionType: 'CANCELLATION_FEE',
    status: 'COMPLETED',
    'metadata.beforeStartOtpRiderCancel': true
  }).lean()

  if (existingTxn) {
    const m = existingTxn.metadata || {}
    const ob = roundMoney(Number(m.outstandingDue) || 0)
    return {
      walletDebited: roundMoney(Math.max(0, Number(m.walletDebitedRecorded) || 0)),
      outstandingDue: ob,
      riderPaymentStatus:
        m.riderPaymentStatus ||
        (ob > 0 ? 'pending' : 'none_due'),
      razorpayRefundAmount: roundMoney(Number(m.razorpayRefundAmount) || 0),
      prepaidWallet: roundMoney(Number(m.prepaidWallet) || 0),
      prepaidRazorpay: roundMoney(Number(m.prepaidRazorpay) || 0)
    }
  }

  const Pw = await getWalletRidePaymentSumForRide(rideId)
  const Pr = roundMoney(Number(originalRide.razorpayAmountPaid || 0))
  const split = splitBeforeStartCancelPrepaid({ Pw, Pr, O: due })

  const user = await User.findById(riderId)
  if (!user) {
    throw new Error('User not found')
  }

  const balanceBefore = roundMoney(Number(user.walletBalance || 0))
  const W_new = walletBalanceAfterBeforeStartCancel(balanceBefore, Pw, {
    use_w: split.use_w,
    shortfall: split.shortfall
  })
  const walletDelta = roundMoney(W_new - balanceBefore)
  const walletDebitedRecorded = roundMoney(Math.max(0, -walletDelta))

  if (split.razorpayRefund > 0) {
    await executeRazorpayGatewayRefundBeforeStart(originalRide, split.razorpayRefund)
  }

  user.walletBalance = W_new
  await user.save()

  const outstandingDue = roundMoney(Math.max(0, -W_new))
  const riderPaymentStatus = outstandingDue > 0 ? 'pending' : 'none_due'

  await WalletTransaction.create({
    user: riderId,
    transactionType: 'CANCELLATION_FEE',
    amount: roundMoney(Math.max(0, Math.abs(walletDelta))),
    balanceBefore,
    balanceAfter: W_new,
    relatedRide: rideId,
    paymentMethod: 'WALLET',
    status: 'COMPLETED',
    description: `Before-start cancellation settlement (total ₹${due})`,
    metadata: {
      beforeStartOtpRiderCancel: true,
      totalCharge: due,
      prepaidWallet: Pw,
      prepaidRazorpay: Pr,
      use_w: split.use_w,
      use_r: split.use_r,
      shortfall: split.shortfall,
      razorpayRefundAmount: split.razorpayRefund,
      walletDeltaApplied: walletDelta,
      walletDebitedRecorded,
      outstandingDue,
      riderPaymentStatus,
      travelledDistanceKm: settlement.travelledDistanceKm,
      travelledAmount: settlement.travelledAmount,
      fixedPenaltyAmount: settlement.fixedPenaltyAmount
    }
  })

  return {
    walletDebited: walletDebitedRecorded,
    outstandingDue,
    riderPaymentStatus,
    razorpayRefundAmount: split.razorpayRefund,
    prepaidWallet: Pw,
    prepaidRazorpay: Pr
  }
}

async function creditDriverForBeforeStartCancel (ride, settlement) {
  const travelledGross = roundMoney(Number(settlement?.travelledAmount || 0))
  if (travelledGross <= 0) return

  const driverId = ride.driver?._id || ride.driver
  const riderId = ride.rider?._id || ride.rider
  if (!driverId || !riderId) return

  const Settings = require('../Models/Admin/settings.modal.js')
  const settings = await Settings.findOne()
  const { platformFee, driverEarning } = computePlatformSplitFromGrossFare(
    travelledGross,
    settings?.pricingConfigurations || {}
  )

  const vehicleSnapshot = await getDriverVehicleSnapshotForEarnings(driverId)
  const pmSnap = String(ride.paymentMethod || '').toUpperCase()
  const earnings = await AdminEarnings.findOneAndUpdate(
    { rideId: ride._id },
    {
      rideId: ride._id,
      driverId,
      riderId,
      grossFare: travelledGross,
      platformFee,
      driverEarning,
      rideDate: new Date(),
      vehicleSnapshot,
      paymentStatus: 'completed',
      riderFundsStatus: 'captured',
      driverPayoutEligible: true,
      ...(pmSnap ? { paymentMethodSnapshot: pmSnap } : {}),
      settlementType: 'rider_cancel_before_start_otp',
      vendorFineCredit: 0,
      riderPenaltyAmount: roundMoney(Number(settlement?.fixedPenaltyAmount || 0))
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )

  try {
    const { getSocketIO } = require('./socket.js')
    const io = getSocketIO()
    if (io) {
      io.to(`driver_${driverId}`).emit('driverEarningAdded', {
        driverId: String(driverId),
        rideId: String(ride._id),
        driverEarning: earnings.driverEarning,
        grossFare: earnings.grossFare,
        platformFee: earnings.platformFee
      })
    }
  } catch (emitErr) {
    logger.warn(
      `creditDriverForBeforeStartCancel: driverEarningAdded emit failed ${emitErr.message}`
    )
  }
}

/**
 * Rides where driver cancelled in_progress and rider still owes additionalDue (ledger not finalized).
 */
async function getPendingDriverInProgressCancelSettlements (userId) {
  const rides = await Ride.find({
    rider: userId,
    status: 'cancelled',
    cancelledBy: 'driver',
    'driverInProgressCancelSettlement.riderPaymentStatus': 'pending'
  })
    .select('_id createdAt updatedAt pickupAddress driverInProgressCancelSettlement')
    .sort({ updatedAt: -1 })
    .lean()

  const items = rides
    .filter(
      r =>
        r.driverInProgressCancelSettlement &&
        !r.driverInProgressCancelSettlement.ledgerFinalizedAt
    )
    .map(r => {
      const st = r.driverInProgressCancelSettlement
      return {
        rideId: String(r._id),
        additionalDue: roundMoney(st.additionalDue || 0),
        riderPenaltyAmount: st.riderPenaltyAmount,
        driverPartialAmount: st.driverPartialAmount,
        riderTotalCharge: st.riderTotalCharge,
        prepaidTotal: st.prepaidTotal,
        refundDue: st.refundDue,
        createdAt: r.createdAt,
        summary:
          r.pickupAddress && String(r.pickupAddress).trim()
            ? `Previous trip from ${r.pickupAddress}`
            : 'Previous trip cancellation'
      }
    })

  const totalAdditionalDue = roundMoney(
    items.reduce((s, i) => s + (i.additionalDue || 0), 0)
  )
  return { items, totalAdditionalDue }
}

async function getRiderPrepaidTotalForRide (ride) {
  let prepaid = ride.razorpayAmountPaid || 0
  const wt = await WalletTransaction.findOne({
    relatedRide: ride._id,
    transactionType: 'RIDE_PAYMENT',
    status: 'COMPLETED'
  }).lean()
  if (wt && wt.amount > 0) {
    prepaid += wt.amount
  } else if ((ride.walletAmountUsed || 0) > 0) {
    prepaid += ride.walletAmountUsed
  }
  return roundMoney(prepaid)
}

async function getDriverVehicleSnapshotForEarnings (driverId) {
  if (!driverId) {
    return {
      licensePlate: null,
      make: null,
      model: null,
      year: null,
      color: null,
      vehicleType: null,
      source: 'UNKNOWN'
    }
  }
  const driver = await Driver.findById(driverId)
    .select('vehicleInfo assignedFleetVehicleId')
    .lean()
  if (!driver) {
    return {
      licensePlate: null,
      make: null,
      model: null,
      year: null,
      color: null,
      vehicleType: null,
      source: 'UNKNOWN'
    }
  }
  if (driver.assignedFleetVehicleId) {
    const fleetVehicle = await FleetVehicle.findById(driver.assignedFleetVehicleId)
      .select('licensePlate make model year color vehicleType')
      .lean()
    if (fleetVehicle) {
      return {
        licensePlate: fleetVehicle.licensePlate || null,
        make: fleetVehicle.make || null,
        model: fleetVehicle.model || null,
        year: fleetVehicle.year || null,
        color: fleetVehicle.color || null,
        vehicleType: fleetVehicle.vehicleType || null,
        source: 'FLEET_ASSIGNED'
      }
    }
  }
  const vehicleInfo = driver.vehicleInfo || null
  if (vehicleInfo) {
    return {
      licensePlate: vehicleInfo.licensePlate || null,
      make: vehicleInfo.make || null,
      model: vehicleInfo.model || null,
      year: vehicleInfo.year || null,
      color: vehicleInfo.color || null,
      vehicleType: vehicleInfo.vehicleType || null,
      source: 'SELF_OWNED'
    }
  }
  return {
    licensePlate: null,
    make: null,
    model: null,
    year: null,
    color: null,
    vehicleType: null,
    source: 'UNKNOWN'
  }
}

/**
 * Rider-visible billing breakdown (no driver coordinates or internal ledger fields).
 */
function toRiderInProgressCancelBillingSummary (settlement) {
  if (!settlement || typeof settlement !== 'object') return null
  return {
    partialDistanceKm: settlement.partialDistanceKm,
    perKmRateUsed: settlement.perKmRateUsed,
    perKmRateSource: settlement.perKmRateSource || 'admin',
    driverPartialAmount: settlement.driverPartialAmount,
    riderPenaltyAmount: settlement.riderPenaltyAmount,
    riderTotalCharge: settlement.riderTotalCharge,
    prepaidTotal: settlement.prepaidTotal,
    additionalDue: settlement.additionalDue,
    refundDue: settlement.refundDue,
    riderPaymentStatus: settlement.riderPaymentStatus,
    billingNote: 'distance_based_partial',
    settlementVersion: settlement.settlementVersion
  }
}

/**
 * Rider-visible summary for cancel before start OTP (per-km + penalty).
 */
function toRiderBeforeStartCancelBillingSummary (settlement) {
  if (!settlement || typeof settlement !== 'object') return null
  const total = Number(settlement.totalCharge || 0)
  if (!Number.isFinite(total) || total <= 0) return null
  return {
    travelledDistanceKm: settlement.travelledDistanceKm,
    travelledAmount: settlement.travelledAmount,
    fixedPenaltyAmount: settlement.fixedPenaltyAmount,
    totalCharge: settlement.totalCharge,
    perKmRateUsed: settlement.perKmRateUsed,
    outstandingDue: settlement.outstandingDue,
    riderPaymentStatus: settlement.riderPaymentStatus,
    prepaidWallet: settlement.prepaidWallet,
    prepaidRazorpay: settlement.prepaidRazorpay,
    razorpayRefundAmount: settlement.razorpayRefundAmount,
    billingNote: 'before_start_otp_cancel'
  }
}

/**
 * Implied ₹/km from the booked trip when available; else null.
 */
function impliedPerKmFromBooking (ride) {
  const fare = Number(ride.fareAtBooking ?? ride.fare)
  const estKm = Number(ride.estimatedDistanceInKm)
  if (!Number.isFinite(fare) || fare <= 0) return null
  if (!Number.isFinite(estKm) || estKm <= 0) return null
  return fare / estKm
}

/**
 * Build settlement object for driver cancelling while ride is in_progress.
 * Partial leg: per-km uses booking-implied rate when valid, else admin perKmRate.
 */
async function computeDriverInProgressCancelSettlement (originalRide) {
  const Settings = require('../Models/Admin/settings.modal.js')
  const settings = await Settings.findOne()
  if (!settings?.pricingConfigurations) {
    throw new Error('Admin pricing settings not found')
  }
  const penalty = Number(settings.pricingConfigurations.cancellationFees)
  const adminPerKm = Number(settings.pricingConfigurations.perKmRate)
  if (!Number.isFinite(penalty) || penalty < 0) {
    throw new Error('Invalid cancellationFees in admin settings')
  }
  if (!Number.isFinite(adminPerKm) || adminPerKm < 0) {
    throw new Error('Invalid perKmRate in admin settings')
  }

  const implied = impliedPerKmFromBooking(originalRide)
  let perKmRate = adminPerKm
  let perKmRateSource = 'admin'
  if (implied != null && Number.isFinite(implied) && implied > 0) {
    perKmRate = implied
    perKmRateSource = 'booking_implied'
  }

  const driverDoc =
    originalRide.driver && originalRide.driver._id
      ? originalRide.driver
      : await Driver.findById(originalRide.driver).lean()
  if (!driverDoc) {
    throw new Error('Driver not found for settlement')
  }

  const pickupCoords = originalRide.pickupLocation?.coordinates
  let partialKm = 0
  let driverCoords = null
  if (
    pickupCoords &&
    pickupCoords.length >= 2 &&
    driverDoc.location?.coordinates?.length >= 2
  ) {
    const [pLng, pLat] = pickupCoords
    const [dLng, dLat] = driverDoc.location.coordinates
    driverCoords = [dLng, dLat]
    partialKm = calculateHaversineDistance(pLat, pLng, dLat, dLng)
  }

  const driverPartialAmount = roundMoney(partialKm * perKmRate)
  const riderPenaltyAmount = roundMoney(penalty)
  const riderTotalCharge = roundMoney(riderPenaltyAmount + driverPartialAmount)

  const vendorId = driverDoc.vendorId || null
  const fineRecipient = vendorId ? 'vendor' : 'platform'
  const vendorFineAmount = fineRecipient === 'vendor' ? riderPenaltyAmount : 0
  const platformFineAmount = fineRecipient === 'platform' ? riderPenaltyAmount : 0

  const prepaidTotal = await getRiderPrepaidTotalForRide(originalRide)
  const additionalDue = roundMoney(Math.max(0, riderTotalCharge - prepaidTotal))
  const refundDue = roundMoney(Math.max(0, prepaidTotal - riderTotalCharge))

  const riderPaymentStatus = additionalDue > 0 ? 'pending' : 'none_due'

  return {
    partialDistanceKm: roundMoney(partialKm),
    perKmRateUsed: perKmRate,
    perKmRateSource,
    driverPartialAmount,
    riderPenaltyAmount,
    riderTotalCharge,
    prepaidTotal,
    additionalDue,
    refundDue,
    fineRecipient,
    vendorFineAmount,
    platformFineAmount,
    driverCoordsAtCancel: driverCoords,
    riderPaymentStatus,
    ledgerFinalizedAt: null,
    settlementVersion: 1
  }
}

async function applyRefundForDriverInProgressCancel (ride, settlement) {
  const refundDue = settlement.refundDue || 0
  if (refundDue <= 0) {
    return { refunded: true, refundAmount: 0 }
  }

  const riderId = ride.rider?._id || ride.rider
  const user = await User.findById(riderId)
  if (!user) {
    logger.error(`applyRefundForDriverInProgressCancel: rider ${riderId} not found`)
    return { refunded: false, error: 'User not found' }
  }

  const existingRefund = await WalletTransaction.findOne({
    relatedRide: ride._id,
    transactionType: 'REFUND',
    status: 'COMPLETED',
    'metadata.driverInProgressCancel': true
  })
  if (existingRefund) {
    return { refunded: true, refundAmount: existingRefund.amount, duplicate: true }
  }

  let remaining = refundDue
  const rzPaid = ride.razorpayAmountPaid || 0
  let razorpayRefundId = null
  let razorpayRefundStatus = null

  if (ride.razorpayPaymentId && rzPaid > 0 && remaining > 0) {
    const rzRefundAmount = Math.min(remaining, rzPaid)
    const rzRefundPaise = Math.round(rzRefundAmount * 100)
    if (rzRefundPaise > 0) {
      try {
        const refund = await razorpayInstance.payments.refund(ride.razorpayPaymentId, {
          amount: rzRefundPaise,
          speed: 'normal',
          notes: {
            reason: 'driver_in_progress_cancel',
            rideId: String(ride._id)
          }
        })
        razorpayRefundId = refund.id
        razorpayRefundStatus = refund.status
        remaining = roundMoney(remaining - rzRefundAmount)
        logger.info(
          `applyRefundForDriverInProgressCancel: Razorpay refund ₹${rzRefundAmount} for ride ${ride._id}`
        )
      } catch (e) {
        logger.error(`applyRefundForDriverInProgressCancel: Razorpay error ${e.message}`)
      }
    }
  }

  if (remaining > 0) {
    const balanceBefore = user.walletBalance || 0
    const balanceAfter = roundMoney(balanceBefore + remaining)
    user.walletBalance = balanceAfter
    await user.save()

    await WalletTransaction.create({
      user: riderId,
      transactionType: 'REFUND',
      amount: remaining,
      balanceBefore,
      balanceAfter,
      relatedRide: ride._id,
      paymentMethod: 'WALLET',
      status: 'COMPLETED',
      description: `Refund after driver cancelled trip (₹${refundDue} total settlement)`,
      metadata: {
        driverInProgressCancel: true,
        razorpayPortion: roundMoney(refundDue - remaining)
      }
    })
  }

  const ridePaymentPatch = {
    refundAmount: refundDue,
    razorpayRefundId: razorpayRefundId || ride.razorpayRefundId,
    razorpayRefundStatus: razorpayRefundStatus || ride.razorpayRefundStatus
  }
  if (refundDue > 0) {
    ridePaymentPatch.paymentStatus = 'refunded'
  }
  await Ride.findByIdAndUpdate(ride._id, ridePaymentPatch)

  return { refunded: true, refundAmount: refundDue, razorpayRefundId }
}

/**
 * Idempotent: creates AdminEarnings, vendor sync, driver socket event.
 */
async function finalizeDriverInProgressCancelLedger (rideId) {
  const ride = await Ride.findById(rideId)
    .populate('driver', 'vendorId')
    .populate('rider')
    .lean()
  if (!ride || !ride.driverInProgressCancelSettlement) {
    return { ok: false, reason: 'no_settlement' }
  }

  const st = ride.driverInProgressCancelSettlement
  if (st.ledgerFinalizedAt) {
    return { ok: true, alreadyFinalized: true }
  }

  const allowed = ['none_due', 'paid_online', 'cash_acknowledged']
  if (!allowed.includes(st.riderPaymentStatus)) {
    return { ok: false, reason: 'rider_payment_pending' }
  }

  const driverPartial = st.driverPartialAmount || 0
  const penalty = st.riderPenaltyAmount || 0
  const grossFare = roundMoney(driverPartial + penalty)
  const vendorFine = st.vendorFineAmount || 0
  const platformFine = st.platformFineAmount || 0

  const driverId = ride.driver._id || ride.driver
  const riderId = ride.rider._id || ride.rider

  const vehicleSnapshot = await getDriverVehicleSnapshotForEarnings(driverId)

  const rideDocForRefund = await Ride.findById(rideId).populate('rider')
  await applyRefundForDriverInProgressCancel(rideDocForRefund, st)

  const pmSnap = String(ride.paymentMethod || '').toUpperCase()
  await AdminEarnings.findOneAndUpdate(
    { rideId: ride._id },
    {
      rideId: ride._id,
      driverId,
      riderId,
      grossFare,
      platformFee: roundMoney(platformFine),
      driverEarning: roundMoney(driverPartial),
      rideDate: new Date(),
      vehicleSnapshot,
      paymentStatus: 'completed',
      riderFundsStatus: 'captured',
      driverPayoutEligible: true,
      ...(pmSnap ? { paymentMethodSnapshot: pmSnap } : {}),
      settlementType: 'driver_cancel_in_progress',
      vendorFineCredit: roundMoney(vendorFine),
      riderPenaltyAmount: roundMoney(penalty)
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )

  const vendorDocId =
    ride.driver?.vendorId ||
    (await Driver.findById(driverId).select('vendorId').lean())?.vendorId
  if (vendorDocId) {
    try {
      const { syncVendorFinancialFields } = require('../Controllers/Vendor/vendor.controller.js')
      await syncVendorFinancialFields(vendorDocId)
    } catch (e) {
      logger.warn(`finalizeDriverInProgressCancelLedger: vendor sync ${e.message}`)
    }
  }

  await Ride.findByIdAndUpdate(rideId, {
    'driverInProgressCancelSettlement.ledgerFinalizedAt': new Date(),
    cancellationFee: penalty
  })

  try {
    const { getSocketIO } = require('./socket.js')
    const io = getSocketIO()
    io.to(`driver_${driverId}`).emit('driverEarningAdded', {
      driverId: String(driverId),
      rideId: String(rideId),
      driverEarning: driverPartial,
      grossFare,
      platformFee: platformFine,
      settlementType: 'driver_cancel_in_progress'
    })
    const riderSock = ride.userSocketId
    if (riderSock) {
      io.to(riderSock).emit('riderSettlementCompleted', {
        rideId: String(rideId),
        success: true
      })
    }
  } catch (e) {
    logger.warn(`finalizeDriverInProgressCancelLedger: socket emit ${e.message}`)
  }

  return { ok: true }
}

/**
 * Rider: acknowledge no extra charge (or after server auto none_due) — ensures ledger if not yet.
 */
async function riderAcknowledgeDriverInProgressCancel (rideId, userId) {
  const ride = await Ride.findById(rideId).populate('rider')
  if (!ride) throw new Error('Ride not found')
  const rid = ride.rider._id || ride.rider
  if (String(rid) !== String(userId)) throw new Error('Unauthorized')

  const st = ride.driverInProgressCancelSettlement
  if (!st || ride.cancelledBy !== 'driver') {
    throw new Error('No driver in-progress cancellation settlement for this ride')
  }

  if ((st.additionalDue || 0) > 0) {
    throw new Error('Additional payment required; use pay-wallet or Razorpay flow')
  }

  await Ride.findByIdAndUpdate(rideId, {
    'driverInProgressCancelSettlement.riderPaymentStatus': 'none_due'
  })

  return finalizeDriverInProgressCancelLedger(rideId)
}

/**
 * Rider confirms cash payment of additional due.
 */
async function riderConfirmCashDriverInProgressCancel (rideId, userId) {
  const ride = await Ride.findById(rideId).populate('rider')
  if (!ride) throw new Error('Ride not found')
  const rid = ride.rider._id || ride.rider
  if (String(rid) !== String(userId)) throw new Error('Unauthorized')

  const st = ride.driverInProgressCancelSettlement
  if (!st || ride.cancelledBy !== 'driver') {
    throw new Error('No driver in-progress cancellation settlement for this ride')
  }

  if ((st.additionalDue || 0) <= 0) {
    await Ride.findByIdAndUpdate(rideId, {
      'driverInProgressCancelSettlement.riderPaymentStatus': 'none_due'
    })
  } else {
    await Ride.findByIdAndUpdate(rideId, {
      'driverInProgressCancelSettlement.riderPaymentStatus': 'cash_acknowledged'
    })
  }

  return finalizeDriverInProgressCancelLedger(rideId)
}

/**
 * Debit rider wallet for additionalDue then finalize.
 */
async function riderPayWalletDriverInProgressCancel (rideId, userId) {
  const ride = await Ride.findById(rideId).populate('rider')
  if (!ride) throw new Error('Ride not found')
  const rid = ride.rider._id || ride.rider
  if (String(rid) !== String(userId)) throw new Error('Unauthorized')

  const st = ride.driverInProgressCancelSettlement
  if (!st || ride.cancelledBy !== 'driver') {
    throw new Error('No driver in-progress cancellation settlement for this ride')
  }

  const due = st.additionalDue || 0
  if (due <= 0) {
    await Ride.findByIdAndUpdate(rideId, {
      'driverInProgressCancelSettlement.riderPaymentStatus': 'none_due'
    })
    return finalizeDriverInProgressCancelLedger(rideId)
  }

  const user = await User.findById(userId)
  if (!user) throw new Error('User not found')
  const balanceBefore = user.walletBalance || 0
  if (balanceBefore < due) {
    throw new Error('Insufficient wallet balance')
  }

  const existing = await WalletTransaction.findOne({
    relatedRide: ride._id,
    transactionType: 'CANCELLATION_FEE',
    status: 'COMPLETED',
    'metadata.driverInProgressCancelAdditional': true
  })
  if (existing) {
    await Ride.findByIdAndUpdate(rideId, {
      'driverInProgressCancelSettlement.riderPaymentStatus': 'paid_online'
    })
    return finalizeDriverInProgressCancelLedger(rideId)
  }

  const balanceAfter = roundMoney(balanceBefore - due)
  user.walletBalance = balanceAfter
  await user.save()

  await WalletTransaction.create({
    user: userId,
    transactionType: 'CANCELLATION_FEE',
    amount: due,
    balanceBefore,
    balanceAfter,
    relatedRide: ride._id,
    paymentMethod: 'WALLET',
    status: 'COMPLETED',
    description: `Driver cancelled trip — settlement charge ₹${due}`,
    metadata: { driverInProgressCancelAdditional: true }
  })

  await Ride.findByIdAndUpdate(rideId, {
    'driverInProgressCancelSettlement.riderPaymentStatus': 'paid_online'
  })

  return finalizeDriverInProgressCancelLedger(rideId)
}

/**
 * After Razorpay payment for additionalDue — verify and finalize.
 */
async function riderVerifyRazorpayDriverInProgressCancel (rideId, userId, razorpayPaymentId) {
  const ride = await Ride.findById(rideId).populate('rider')
  if (!ride) throw new Error('Ride not found')
  const rid = ride.rider._id || ride.rider
  if (String(rid) !== String(userId)) throw new Error('Unauthorized')

  const st = ride.driverInProgressCancelSettlement
  if (!st || ride.cancelledBy !== 'driver') {
    throw new Error('No driver in-progress cancellation settlement for this ride')
  }

  const due = roundMoney(st.additionalDue || 0)
  if (due <= 0) {
    await Ride.findByIdAndUpdate(rideId, {
      'driverInProgressCancelSettlement.riderPaymentStatus': 'none_due'
    })
    return finalizeDriverInProgressCancelLedger(rideId)
  }

  const payment = await razorpayInstance.payments.fetch(razorpayPaymentId)
  if (payment.status !== 'captured' && payment.status !== 'authorized') {
    throw new Error(`Payment not completed: ${payment.status}`)
  }
  const paid = roundMoney(payment.amount / 100)
  if (Math.abs(paid - due) > 0.02) {
    throw new Error('Payment amount does not match amount due')
  }

  await Ride.findByIdAndUpdate(rideId, {
    'driverInProgressCancelSettlement.riderPaymentStatus': 'paid_online',
    'driverInProgressCancelSettlement.razorpaySettlementPaymentId': razorpayPaymentId
  })

  return finalizeDriverInProgressCancelLedger(rideId)
}

/**
 * Resolve driver position for in-progress cancel threshold (driver → dropoff distance).
 * Prefers fresh driver GPS, then fresh route tail; falls back to stale driver/route with metrics.
 */
function resolveInProgressCancelPositionCoords (ride) {
  const now = Date.now()
  const driverUpdatedAt = ride.driver?.updatedAt
    ? new Date(ride.driver.updatedAt).getTime()
    : 0

  if (
    ride.driver?.location?.coordinates?.length >= 2 &&
    driverUpdatedAt > 0 &&
    now - driverUpdatedAt <= IN_PROGRESS_DRIVER_LOC_MAX_AGE_MS
  ) {
    return {
      coords: ride.driver.location.coordinates,
      source: 'driver_gps_fresh'
    }
  }

  const pts = Array.isArray(ride.routePoints) ? ride.routePoints : []
  if (pts.length > 0) {
    const last = pts[pts.length - 1]
    const rec = last?.recordedAt ? new Date(last.recordedAt).getTime() : 0
    if (
      last?.coordinates?.length >= 2 &&
      rec > 0 &&
      now - rec <= IN_PROGRESS_ROUTE_POINT_MAX_AGE_MS
    ) {
      return { coords: last.coordinates, source: 'route_tail_fresh' }
    }
  }

  if (ride.driver?.location?.coordinates?.length >= 2) {
    logger.info(
      `metric.in_progress_cancel_policy rideId=${ride._id} positionSource=stale_driver_gps`
    )
    return { coords: ride.driver.location.coordinates, source: 'driver_gps_stale' }
  }

  if (pts.length > 0) {
    const last = pts[pts.length - 1]
    if (last?.coordinates?.length >= 2) {
      logger.info(
        `metric.in_progress_cancel_policy rideId=${ride._id} positionSource=stale_route_tail`
      )
      return { coords: last.coordinates, source: 'route_tail_stale' }
    }
  }

  return null
}

const evaluateRideCancellationPolicy = async ({ rideId, actor }) => {
  const ride = await Ride.findById(rideId)
    .select('status dropoffLocation routePoints driver')
    .populate('driver', 'location updatedAt')
    .lean()
  if (!ride) {
    return { allowed: false, code: 'RIDE_NOT_FOUND', message: 'Ride not found' }
  }
  if (ride.status !== 'in_progress') return { allowed: true }
  if (!ENABLE_IN_PROGRESS_THRESHOLD_CANCEL) {
    return { allowed: true }
  }

  if (actor === 'rider') {
    logger.info(
      `metric.in_progress_cancel_policy rideId=${rideId} event=rider_blocked_in_progress`
    )
    return {
      allowed: false,
      code: 'RIDER_CANCEL_BLOCKED_IN_PROGRESS',
      message:
        'You cannot cancel after the trip has started. Contact support if you need help.'
    }
  }

  const dropoffCoords = ride.dropoffLocation?.coordinates
  if (!dropoffCoords || dropoffCoords.length < 2) {
    return { allowed: true }
  }

  const resolved = resolveInProgressCancelPositionCoords(ride)
  if (!resolved?.coords) {
    logger.warn(
      `metric.in_progress_cancel_policy rideId=${rideId} event=driver_blocked_no_position`
    )
    return {
      allowed: false,
      code: 'DRIVER_CANCEL_LOCATION_UNAVAILABLE',
      message:
        'Your location could not be verified. Enable GPS and try again, or move to get a signal.'
    }
  }

  const currentCoords = resolved.coords
  const [curLng, curLat] = currentCoords
  const [dropLng, dropLat] = dropoffCoords
  const distanceKm = calculateHaversineDistance(curLat, curLng, dropLat, dropLng)
  const distanceMeters = Math.round(distanceKm * 1000)

  if (distanceKm > IN_PROGRESS_CANCEL_DISTANCE_THRESHOLD_KM) {
    logger.info(
      `metric.in_progress_cancel_policy rideId=${rideId} event=driver_far_from_drop distanceMeters=${distanceMeters} positionSource=${resolved.source}`
    )
    return {
      allowed: true,
      settlementMode: 'driver_cancel_in_progress_partial',
      meta: { distanceToDropMeters: distanceMeters, positionSource: resolved.source }
    }
  }

  logger.info(
    `metric.in_progress_cancel_policy rideId=${rideId} event=driver_near_drop_full_fare distanceMeters=${distanceMeters} positionSource=${resolved.source}`
  )
  return {
    allowed: true,
    settlementMode: 'driver_cancel_in_progress_full_fare',
    meta: { distanceToDropMeters: distanceMeters, positionSource: resolved.source }
  }
}

const cancelRide = async (
  rideId,
  cancelledBy,
  cancellationReason = null,
  cancellationMeta = {}
) => {
  try {
    // Fetch ride BEFORE updating to get original status for refund calculation
    const originalRide = await Ride.findById(rideId).populate('driver rider')
    if (!originalRide) throw new Error('Ride not found')

    if (originalRide.status === 'cancelled') {
      return await Ride.findById(rideId).populate('driver rider')
    }

    const originalStatus = originalRide.status

    // Normalize cancelledBy so fee logic and logs are consistent
    const validCancelledBy = ['rider', 'driver', 'system']
    const normalizedCancelledBy = (cancelledBy && validCancelledBy.includes(String(cancelledBy).toLowerCase()))
      ? String(cancelledBy).toLowerCase()
      : 'system'
    if (cancelledBy !== normalizedCancelledBy) {
      logger.info(`cancelRide: Normalized cancelledBy from "${cancelledBy}" to "${normalizedCancelledBy}" for ride ${rideId}`)
    }

    let skipStandardRefunds = false
    let driverInProgressSettlementSnapshot = null
    let beforeStartSettlementSnapshot = null

    if (normalizedCancelledBy === 'driver' && originalStatus === 'in_progress') {
      if (
        originalRide.driverInProgressCancelSettlement &&
        originalRide.driverInProgressCancelSettlement.ledgerFinalizedAt
      ) {
        return await Ride.findById(rideId).populate('driver rider')
      }
      driverInProgressSettlementSnapshot = await computeDriverInProgressCancelSettlement(
        originalRide
      )
      skipStandardRefunds = true
    }

    const isBeforeStartOtpWindow = ['accepted', 'arrived', 'upcoming'].includes(
      originalStatus
    )
    if (
      ENABLE_BEFORE_START_PARTIAL_CHARGE &&
      normalizedCancelledBy === 'rider' &&
      isBeforeStartOtpWindow
    ) {
      beforeStartSettlementSnapshot =
        await buildBeforeStartOtpRiderCancelSettlement(originalRide)
      const riderId = originalRide.rider?._id || originalRide.rider
      const walletResult = await settleRiderWalletAndRazorpayForBeforeStartCancel(
        originalRide._id,
        riderId,
        beforeStartSettlementSnapshot,
        originalRide
      )
      beforeStartSettlementSnapshot = {
        ...beforeStartSettlementSnapshot,
        ...walletResult
      }
      logger.info(
        `metric.ride.before_start_cancel_settlement rideId=${rideId} total=${beforeStartSettlementSnapshot.totalCharge} walletDebited=${beforeStartSettlementSnapshot.walletDebited} outstanding=${beforeStartSettlementSnapshot.outstandingDue}`
      )
      skipStandardRefunds = true
    }

    const updateData = {
      status: 'cancelled',
      cancelledBy: normalizedCancelledBy
    }
    updateData.cancellationReasonCode = normalizeCancellationReasonCode(
      cancellationMeta?.reasonCode
    )

    // Add cancellation reason if provided
    if (cancellationReason) {
      updateData.cancellationReason = cancellationReason
    }
    if (cancellationMeta?.requestedPickupShiftMeters || cancellationMeta?.note) {
      const shiftMeters = Number(cancellationMeta?.requestedPickupShiftMeters)
      updateData.cancellationContext = {
        requestedPickupShiftMeters: Number.isFinite(shiftMeters)
          ? shiftMeters
          : null,
        note:
          typeof cancellationMeta?.note === 'string' &&
          cancellationMeta.note.trim()
            ? cancellationMeta.note.trim().slice(0, 500)
            : null
      }
    }

    if (driverInProgressSettlementSnapshot) {
      updateData.driverInProgressCancelSettlement = driverInProgressSettlementSnapshot
      updateData.cancellationFee = driverInProgressSettlementSnapshot.riderPenaltyAmount
    }
    if (beforeStartSettlementSnapshot) {
      updateData.beforeStartCancelSettlement = beforeStartSettlementSnapshot
      updateData.cancellationFee = beforeStartSettlementSnapshot.totalCharge
      if (Number(beforeStartSettlementSnapshot.totalCharge || 0) > 0) {
        updateData.paymentStatus =
          beforeStartSettlementSnapshot.riderPaymentStatus === 'pending'
            ? 'partial'
            : 'completed'
      }
    }

    const ride = await Ride.findByIdAndUpdate(rideId, updateData, {
      new: true
    }).populate('driver rider')
    if (!ride) throw new Error('Ride not found')
      // If a driver was assigned, free them up and remove any locks for this ride
      try {
        if (ride.driver) {
          const driverId = ride.driver._id || ride.driver
          
          // Ensure driver exists before updating
          const driverExists = await Driver.findById(driverId)
            .select('isBusy currentRideId queuedRideId')
            .lean()
          if (!driverExists) {
            logger.warn(`cancelRide: Driver ${driverId} not found, skipping isBusy reset`)
          } else {
            const cancelledRideIdStr = String(ride._id)
            const isCancellingActive =
              String(driverExists.currentRideId || '') === cancelledRideIdStr
            const isCancellingQueued =
              String(driverExists.queuedRideId || '') === cancelledRideIdStr

            if (isCancellingQueued) {
              // The cancelled ride was the driver's queued (next) ride. Just
              // clear queuedRideId; the active ride is unaffected.
              await Driver.findByIdAndUpdate(driverId, { queuedRideId: null })
              logger.info(
                `✅ cancelRide: cleared queuedRideId for driver ${driverId} (queued ride ${rideId} cancelled)`
              )
            } else if (isCancellingActive && driverExists.queuedRideId) {
              // The active ride was cancelled while a queued ride exists.
              // Promote the queued ride into the active slot so the driver
              // continues with their next pickup.
              const queuedId = driverExists.queuedRideId
              await Driver.findByIdAndUpdate(driverId, {
                isBusy: true,
                busyUntil: null,
                currentRideType: 'normal',
                currentRideId: queuedId,
                queuedRideId: null
              })
              logger.info(
                `✅ cancelRide: Driver ${driverId} promoted queued ride ${queuedId} after active cancel`
              )
              try {
                const promoted = await Ride.findById(queuedId).populate(
                  'driver rider'
                )
                if (promoted) {
                  const { getSocketIO } = require('./socket.js')
                  const io = getSocketIO()
                  const promotedSocketId = promoted.driverSocketId
                  const payload = promoted.toObject
                    ? promoted.toObject()
                    : promoted
                  if (promotedSocketId) {
                    io.to(promotedSocketId).emit('rideAssigned', payload)
                  } else {
                    io.to(`driver_${driverId}`).emit('rideAssigned', payload)
                  }
                }
              } catch (promoteErr) {
                logger.warn(
                  `⚠️ Failed to emit rideAssigned for promoted queued ride after active cancel: ${promoteErr.message}`
                )
              }
            } else {
              // Reset isBusy for this cancelled ride (standard path)
              await Driver.findByIdAndUpdate(driverId, {
                isBusy: false,
                busyUntil: null
              })
              
              logger.info(
                `✅ cancelRide: Driver ${driverId} isBusy reset to false after ride ${rideId} cancellation`
              )

              // Validate driver status to check for OTHER active rides
              // This ensures if driver has multiple rides, we only set isBusy=false if no other active rides exist
              const validationResult = await validateAndFixDriverStatus(driverId)
              if (validationResult.corrected) {
                logger.info(
                  `✅ cancelRide: Driver ${driverId} status validated and corrected: ${validationResult.reason}`
                )
              }
            }
          }

          // ============================
          // REDIS CLEANUP (Multi-Instance Safe)
          // ============================
          // Clear all Redis locks related to this ride
          try {
            await clearRideRedisKeys(ride._id)
            logger.info(`✅ Redis cleanup completed for cancelled ride ${ride._id}`)
          } catch (cleanupError) {
            // Don't fail cancellation if cleanup fails - log for monitoring
            logger.warn(`⚠️ Redis cleanup failed for cancelled ride ${ride._id}: ${cleanupError.message}`)
          }
        }
      } catch (err) {
        logger.error(`Error cleaning driver state after cancellation: ${err.message}`)
      }

      // ============================
      // REDIS CLEANUP (Even if no driver assigned)
      // ============================
      // Clear Redis locks even if ride had no driver (worker lock might exist)
      try {
        await clearRideRedisKeys(ride._id)
      } catch (cleanupError) {
        logger.warn(`⚠️ Redis cleanup failed for cancelled ride ${ride._id}: ${cleanupError.message}`)
      }

      // Process refunds based on payment method and payment details
      // Use originalRide with originalStatus for accurate cancellation fee calculation
      try {
        logger.info(
          `cancelRide refund path - rideId: ${rideId}, cancelledBy: ${normalizedCancelledBy}, paymentMethod: ${originalRide.paymentMethod}, originalStatus: ${originalStatus}, skipStandardRefunds: ${skipStandardRefunds}`
        )

        if (skipStandardRefunds && driverInProgressSettlementSnapshot) {
          logger.info(
            `cancelRide: driver in_progress cancel — standard refunds skipped; additionalDue=${driverInProgressSettlementSnapshot.additionalDue}, refundDue=${driverInProgressSettlementSnapshot.refundDue}`
          )
          const refundDue = driverInProgressSettlementSnapshot.refundDue || 0
          if (refundDue > 0) {
            const rideForRefund = await Ride.findById(rideId).populate('rider')
            if (rideForRefund) {
              try {
                await applyRefundForDriverInProgressCancel(
                  rideForRefund,
                  driverInProgressSettlementSnapshot
                )
                logger.info(
                  `cancelRide: prepaid refund applied at cancel for ride ${rideId} (refundDue=${refundDue})`
                )
              } catch (refErr) {
                logger.error(
                  `cancelRide: prepaid refund at cancel failed ride ${rideId}: ${refErr.message}`
                )
              }
            }
          }
          if (driverInProgressSettlementSnapshot.additionalDue <= 0) {
            await finalizeDriverInProgressCancelLedger(rideId)
          }
        } else if (skipStandardRefunds && beforeStartSettlementSnapshot) {
          await creditDriverForBeforeStartCancel(ride, beforeStartSettlementSnapshot)
        } else if (!skipStandardRefunds) {

        // Check for Razorpay payment (either pure RAZORPAY or hybrid with Razorpay portion)
        const hasRazorpayPayment = originalRide.razorpayPaymentId && (originalRide.razorpayAmountPaid > 0 || originalRide.fare > 0)
        const hasWalletPayment = (originalRide.paymentMethod || '').toUpperCase() === 'WALLET' || (originalRide.walletAmountUsed && originalRide.walletAmountUsed > 0)
        
        if (hasRazorpayPayment && hasWalletPayment) {
          // Hybrid payment - refund both portions
          logger.info(`💰 Processing hybrid payment refund for ride ${rideId}`)
          
          // Wallet portion refunded via processWalletRefund
          const walletRefund = await processWalletRefund(originalRide, originalStatus, normalizedCancelledBy, cancellationReason)
          if (walletRefund && walletRefund.refunded) {
            logger.info(`✅ Wallet portion refund processed for cancelled ride ${rideId}: ₹${walletRefund.refundAmount || 0}`)
          } else if (walletRefund && !walletRefund.refunded) {
            logger.warn(`⚠️ Wallet portion refund failed for cancelled ride ${rideId}: ${walletRefund.error || 'Unknown error'}`)
          }
          
          // Razorpay portion refunded via processRazorpayRefund
          const razorpayRefund = await processRazorpayRefund(originalRide, originalStatus, normalizedCancelledBy, cancellationReason)
          if (razorpayRefund && razorpayRefund.refunded) {
            logger.info(`✅ Razorpay portion refund processed for cancelled ride ${rideId}: ₹${razorpayRefund.refundAmount || 0}`)
          } else if (razorpayRefund && !razorpayRefund.refunded) {
            logger.warn(`⚠️ Razorpay portion refund failed for cancelled ride ${rideId}: ${razorpayRefund.error || 'Unknown error'}`)
          }
        } else if (hasRazorpayPayment) {
          // Pure Razorpay payment (including case where user selected wallet but had ₹0 balance)
          logger.info(`💰 Processing Razorpay refund for ride ${rideId}`)
          const refundResult = await processRazorpayRefund(originalRide, originalStatus, normalizedCancelledBy, cancellationReason)
          if (refundResult && refundResult.refunded) {
            logger.info(`✅ Razorpay refund processed for cancelled ride ${rideId}: ₹${refundResult.refundAmount || 0}`)
          } else if (refundResult && !refundResult.refunded) {
            logger.warn(`⚠️ Razorpay refund failed for cancelled ride ${rideId}: ${refundResult.error || 'Unknown error'}`)
          } else if (!refundResult) {
            logger.info(`ℹ️ No Razorpay refund needed for cancelled ride ${rideId}`)
          }
        } else if ((originalRide.paymentMethod || '').toUpperCase() === 'WALLET') {
          // Pure wallet payment
          logger.info(`💰 Processing wallet refund for ride ${rideId}`)
          const refundResult = await processWalletRefund(originalRide, originalStatus, normalizedCancelledBy, cancellationReason)
          if (refundResult && refundResult.refunded) {
            logger.info(`✅ Wallet refund processed for cancelled ride ${rideId}: ₹${refundResult.refundAmount || 0}`)
          } else if (refundResult && !refundResult.refunded) {
            logger.warn(`⚠️ Wallet refund failed for cancelled ride ${rideId}: ${refundResult.error || 'Unknown error'}`)
          }
        } else {
          logger.info(`ℹ️ No refund processing needed for cancelled ride ${rideId} - payment method: ${originalRide.paymentMethod}`)
        }
        }
      } catch (refundError) {
        // Don't fail cancellation if refund fails - log for manual review
        logger.error(`❌ Error processing refund during cancellation: ${refundError.message}`)
        logger.error(`   Stack: ${refundError.stack}`)
      }

      return ride
  } catch (error) {
    throw new Error(`Error cancelling ride: ${error.message}`)
  }
}

// Socket management functions
async function setUserSocket (userId, socketId) {
  return User.findByIdAndUpdate(
    userId,
    { $set: { socketId, isOnline: true, lastSeen: new Date() } },
    { new: true }
  )
}

async function clearUserSocket (userId, socketId) {
  // Clear only if the stored socket matches (prevents clearing a newer connection)
  return User.updateOne(
    { _id: userId, socketId },
    {
      $set: { isOnline: false, lastSeen: new Date() },
      $unset: { socketId: '' }
    }
  )
}

async function setDriverSocket (driverId, socketId) {
  // Only bind socket — do not start an online session here. Ride availability (`isOnline`)
  // is controlled by PATCH /drivers/:id/online-status and driverToggleStatus.
  // Use atomic $set so a concurrent in-memory save() cannot clobber `isOnline` after PATCH.
  const driver = await Driver.findByIdAndUpdate(
    driverId,
    { $set: { socketId, lastSeen: new Date() } },
    { new: true }
  )
  if (!driver) {
    throw new Error('Driver not found')
  }
  return driver
}

async function clearDriverSocket (driverId, socketId) {
  // Only unbind the stale socket id. Do NOT call stopDriverOnlineSession here — that
  // ended the online session on every reconnect (driver flipped offline) and save()
  // could throw on invalid legacy driver docs. Real disconnect uses socket.on('disconnect').
  return Driver.updateOne(
    { _id: driverId, socketId },
    { $unset: { socketId: 1 }, $set: { lastSeen: new Date() } }
  )
}
//end of socket management functions

// OTP Verification Functions
const verifyStartOtp = async (rideId, providedOtp) => {
  try {
    const ride = await Ride.findById(rideId)
    if (!ride) throw new Error('Ride not found')

    // Allow OTP verification when ride is in accepted lifecycle states before trip start.
    // Driver can verify OTP after marking as arrived
    if (ride.status !== 'accepted' && ride.status !== 'arrived' && ride.status !== 'upcoming') {
      throw new Error('Ride is not in accepted, arrived, or upcoming state')
    }

    if (ride.startOtp !== providedOtp) {
      throw new Error('Invalid OTP')
    }

    return { success: true, ride }
  } catch (error) {
    throw new Error(`Error verifying start OTP: ${error.message}`)
  }
}

const verifyStopOtp = async (rideId, providedOtp) => {
  try {
    const ride = await Ride.findById(rideId)
    if (!ride) throw new Error('Ride not found')

    if (ride.status !== 'in_progress') {
      throw new Error('Ride is not in progress')
    }

    if (ride.stopOtp !== providedOtp) {
      throw new Error('Invalid OTP')
    }

    return { success: true, ride }
  } catch (error) {
    throw new Error(`Error verifying stop OTP: ${error.message}`)
  }
}

// Driver arrived at pickup
const markDriverArrived = async rideId => {
  try {
    const ride = await Ride.findByIdAndUpdate(
      rideId,
      {
        $set: {
          driverArrivedAt: new Date(),
          status: 'arrived' // Update status to 'arrived' so rider app UI updates
        }
      },
      { new: true }
    ).populate('driver rider')

    if (!ride) throw new Error('Ride not found')
    return ride
  } catch (error) {
    throw new Error(`Error marking driver arrived: ${error.message}`)
  }
}

// Update ride with actual start time + pickup wait snapshot (server clock)
const updateRideStartTime = async rideId => {
  try {
    const Settings = require('../Models/Admin/settings.modal.js')
    const {
      getPickupWaitPolicyFromSettings,
      buildPickupWaitSnapshot
    } = require('./pickupWaitPricing')

    const settings = await Settings.findOne().lean()
    const policy = getPickupWaitPolicyFromSettings(settings || {})
    const existing = await Ride.findById(rideId)
    if (!existing) throw new Error('Ride not found')

    const end = new Date()
    const pickupWaitSnapshot = buildPickupWaitSnapshot(
      existing.driverArrivedAt,
      end,
      policy
    )

    const ride = await Ride.findByIdAndUpdate(
      rideId,
      {
        actualStartTime: end,
        startOtpVerifiedAt: end,
        pickupWait: pickupWaitSnapshot
      },
      { new: true }
    ).populate('driver rider')

    if (ride.driver) {
      await Driver.findByIdAndUpdate(ride.driver._id, { isBusy: true })
    }

    return ride
  } catch (error) {
    throw new Error(`Error updating ride start time: ${error.message}`)
  }
}

/**
 * Recalculate ride fare based on actual duration
 * @param {string} rideId - Ride ID
 * @returns {Promise<Object>} - Updated fare breakdown
 */
const recalculateRideFare = async (rideId) => {
  try {
    const ride = await Ride.findById(rideId)
    if (!ride) throw new Error('Ride not found')

    if (isIntercityRide(ride)) {
      const Settings = require('../Models/Admin/settings.modal.js')
      const settings = await Settings.findOne()
      if (!settings) throw new Error('Admin settings not found')

      const vehicleType =
        ride.vehicleType || mapServiceToVehicleService(ride.service || 'cercaZip')
      const actualDistance =
        ride.actualDistanceInKm > 0
          ? ride.actualDistanceInKm
          : ride.distanceInKm || ride.estimatedDistanceInKm || 0
      const actualDuration =
        ride.actualDuration !== undefined && ride.actualDuration !== null
          ? ride.actualDuration
          : ride.estimatedDuration || 0

      const intercityBreakdown = calculateIntercityFareBreakdown({
        pickupLocation: ride.pickupLocation,
        dropoffLocation: ride.dropoffLocation,
        durationMinutes: actualDuration,
        vehicleType,
        tripMode: ride.tripMode || 'one_way',
        tollCharges: ride.fareBreakdown?.tollCharges || 0,
        parkingCharges: ride.fareBreakdown?.parkingCharges || 0,
        settings
      })

      const pickupWaitCharge = roundMoney(ride.pickupWait?.totalPickupWaitCharge || 0)
      const finalFare = roundMoney(intercityBreakdown.finalFare + pickupWaitCharge)

      return {
        baseFare: intercityBreakdown.baseFare,
        distanceFare: intercityBreakdown.distanceFare,
        timeFare: 0,
        subtotal: intercityBreakdown.finalFare,
        fareAfterMinimum: intercityBreakdown.finalFare,
        discount: 0,
        pickupWaitCharge,
        finalFare,
        tollCharges: intercityBreakdown.tollCharges,
        parkingCharges: intercityBreakdown.parkingCharges,
        driverAllowance: intercityBreakdown.driverAllowance
      }
    }

    // Skip recalculation for special booking types
    if (ride.bookingType !== 'INSTANT') {
      logger.info(`[Fare Recalculation] Skipping recalculation for booking type: ${ride.bookingType}`)
      const pickupWaitCharge = roundMoney(ride.pickupWait?.totalPickupWaitCharge || 0)
      const baseFare = ride.fare || 0
      return {
        baseFare: ride.fareBreakdown?.baseFare || 0,
        distanceFare: ride.fareBreakdown?.distanceFare || 0,
        timeFare: ride.fareBreakdown?.timeFare || 0,
        subtotal: ride.fareBreakdown?.subtotal ?? baseFare,
        fareAfterMinimum: ride.fareBreakdown?.fareAfterMinimum ?? baseFare,
        discount: ride.discount || 0,
        pickupWaitCharge,
        finalFare: roundMoney(baseFare + pickupWaitCharge)
      }
    }

    // Get settings and vehicle service
    const Settings = require('../Models/Admin/settings.modal.js')
    const settings = await Settings.findOne()
    if (!settings) throw new Error('Admin settings not found')

    const { perKmRate, minimumFare } = settings.pricingConfigurations

    // Get vehicleService from ride document (preferred) or map from service field (backward compatibility)
    let vehicleServiceKey = ride.vehicleService
    let servicePrice = 0
    let perMinuteRate = 0

    if (vehicleServiceKey && settings.vehicleServices?.[vehicleServiceKey]) {
      // Use vehicleService from ride document
      const vehicleService = settings.vehicleServices[vehicleServiceKey]
      servicePrice = vehicleService.price || 0
      perMinuteRate = vehicleService.perMinuteRate || 0
      logger.info(
        `[Fare Recalculation] Using vehicleService from ride: ${vehicleServiceKey}, price: ₹${servicePrice}, perMinuteRate: ₹${perMinuteRate}/min`
      )
    } else if (ride.service) {
      // Fallback: Map from service field (backward compatibility)
      vehicleServiceKey = mapServiceToVehicleService(ride.service)
      const vehicleService = settings.vehicleServices?.[vehicleServiceKey]
      if (!vehicleService) {
        throw new Error(`Vehicle service not found: ${vehicleServiceKey} (mapped from service: ${ride.service})`)
      }
      servicePrice = vehicleService.price || 0
      perMinuteRate = vehicleService.perMinuteRate || 0
      logger.info(
        `[Fare Recalculation] Mapped service "${ride.service}" to vehicleService: ${vehicleServiceKey}, price: ₹${servicePrice}, perMinuteRate: ₹${perMinuteRate}/min`
      )
    } else {
      throw new Error(`Ride missing both vehicleService and service fields: ${rideId}`)
    }

    // Get actual duration (should be calculated by updateRideEndTime or persisted before this call)
    let actualDuration = ride.actualDuration !== undefined ? ride.actualDuration : 0
    const distance = ride.distanceInKm || 0

    // Enhanced logging to verify actualDuration is available
    logger.info(
      `[Fare Recalculation] Recalculating fare for rideId: ${rideId}, distance: ${distance}km, actualDuration: ${actualDuration}min (from DB: ${ride.actualDuration !== undefined ? ride.actualDuration : 'undefined'}), actualStartTime: ${ride.actualStartTime ? ride.actualStartTime.toISOString() : 'not set'}, actualEndTime: ${ride.actualEndTime ? ride.actualEndTime.toISOString() : 'not set'}, perMinuteRate: ₹${perMinuteRate}/min`
    )
    
    // Fallback: Recalculate duration from timestamps if actualDuration is missing or 0 but timestamps exist
    // This handles edge cases where the duration wasn't persisted correctly
    if (actualDuration === 0 && ride.actualStartTime && ride.actualEndTime) {
      const calculatedDuration = Math.round((ride.actualEndTime - ride.actualStartTime) / 60000)
      if (calculatedDuration > 0) {
        logger.warn(
          `[Fare Recalculation] WARNING: actualDuration is 0 but calculated duration from timestamps is ${calculatedDuration}min. Using calculated value as fallback.`
        )
        actualDuration = calculatedDuration
      }
    }

    // Get original fare estimate from ride (before recalculation)
    const originalFare = ride.fare || 0
    const originalEstimatedDuration = ride.estimatedDuration || 0

    // Calculate fare breakdown with actual duration (or fallback calculated duration)
    const fareBreakdown = calculateFareWithTime(
      servicePrice,
      distance,
      actualDuration,
      perKmRate,
      perMinuteRate,
      minimumFare
    )

    // Log fare breakdown details for transparency
    logger.info(
      `[Fare Recalculation] Fare breakdown - baseFare: ₹${fareBreakdown.baseFare}, distanceFare: ₹${fareBreakdown.distanceFare}, timeFare: ₹${fareBreakdown.timeFare} (${actualDuration}min × ₹${perMinuteRate}/min), subtotal: ₹${fareBreakdown.subtotal}, fareAfterMinimum: ₹${fareBreakdown.fareAfterMinimum}`
    )
    
    // Log if timeFare is 0 for rides with actual duration > 0 (shouldn't happen)
    if (actualDuration > 0 && fareBreakdown.timeFare === 0) {
      logger.warn(
        `[Fare Recalculation] WARNING: actualDuration is ${actualDuration}min but timeFare is ₹0. Check perMinuteRate: ₹${perMinuteRate}/min`
      )
    }

    // Re-apply promo code discount if promo code exists
    let discount = 0
    let finalFare = fareBreakdown.fareAfterMinimum

    if (ride.promoCode) {
      const Coupon = require('../Models/Admin/coupon.modal.js')
      const coupon = await Coupon.findOne({
        couponCode: ride.promoCode.toUpperCase().trim()
      })

      if (coupon) {
        // Validate coupon is still valid
        const canUse = coupon.canUserUse(ride.rider._id || ride.rider)
        if (canUse.canUse) {
          // Check service applicability (coupons may use service names or vehicleService keys)
          const serviceApplicable =
            !coupon.applicableServices ||
            coupon.applicableServices.length === 0 ||
            coupon.applicableServices.includes(ride.service) ||
            coupon.applicableServices.includes(vehicleServiceKey)

          if (serviceApplicable) {
            const discountResult = coupon.calculateDiscount(fareBreakdown.fareAfterMinimum)
            if (discountResult.discount > 0) {
              discount = discountResult.discount
              finalFare = discountResult.finalFare
              logger.info(
                `[Fare Recalculation] Promo code ${ride.promoCode} re-applied, discount: ₹${discount}, finalFare: ₹${finalFare}`
              )
            }
          }
        }
      }
    }

    // Cap fare at original estimate if actual duration is shorter than estimated
    // This ensures users don't pay more than they were quoted upfront
    if (originalEstimatedDuration > 0 && actualDuration < originalEstimatedDuration && finalFare > originalFare) {
      logger.info(
        `[Fare Recalculation] Actual duration (${actualDuration}min) shorter than estimated (${originalEstimatedDuration}min). Capping fare at original estimate: ₹${originalFare}`
      )
      finalFare = originalFare
      // Adjust discount proportionally if promo was applied
      if (discount > 0 && ride.fareBreakdown?.discount) {
        const originalDiscount = ride.fareBreakdown.discount || 0
        discount = originalDiscount
      }
    }

    let tripFinalAfterCap = Math.round(finalFare * 100) / 100
    const pickupWaitCharge = roundMoney(ride.pickupWait?.totalPickupWaitCharge || 0)

    const agreedTripFare =
      ride.fareAtBooking != null && ride.fareAtBooking > 0
        ? Number(ride.fareAtBooking)
        : Number(ride.fare || 0)

    const thresholds = getPricingSubstantiveThresholds(settings.pricingConfigurations)
    const estimatedKmForSubstantive =
      ride.estimatedDistanceInKm != null && Number(ride.estimatedDistanceInKm) > 0
        ? Number(ride.estimatedDistanceInKm)
        : 0
    const substantiveEval = evaluateSubstantiveInstantTrip({
      thresholds,
      actualDurationMinutes: actualDuration,
      actualDistanceKm: distance,
      estimatedDistanceKm: estimatedKmForSubstantive
    })
    const instantBooking = ride.bookingType === 'INSTANT' || !ride.bookingType
    const quoteFloorEligible =
      instantBooking && agreedTripFare > 0 && tripFinalAfterCap < agreedTripFare
    const quoteFloorApplied = quoteFloorEligible && substantiveEval.substantiveTrip
    const tripFareBeforeQuoteFloor = tripFinalAfterCap
    if (quoteFloorApplied) {
      tripFinalAfterCap = agreedTripFare
    }
    logger.info('fare.lineage', {
      rideId: String(rideId),
      phase: 'recalculateRideFare_instant_quote_floor',
      substantiveTrip: substantiveEval.substantiveTrip,
      quoteFloorEligible,
      quoteFloorApplied,
      actualDistanceKm: distance,
      estimatedDistanceInKm: estimatedKmForSubstantive,
      actualDurationMinutes: actualDuration,
      estimatedDurationMinutes: originalEstimatedDuration,
      agreedTripFare,
      tripFareBeforeQuoteFloor,
      tripFareAfterQuoteFloor: tripFinalAfterCap,
      minDistanceKmRequired: substantiveEval.minDistanceKmRequired,
      durationOk: substantiveEval.durationOk,
      distanceOk: substantiveEval.distanceOk
    })

    const finalFareWithWait = roundMoney(tripFinalAfterCap + pickupWaitCharge)

    return {
      baseFare: fareBreakdown.baseFare,
      distanceFare: fareBreakdown.distanceFare,
      timeFare: fareBreakdown.timeFare,
      subtotal: fareBreakdown.subtotal,
      fareAfterMinimum: fareBreakdown.fareAfterMinimum,
      discount: Math.round(discount * 100) / 100,
      pickupWaitCharge,
      finalFare: finalFareWithWait
    }
  } catch (error) {
    logger.error(`Error recalculating ride fare for rideId ${rideId}:`, error)
    throw new Error(`Error recalculating ride fare: ${error.message}`)
  }
}

// Update ride with actual end time and calculate duration
// Note: This function does NOT update driver isBusy status
// Driver isBusy is updated in completeRide() AFTER ride status is set to 'completed'
// This prevents race condition where validateAndFixDriverStatus sees ride as 'in_progress'
const updateRideEndTime = async rideId => {
  try {
    const ride = await Ride.findById(rideId)
    if (!ride) throw new Error('Ride not found')

    const endTime = new Date()
    const actualDuration = ride.actualStartTime
      ? Math.round((endTime - ride.actualStartTime) / 60000) // in minutes
      : 0

    const updatedRide = await Ride.findByIdAndUpdate(
      rideId,
      {
        actualEndTime: endTime,
        actualDuration: actualDuration,
        stopOtpVerifiedAt: endTime
      },
      { new: true }
    ).populate('driver rider')

    // Note: Driver isBusy is NOT updated here to avoid race condition
    // It will be updated in completeRide() after ride status is set to 'completed'

    return updatedRide
  } catch (error) {
    throw new Error(`Error updating ride end time: ${error.message}`)
  }
}

// Driver Status Validation Function
/**
 * Validates and fixes driver isBusy status based on actual active rides
 * Rule: isBusy should ONLY be true if driver has active rides
 * Active ride statuses: requested, accepted, arrived, in_progress
 * @param {string} driverId - Driver ID to validate
 * @returns {Promise<Object>} Validation result with correction details
 */
const validateAndFixDriverStatus = async driverId => {
  try {
    if (!driverId) {
      throw new Error('Driver ID is required')
    }

    // Get current driver status
    const driver = await Driver.findById(driverId)
    if (!driver) {
      logger.warn(`validateAndFixDriverStatus: Driver not found - driverId: ${driverId}`)
      return { corrected: false, reason: 'Driver not found' }
    }

    // Query for active rides assigned to this driver
    // EXCLUDE the destination-reach queued ride: it is 'accepted' but the
    // driver is still busy on a different currentRideId, so it must not be
    // treated as an additional active ride for isBusy purposes.
    const activeRideQuery = {
      driver: driverId,
      status: { $in: ['requested', 'accepted', 'arrived', 'in_progress'] }
    }
    if (driver.queuedRideId) {
      activeRideQuery._id = { $ne: driver.queuedRideId }
    }
    const activeRides = await Ride.find(activeRideQuery)
      .select('_id status bookingType')
      .lean()

    const hasActiveRides = activeRides.length > 0
    const currentIsBusy = driver.isBusy || false

    // Rule: isBusy should ONLY be true if driver has active rides
    if (!hasActiveRides && currentIsBusy) {
      // Driver is marked busy but has no active rides - reset to not busy
      await Driver.findByIdAndUpdate(driverId, {
        isBusy: false,
        busyUntil: null
      })

      logger.info(
        `✅ [Status Validation] Driver ${driverId} status corrected: isBusy ${currentIsBusy} → false (no active rides found)`
      )

      return {
        corrected: true,
        previousStatus: { isBusy: currentIsBusy },
        newStatus: { isBusy: false },
        reason: 'No active rides found but driver was marked as busy',
        activeRidesCount: 0
      }
    } else if (hasActiveRides && !currentIsBusy) {
      // Driver has active rides but is not marked busy - set to busy (for INSTANT rides)
      // Check if any active ride is INSTANT type
      const hasInstantRide = activeRides.some(
        ride => ride.bookingType === 'INSTANT'
      )

      if (hasInstantRide) {
        await Driver.findByIdAndUpdate(driverId, {
          isBusy: true
        })

        logger.info(
          `✅ [Status Validation] Driver ${driverId} status corrected: isBusy ${currentIsBusy} → true (has active INSTANT ride)`
        )

        return {
          corrected: true,
          previousStatus: { isBusy: currentIsBusy },
          newStatus: { isBusy: true },
          reason: 'Has active INSTANT ride but was not marked as busy',
          activeRidesCount: activeRides.length
        }
      } else {
        // FULL_DAY/RENTAL rides - driver might not need to be busy
        logger.info(
          `ℹ️ [Status Validation] Driver ${driverId} has active FULL_DAY/RENTAL rides but isBusy=false (expected behavior)`
        )

        return {
          corrected: false,
          reason: 'Has active FULL_DAY/RENTAL rides, isBusy=false is correct',
          activeRidesCount: activeRides.length
        }
      }
    } else {
      // Status is consistent
      logger.debug(
        `✓ [Status Validation] Driver ${driverId} status is consistent: isBusy=${currentIsBusy}, activeRides=${activeRides.length}`
      )

      return {
        corrected: false,
        reason: 'Status is consistent',
        activeRidesCount: activeRides.length,
        isBusy: currentIsBusy
      }
    }
  } catch (error) {
    logger.error(
      `❌ [Status Validation] Error validating driver status for ${driverId}: ${error.message}`
    )
    throw new Error(`Error validating driver status: ${error.message}`)
  }
}

// Rating Functions
const submitRating = async ratingData => {
  try {
    const {
      rideId,
      ratedBy,
      ratedByModel,
      ratedTo,
      ratedToModel,
      rating,
      review,
      tags
    } = ratingData

    const RatedByModel = ratedByModel === 'Driver' ? Driver : User
    const RatedToModel = ratedToModel === 'Driver' ? Driver : User

    const [ratedByEntity, ratedToEntity] = await Promise.all([
      RatedByModel.findById(ratedBy).select('name fullName phone phoneNumber email'),
      RatedToModel.findById(ratedTo).select('name fullName phone phoneNumber email')
    ])

    // Check if rating already exists
    const existingRating = await Rating.findOne({
      ride: rideId,
      ratedBy,
      ratedByModel
    })

    if (existingRating) {
      throw new Error('Rating already submitted for this ride')
    }

    // Create rating
    const newRating = await Rating.create({
      ride: rideId,
      ratedBy,
      ratedByModel,
      ratedTo,
      ratedToModel,
      rating,
      review,
      tags,
      ratedBySnapshot: ratedByEntity
        ? {
            name: ratedByEntity.name || ratedByEntity.fullName || null,
            phone: ratedByEntity.phone || ratedByEntity.phoneNumber || null,
            email: ratedByEntity.email || null
          }
        : {},
      ratedToSnapshot: ratedToEntity
        ? {
            name: ratedToEntity.name || ratedToEntity.fullName || null,
            phone: ratedToEntity.phone || ratedToEntity.phoneNumber || null,
            email: ratedToEntity.email || null
          }
        : {}
    })

    // Update ride with rating
    if (ratedByModel === 'User') {
      await Ride.findByIdAndUpdate(rideId, { driverRating: rating })
    } else {
      await Ride.findByIdAndUpdate(rideId, { riderRating: rating })
    }

    // Calculate and update average rating
    await updateAverageRating(ratedTo, ratedToModel)

    return newRating
  } catch (error) {
    throw new Error(`Error submitting rating: ${error.message}`)
  }
}

const updateAverageRating = async (entityId, entityModel) => {
  try {
    const ratings = await Rating.find({
      ratedTo: entityId,
      ratedToModel: entityModel
    })

    if (ratings.length === 0) return

    const totalRating = ratings.reduce((sum, r) => sum + r.rating, 0)
    const averageRating = (totalRating / ratings.length).toFixed(2)

    const Model = entityModel === 'Driver' ? Driver : User
    await Model.findByIdAndUpdate(entityId, {
      rating: averageRating,
      totalRatings: ratings.length
    })
  } catch (error) {
    throw new Error(`Error updating average rating: ${error.message}`)
  }
}

// Messaging Functions
const saveMessage = async messageData => {
  try {
    const {
      rideId,
      senderId,
      senderModel,
      receiverId,
      receiverModel,
      message,
      messageType
    } = messageData

    const newMessage = await Message.create({
      ride: rideId,
      sender: senderId,
      senderModel,
      receiver: receiverId,
      receiverModel,
      message,
      messageType: messageType || 'text'
    })

    return newMessage
  } catch (error) {
    throw new Error(`Error saving message: ${error.message}`)
  }
}

const markMessageAsRead = async messageId => {
  try {
    const message = await Message.findByIdAndUpdate(
      messageId,
      { isRead: true },
      { new: true }
    )
    return message
  } catch (error) {
    throw new Error(`Error marking message as read: ${error.message}`)
  }
}

const getRideMessages = async rideId => {
  try {
    const messages = await Message.find({ ride: rideId })
      .sort({ createdAt: 1 })
      .populate('sender', 'name fullName')
      .populate('receiver', 'name fullName')
    return messages
  } catch (error) {
    throw new Error(`Error fetching messages: ${error.message}`)
  }
}

// Notification Functions
const createNotification = async notificationData => {
  try {
    const {
      recipientId,
      recipientModel,
      title,
      message,
      type,
      relatedRide,
      data
    } = notificationData

    const notification = await Notification.create({
      recipient: recipientId,
      recipientModel,
      title,
      message,
      type,
      relatedRide,
      data
    })

    return notification
  } catch (error) {
    throw new Error(`Error creating notification: ${error.message}`)
  }
}

const markNotificationAsRead = async notificationId => {
  try {
    const notification = await Notification.findByIdAndUpdate(
      notificationId,
      { isRead: true },
      { new: true }
    )
    return notification
  } catch (error) {
    throw new Error(`Error marking notification as read: ${error.message}`)
  }
}

const getUserNotifications = async (userId, userModel) => {
  try {
    const notifications = await Notification.find({
      recipient: userId,
      recipientModel: userModel
    })
      .sort({ createdAt: -1 })
      .limit(50)
    return notifications
  } catch (error) {
    throw new Error(`Error fetching notifications: ${error.message}`)
  }
}

// Emergency Functions
// Normalize location: accept { latitude, longitude } or { coordinates: [lng, lat] }
const normalizeEmergencyLocation = (location) => {
  if (!location) return null
  if (typeof location.latitude === 'number' && typeof location.longitude === 'number') {
    return { longitude: location.longitude, latitude: location.latitude }
  }
  if (Array.isArray(location.coordinates) && location.coordinates.length >= 2) {
    const [lng, lat] = location.coordinates
    return { longitude: lng, latitude: lat }
  }
  return null
}

const createEmergencyAlert = async emergencyData => {
  try {
    const {
      rideId,
      triggeredBy,
      triggeredByModel,
      location,
      reason,
      description
    } = emergencyData

    const normalized = normalizeEmergencyLocation(location)
    if (!normalized) {
      throw new Error('Invalid location: provide latitude/longitude or coordinates array')
    }

    const emergency = await Emergency.create({
      ride: rideId,
      triggeredBy,
      triggeredByModel,
      location: {
        type: 'Point',
        coordinates: [normalized.longitude, normalized.latitude]
      },
      reason: reason || 'other',
      description: description || ''
    })

    // Update ride status
    await Ride.findByIdAndUpdate(rideId, {
      status: 'cancelled',
      cancelledBy: 'system',
      cancellationReason: `Emergency: ${reason}`
    })

    // Free driver and clear Redis (same as cancelRide) so driver is available for next ride
    const ride = await Ride.findById(rideId).populate('driver').lean()
    const driverId = ride && ride.driver && (ride.driver._id || ride.driver)
    if (driverId) {
      try {
        const driverExists = await Driver.findById(driverId)
        if (!driverExists) {
          logger.warn(`createEmergencyAlert: Driver ${driverId} not found, skipping isBusy reset`)
        } else {
          await Driver.findByIdAndUpdate(driverId, {
            isBusy: false,
            busyUntil: null
          })
          logger.info(
            `✅ createEmergencyAlert: Driver ${driverId} isBusy reset to false after emergency for ride ${rideId}`
          )
          const validationResult = await validateAndFixDriverStatus(driverId)
          if (validationResult.corrected) {
            logger.info(
              `✅ createEmergencyAlert: Driver ${driverId} status validated and corrected: ${validationResult.reason}`
            )
          }
        }
      } catch (err) {
        logger.error(`Error cleaning driver state after emergency: ${err.message}`)
      }
    }

    // Always clear Redis for this ride (worker/lock keys) even when no driver was assigned
    try {
      await clearRideRedisKeys(rideId)
      logger.info(`✅ Redis cleanup completed for ride ${rideId} after emergency`)
    } catch (cleanupError) {
      logger.warn(`⚠️ Redis cleanup failed for ride ${rideId} after emergency: ${cleanupError.message}`)
    }

    return emergency
  } catch (error) {
    throw new Error(`Error creating emergency alert: ${error.message}`)
  }
}

const resolveEmergency = async emergencyId => {
  try {
    const emergency = await Emergency.findByIdAndUpdate(
      emergencyId,
      {
        status: 'resolved',
        resolvedAt: new Date()
      },
      { new: true }
    )
    return emergency
  } catch (error) {
    throw new Error(`Error resolving emergency: ${error.message}`)
  }
}

// Auto-assign driver to ride
const autoAssignDriver = async (rideId, pickupLocation, maxDistance = 5000) => {
  try {
    const drivers = await Driver.find({
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: pickupLocation.coordinates
          },
          $maxDistance: maxDistance // meters
        }
      },
      isActive: true,
      isBusy: false,
      isOnline: true
    }).limit(5)

    return drivers
  } catch (error) {
    throw new Error(`Error auto-assigning driver: ${error.message}`)
  }
}

// Search drivers with progressive radius expansion
// options (optional): { priorityOnly: true|false, excludeDriverIds: [ObjectId], dropoffLocation }
const searchDriversWithProgressiveRadius = async (
  pickupLocation,
  radii = [3000, 6000, 9000, 12000, 15000, 20000],
  bookingType = null, // Optional: 'INSTANT', 'FULL_DAY', 'RENTAL', 'DATE_WISE'
  vehicleType = null, // Optional: 'sedan', 'suv', 'hatchback', 'auto' - filters drivers by vehicle type
  options = null // Optional: { priorityOnly: true|false, excludeDriverIds: [ObjectId], dropoffLocation } - when omitted, behavior is unchanged
) => {
  try {
    // Ensure pickupLocation has coordinates array
    const coordinates = pickupLocation.coordinates || [
      pickupLocation.longitude,
      pickupLocation.latitude
    ]

    // Validate coordinate format
    if (!Array.isArray(coordinates) || coordinates.length !== 2) {
      throw new Error(
        `Invalid coordinates format: expected [longitude, latitude], got ${JSON.stringify(
          coordinates
        )}`
      )
    }

    const [longitude, latitude] = coordinates

    // Validate longitude range (-180 to 180)
    if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
      throw new Error(
        `Invalid longitude: ${longitude} (must be between -180 and 180)`
      )
    }

    // Validate latitude range (-90 to 90)
    if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
      throw new Error(
        `Invalid latitude: ${latitude} (must be between -90 and 90)`
      )
    }

    // Log coordinate format for debugging
    logger.info(`🔍 Starting driver search with progressive radius`)
    logger.info(`   Pickup location coordinates: [${longitude}, ${latitude}]`)
    logger.info(`   Coordinate format: [longitude, latitude] ✓`)
    logger.info(
      `   Longitude: ${longitude} (valid: ${
        longitude >= -180 && longitude <= 180 ? '✓' : '✗'
      })`
    )
    logger.info(
      `   Latitude: ${latitude} (valid: ${
        latitude >= -90 && latitude <= 90 ? '✓' : '✗'
      })`
    )
    logger.info(`   Radii to try: ${radii.join(', ')} meters`)

    // Try each radius sequentially
    for (const radius of radii) {
      logger.info(`   🔎 Searching within ${radius}m radius...`)

      // First, find all drivers within radius (no filters) for debugging
      const allDriversInRadius = await Driver.find({
        location: {
          $near: {
            $geometry: {
              type: 'Point',
              coordinates: coordinates
            },
            $maxDistance: radius
          }
        }
      })
        .select('isActive isBusy isOnline socketId location') // Select fields needed for logging
        .limit(50) // Get more for debugging

      logger.info(
        `   📊 Found ${allDriversInRadius.length} total drivers within ${radius}m radius (before filters)`
      )

      // Build query - for Full Day/Rental bookings, also include drivers busy with future scheduled bookings
      const now = new Date()
      const driverQuery = {
        location: {
          $near: {
            $geometry: {
              type: 'Point',
              coordinates: coordinates
            },
            $maxDistance: radius // meters
          }
        },
        isActive: true,
        isOnline: true,
        socketId: { $exists: true, $ne: null, $ne: '' } // Only drivers with valid socketId (connected)
      }

      // For Full Day/Rental bookings, allow drivers who are busy but only have future scheduled bookings
      if (bookingType === 'FULL_DAY' || bookingType === 'RENTAL') {
        driverQuery.$or = [
          { isBusy: false }, // Not busy at all
          {
            // Busy but only with future scheduled bookings (busyUntil is in the future)
            isBusy: true,
            busyUntil: { $exists: true, $gt: now }
          }
        ]
      } else {
        // For instant rides, only include drivers who are not busy
        driverQuery.isBusy = false
      }

      // Priority driver filter (only when options passed - backward compatible)
      if (options && typeof options.priorityOnly === 'boolean') {
        if (options.priorityOnly) {
          driverQuery.isPriorityDriver = true
          logger.info(`   ⭐ Filtering priority drivers only`)
        } else {
          driverQuery.isPriorityDriver = { $ne: true }
          logger.info(`   ⭐ Excluding priority drivers (normal phase)`)
        }
      }
      if (options && Array.isArray(options.excludeDriverIds) && options.excludeDriverIds.length > 0) {
        driverQuery._id = { $nin: options.excludeDriverIds }
        logger.info(`   🚫 Excluding ${options.excludeDriverIds.length} driver(s) (e.g. already rejected)`)
      }

      // Now apply filters - including socketId to ensure only connected drivers
      let drivers = await Driver.find(driverQuery)
        .select('socketId goTo location vehicleInfo assignedFleetVehicleId rideAccess') // Select ride-access and vehicle state for eligibility filtering
        .limit(50) // Pull a wider pool, then filter down by ride access

      // Mark Pool A candidates as standard offers (non-stacked).
      drivers.forEach(d => {
        d._isDestinationReach = false
      })

      const filterDescription = (() => {
        let desc = 'isActive: true, isOnline: true, socketId exists'
        if (bookingType === 'FULL_DAY' || bookingType === 'RENTAL') {
          desc += ', isBusy: false OR (isBusy: true with future busyUntil)'
        } else {
          desc += ', isBusy: false'
        }
        if (vehicleType) {
          desc += `, requestedVehicleType: ${vehicleType}`
        }
        return desc
      })()

      if (vehicleType) {
        const eligibleDrivers = []
        for (const driver of drivers) {
          const canAccept = await driverCanAcceptRideType(driver, vehicleType)
          if (canAccept) {
            eligibleDrivers.push(driver)
          }
        }
        logger.info(
          `   🚗 Filtered ${drivers.length - eligibleDrivers.length} driver(s) by ride access for requested type: ${vehicleType}`
        )
        drivers = eligibleDrivers
      }

      logger.info(
        `   ✅ Found ${drivers.length} drivers after applying filters (${filterDescription})`
      )

      // ============================
      // POOL B — destination-reach stacked candidates (INSTANT only)
      // ============================
      // Drivers who are currently busy on a normal INSTANT ride, do not yet
      // have a queued ride, and whose live location is within the admin
      // configured radius of THEIR active drop-off. These are eligible to
      // receive the new offer with offerContext='destination_reach' so it can
      // be queued as their next trip.
      if (bookingType === 'INSTANT') {
        try {
          const SettingsForStacked = require('../Models/Admin/settings.modal.js')
          const stackedSettings = await SettingsForStacked.findOne().lean()
          const stackedEnabled =
            stackedSettings?.rideMatching?.stackedAccept?.enabled !== false
          const destinationReachRadiusM = Number(
            stackedSettings?.rideMatching?.destinationReachRadiusMeters
          )

          if (
            stackedEnabled &&
            Number.isFinite(destinationReachRadiusM) &&
            destinationReachRadiusM > 0
          ) {
            const poolBQuery = {
              ...driverQuery,
              isBusy: true,
              currentRideType: 'normal',
              currentRideId: { $ne: null },
              queuedRideId: null
            }
            // Reset the isBusy: false from the INSTANT branch above (and any
            // FULL_DAY/RENTAL $or that overrides isBusy).
            delete poolBQuery.$or

            let busyCandidates = await Driver.find(poolBQuery)
              .select(
                'socketId goTo location vehicleInfo assignedFleetVehicleId rideAccess currentRideId'
              )
              .limit(50)

            if (vehicleType && busyCandidates.length) {
              const filteredByVehicle = []
              for (const d of busyCandidates) {
                if (await driverCanAcceptRideType(d, vehicleType)) {
                  filteredByVehicle.push(d)
                }
              }
              busyCandidates = filteredByVehicle
            }

            if (busyCandidates.length) {
              const activeRideIds = busyCandidates
                .map(d => d.currentRideId)
                .filter(Boolean)
              const activeRides = await Ride.find({
                _id: { $in: activeRideIds }
              })
                .select('_id status dropoffLocation')
                .lean()
              const activeRideById = new Map(
                activeRides.map(r => [String(r._id), r])
              )

              const poolBDrivers = []
              const existingIds = new Set(drivers.map(d => String(d._id)))
              for (const d of busyCandidates) {
                if (existingIds.has(String(d._id))) continue
                const activeRide = activeRideById.get(String(d.currentRideId))
                if (!activeRide?.dropoffLocation?.coordinates) continue
                if (
                  !['accepted', 'arrived', 'in_progress'].includes(
                    activeRide.status
                  )
                ) {
                  continue
                }
                const driverCoords = d.location?.coordinates
                if (!Array.isArray(driverCoords) || driverCoords.length !== 2) {
                  continue
                }
                const [dLng, dLat] = driverCoords
                const [adLng, adLat] = activeRide.dropoffLocation.coordinates
                const distKm = calculateHaversineDistance(
                  dLat,
                  dLng,
                  adLat,
                  adLng
                )
                const distM = distKm * 1000
                if (distM <= destinationReachRadiusM) {
                  d._isDestinationReach = true
                  poolBDrivers.push(d)
                }
              }

              if (poolBDrivers.length) {
                logger.info(
                  `   🎯 Pool B: ${poolBDrivers.length} destination-reach stacked candidate(s) within ${destinationReachRadiusM}m of their active drop-off`
                )
                drivers = drivers.concat(poolBDrivers)
              }
            }
          } else {
            logger.info(
              `   ℹ️ Stacked accept disabled (enabled=${stackedEnabled}, radius=${destinationReachRadiusM})`
            )
          }
        } catch (e) {
          logger.warn(
            `   ⚠️ Pool B (destination-reach) search failed: ${e.message}`
          )
        }
      }

      if (options?.dropoffLocation && drivers.length > 0) {
        const routeFilteredDrivers = []
        let goToExcludedCount = 0

        for (const driver of drivers) {
          const goToDecision = isGoToRideEligible(
            driver.goTo,
            pickupLocation,
            options.dropoffLocation
          )

          if (goToDecision.eligible) {
            routeFilteredDrivers.push(driver)
            continue
          }

          goToExcludedCount += 1
          logger.info(
            `   GO TO excluded driver ${driver._id} (${goToDecision.reason})`
          )
        }

        if (goToExcludedCount > 0) {
          logger.info(
            `   GO TO filter excluded ${goToExcludedCount} driver(s) in ${radius}m radius`
          )
        }

        drivers = routeFilteredDrivers
      }

      // Log how many drivers have socketId
      const driversWithSocketId = drivers.filter(
        d => d.socketId && d.socketId.trim() !== ''
      ).length
      if (drivers.length > 0) {
        logger.info(
          `   📊 Drivers with valid socketId: ${driversWithSocketId} out of ${drivers.length}`
        )
      }

      // Log details about excluded drivers for debugging
      if (allDriversInRadius.length > 0 && drivers.length === 0) {
        logger.warn(
          `   ⚠️ All ${allDriversInRadius.length} drivers were excluded by filters. Details:`
        )

        // Count drivers excluded by each filter
        const excludedByIsActive = allDriversInRadius.filter(
          d => !d.isActive
        ).length
        const excludedByIsBusy = allDriversInRadius.filter(d => d.isBusy).length
        const excludedByIsOnline = allDriversInRadius.filter(
          d => !d.isOnline
        ).length
        const excludedBySocketId = allDriversInRadius.filter(
          d => !d.socketId || d.socketId.trim() === ''
        ).length

        logger.warn(`      - Excluded by isActive=false: ${excludedByIsActive}`)
        logger.warn(`      - Excluded by isBusy=true: ${excludedByIsBusy}`)
        logger.warn(`      - Excluded by isOnline=false: ${excludedByIsOnline}`)
        logger.warn(`      - Excluded by socketId missing/empty: ${excludedBySocketId}`)

        // Show details of first few excluded drivers
        const excludedDrivers = allDriversInRadius.slice(0, 5)
        excludedDrivers.forEach((driver, index) => {
          // Mask socketId for security (show first 8 chars and last 4 chars)
          const socketIdDisplay = driver.socketId
            ? `${driver.socketId.substring(0, 8)}...${driver.socketId.substring(driver.socketId.length - 4)}`
            : 'MISSING'

          // Determine which specific filter excluded this driver
          const exclusionReasons = []
          if (!driver.isActive) exclusionReasons.push('isActive=false')
          if (driver.isBusy) exclusionReasons.push('isBusy=true')
          if (!driver.isOnline) exclusionReasons.push('isOnline=false')
          if (!driver.socketId || driver.socketId.trim() === '') {
            exclusionReasons.push('socketId missing/empty')
          }

          logger.warn(`      Driver ${index + 1} (${driver._id}):`)
          logger.warn(`        - Excluded by: ${exclusionReasons.join(', ') || 'unknown'}`)
          logger.warn(`        - isActive: ${driver.isActive}`)
          logger.warn(`        - isBusy: ${driver.isBusy}`)
          logger.warn(`        - isOnline: ${driver.isOnline}`)
          logger.warn(`        - socketId: ${socketIdDisplay}`)
          logger.warn(
            `        - Location: [${driver.location.coordinates[0]}, ${driver.location.coordinates[1]}]`
          )
        })
      }

      // If drivers found, return them immediately
      if (drivers.length > 0) {
        logger.info(
          `   ✅ Successfully found ${drivers.length} available drivers within ${radius}m radius`
        )
        return { drivers, radiusUsed: radius }
      }
    }

    // No drivers found in any radius
    logger.warn(
      `   ❌ No drivers found after searching all radii (up to ${
        radii[radii.length - 1]
      }m)`
    )
    return { drivers: [], radiusUsed: radii[radii.length - 1] }
  } catch (error) {
    logger.error(
      `❌ Error searching drivers with progressive radius: ${error.message}`
    )
    logger.error(`   Stack: ${error.stack}`)
    throw new Error(
      `Error searching drivers with progressive radius: ${error.message}`
    )
  }
}

// Exporting functions for use in other modules
/**
 * Get upcoming scheduled bookings for a driver
 */
const getUpcomingBookingsForDriver = async driverId => {
  try {
    const now = new Date()
    const upcomingBookings = await Ride.find({
      driver: driverId,
      $or: [
        { status: 'accepted', bookingType: { $ne: 'INSTANT' } },
        { status: 'accepted', rideType: 'intercity', scheduleType: 'scheduled' },
        { status: 'upcoming', rideType: 'intercity' }
      ],
      $and: [
        {
          $or: [
            { 'bookingMeta.startTime': { $gt: now } },
            { scheduledAt: { $gt: now } },
            { rideType: 'intercity' } // Include all intercity rides regardless of time
          ]
        }
      ]
    })
      .populate('rider', 'fullName name phone email')
      .sort({ scheduledAt: 1, 'bookingMeta.startTime': 1 })

    return upcomingBookings
  } catch (error) {
    logger.error('Error getting upcoming bookings:', error)
    throw new Error(`Error getting upcoming bookings: ${error.message}`)
  }
}

/**
 * Get upcoming scheduled bookings for a user
 */
const getUpcomingBookingsForUser = async userId => {
  try {
    const now = new Date()
    const upcomingBookings = await Ride.find({
      rider: userId,
      $or: [
        { status: 'accepted', bookingType: { $ne: 'INSTANT' } },
        { status: 'accepted', rideType: 'intercity', scheduleType: 'scheduled' },
        { status: 'upcoming', rideType: 'intercity' }
      ],
      $and: [
        {
          $or: [
            { 'bookingMeta.startTime': { $gt: now } },
            { scheduledAt: { $gt: now } },
            { rideType: 'intercity' } // Include all intercity rides regardless of time
          ]
        }
      ]
    })
      .populate('driver', 'name phone rating totalTrips profilePic vehicleInfo')
      .sort({ scheduledAt: 1, 'bookingMeta.startTime': 1 })

    return upcomingBookings
  } catch (error) {
    logger.error('Error getting upcoming bookings for user:', error)
    throw new Error(`Error getting upcoming bookings for user: ${error.message}`)
  }
}

/**
 * Get scheduled rides that need to start
 */
const getScheduledRidesToStart = async () => {
  try {
    const now = new Date()
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000)

    const scheduledRides = await Ride.find({
      $or: [
        { bookingType: { $ne: 'INSTANT' } },
        { rideType: 'intercity', scheduleType: 'scheduled' }
      ],
      rideType: { $ne: 'intercity' },
      status: 'accepted',
      'bookingMeta.startTime': {
        $lte: now,
        $gte: fiveMinutesAgo
      }
    }).populate('driver rider')

    return scheduledRides
  } catch (error) {
    logger.error('Error getting scheduled rides to start:', error)
    throw new Error(`Error getting scheduled rides: ${error.message}`)
  }
}

module.exports = {
  updateDriverStatus,
  updateDriverLocation,
  searchNearbyDrivers,
  mapServiceToVehicleService,
  mapVehicleServiceToDriverType,
  mapServiceToDriverType,
  normalizeRideAccessPreferences,
  getRideAccessDefaultsForVehicleType,
  resolveDriverVehicleType,
  getDriverRideAccessProfile,
  driverCanAcceptRideType,
  calculateFareWithTime,
  getPricingSubstantiveThresholds,
  evaluateSubstantiveInstantTrip,
  calculateHaversineDistance,
  createRide,
  assignDriverToRide,
  assignStackedDriverToRide,
  startRide,
  completeRide,
  cancelRide,
  processWalletRefund,
  processRazorpayRefund,
  setUserSocket,
  clearUserSocket,
  setDriverSocket,
  clearDriverSocket,
  toLngLat,
  verifyStartOtp,
  verifyStopOtp,
  markDriverArrived,
  updateRideStartTime,
  updateRideEndTime,
  submitRating,
  updateAverageRating,
  saveMessage,
  markMessageAsRead,
  getRideMessages,
  createNotification,
  markNotificationAsRead,
  getUserNotifications,
  createEmergencyAlert,
  resolveEmergency,
  autoAssignDriver,
  getUpcomingBookingsForDriver,
  getUpcomingBookingsForUser,
  getScheduledRidesToStart,
  searchDriversWithProgressiveRadius,
  calculateIntercityFareBreakdown,
  getIntercityPricingConfig,
  getIntercityEligibleDrivers,
  validateAndFixDriverStatus,
  recalculateRideFare,
  // Redis cleanup utilities (multi-instance safe)
  clearRideRedisKeys,
  checkAndCleanStaleRideLocks,
  clearRideLock,
  clearWorkerLock,
  appendRideRoutePoint,
  evaluateRideCancellationPolicy,
  toRiderInProgressCancelBillingSummary,
  toRiderBeforeStartCancelBillingSummary,
  impliedPerKmFromBooking,
  computeDriverInProgressCancelSettlement,
  finalizeDriverInProgressCancelLedger,
  riderAcknowledgeDriverInProgressCancel,
  riderConfirmCashDriverInProgressCancel,
  riderPayWalletDriverInProgressCancel,
  riderVerifyRazorpayDriverInProgressCancel,
  getPendingDriverInProgressCancelSettlements,
  normalizeCancellationReasonCode,
  shouldBlockCancelWithinDropRadius,
  CANCEL_BLOCK_WITHIN_DROP_RADIUS_METERS,
  PICKUP_SHIFT_REASON_THRESHOLD_METERS,
  BEFORE_START_FIXED_PENALTY_RUPEES,
  IN_PROGRESS_CANCEL_DISTANCE_THRESHOLD_KM
}
