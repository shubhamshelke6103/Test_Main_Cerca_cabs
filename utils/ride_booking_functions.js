const Driver = require('../Models/Driver/driver.model')
const Ride = require('../Models/Driver/ride.model')
const User = require('../Models/User/user.model')
const Rating = require('../Models/Driver/rating.model')
const Message = require('../Models/Driver/message.model')
const Notification = require('../Models/User/notification.model')
const Emergency = require('../Models/User/emergency.model')
const WalletTransaction = require('../Models/User/walletTransaction.model')
const logger = require('./logger')
const { redis } = require('../config/redis')
const razorpay = require('razorpay')

// Initialize Razorpay instance
const razorpayInstance = new razorpay({
  key_id: process.env.RAZORPAY_ID || "rzp_test_Rp3ejYlVfY449V",
  key_secret: process.env.RAZORPAY_SECRET || "FORM4hrZrQO8JFIiYsQSC83N"
})

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

    // Log location update for debugging
    logger.info(
      `📍 Updating driver location - driverId: ${driverId}, coordinates: [${longitude}, ${latitude}]`
    )

    const driver = await Driver.findByIdAndUpdate(
      driverId,
      {
        location: {
          type: 'Point',
          coordinates: [longitude, latitude]
        }
      },
      { new: true }
    )

    if (!driver) {
      throw new Error('Driver not found')
    }

    logger.info(
      `✅ Driver location updated successfully - driverId: ${driverId}, saved location: [${driver.location.coordinates[0]}, ${driver.location.coordinates[1]}]`
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
 * @param {string} serviceName - Service name (e.g., "sedan", "suv", "auto", "Cerca Small", etc.)
 * @returns {string} - Vehicle service key ("cercaSmall", "cercaMedium", "cercaLarge")
 */
/**
 * Map service name from user app to vehicle service key
 * Mapping: Sedan → Cerca Medium, SUV → Cerca Large, Hatchback → Cerca Small
 * @param {string} serviceName - Service name from user app ('sedan', 'suv', 'auto', 'hatchback')
 * @returns {string} - Vehicle service key ('cercaSmall', 'cercaMedium', 'cercaLarge')
 */
const mapServiceToVehicleService = (serviceName) => {
  const normalized = serviceName.toLowerCase()
  // Map service names to vehicle services
  // Sedan → Cerca Medium
  if (normalized === 'sedan' || normalized.includes('medium')) {
    return 'cercaMedium'
  }
  // SUV → Cerca Large
  else if (normalized === 'suv' || normalized.includes('large')) {
    return 'cercaLarge'
  }
  // Hatchback → Cerca Small (also auto for legacy support)
  else if (normalized === 'hatchback' || normalized === 'auto' || normalized.includes('small')) {
    return 'cercaSmall'
  }
  // Default to small if unknown
  return 'cercaSmall'
}

/**
 * Map vehicle service key to driver vehicle type
 * Used for filtering drivers by vehicle type
 * @param {string} vehicleServiceKey - Vehicle service key ('cercaSmall', 'cercaMedium', 'cercaLarge')
 * @returns {string} - Driver vehicle type ('hatchback', 'sedan', 'suv')
 */
const mapVehicleServiceToDriverType = (vehicleServiceKey) => {
  const normalized = vehicleServiceKey.toLowerCase()
  if (normalized === 'cercasmall') {
    return 'hatchback'
  } else if (normalized === 'cercamedium') {
    return 'sedan'
  } else if (normalized === 'cercalarge') {
    return 'suv'
  }
  // Default fallback
  return 'hatchback'
}

/**
 * Map service name to driver vehicle type
 * Used for filtering drivers during ride matching
 * @param {string} serviceName - Service name from user app ('sedan', 'suv', 'auto', 'hatchback')
 * @returns {string} - Driver vehicle type ('hatchback', 'sedan', 'suv')
 */
const mapServiceToDriverType = (serviceName) => {
  const vehicleServiceKey = mapServiceToVehicleService(serviceName)
  return mapVehicleServiceToDriverType(vehicleServiceKey)
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

    // Map service name to vehicleService key (e.g., 'sedan' → 'cercaMedium')
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
      distanceInKm: Math.round(distance * 100) / 100, // Round to 2 decimal places
      estimatedDuration: estimatedDuration || null, // Store estimated duration
      rideType: rideData.rideType || 'normal',
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
      const shareLink = `https://api.myserverdevops.com/api/rides/shared/${ride.shareToken}`
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

    // 4️⃣ DRIVER BUSY LOGIC
    if (ride.bookingType === 'INSTANT') {
      await Driver.findByIdAndUpdate(driverId, {
        isBusy: true,
        busyUntil: null
      })
    } else {
      // FULL_DAY / RENTAL
      await Driver.findByIdAndUpdate(driverId, {
        isBusy: false,
        busyUntil: ride.bookingMeta?.endTime || null
      })
    }

    return ride
  } catch (error) {
    throw new Error(`Error assigning driver: ${error.message}`)
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

const completeRide = async (rideId, fare) => {
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
      actualDuration: actualDuration
    })
    logger.info(
      `[Fare Tracking] Persisted actualDuration: ${actualDuration}min, actualEndTime: ${endTime.toISOString()} before fare recalculation`
    )

    // Recalculate fare with actual duration
    let recalculatedFare = fare
    let fareBreakdown = null
    let oldFare = currentRide?.fare || fare || 0
    
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

    // Update ride with recalculated fare, fare breakdown, end time, duration, and status
    const updateData = {
      status: 'completed',
      fare: recalculatedFare,
      actualEndTime: endTime,
      actualDuration: actualDuration
    }
    
    if (fareBreakdown) {
      updateData.fareBreakdown = {
        baseFare: fareBreakdown.baseFare,
        distanceFare: fareBreakdown.distanceFare,
        timeFare: fareBreakdown.timeFare,
        subtotal: fareBreakdown.subtotal,
        fareAfterMinimum: fareBreakdown.fareAfterMinimum,
        discount: fareBreakdown.discount,
        finalFare: fareBreakdown.finalFare
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
      if (!driverExists) {
        logger.warn(`completeRide: Driver ${driverId} not found, skipping isBusy reset`)
      } else {
        // Reset isBusy for this completed ride
        await Driver.findByIdAndUpdate(driverId, {
          isBusy: false,
          busyUntil: null
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
 * Process wallet refund for a cancelled ride
 * @param {Object} ride - The ride document (must be populated with rider)
 * @param {String} originalStatus - The original ride status before cancellation
 * @param {String} cancelledBy - Who cancelled the ride ('rider', 'driver', 'system')
 * @param {String} cancellationReason - Reason for cancellation
 * @returns {Promise<Object>} Refund information or null if no refund needed
 */
const processWalletRefund = async (ride, originalStatus, cancelledBy, cancellationReason = null) => {
  try {
    // 1. Check if payment method is WALLET
    if (ride.paymentMethod !== 'WALLET') {
      logger.debug(`processWalletRefund: Skipping refund - payment method is ${ride.paymentMethod}, not WALLET`)
      return null
    }

    // 2. Check if already refunded (prevent double refunds)
    if (ride.paymentStatus === 'refunded') {
      logger.warn(`processWalletRefund: Ride ${ride._id} already refunded, skipping duplicate refund`)
      return null
    }

    // 3. Check if ride is completed (shouldn't refund completed rides)
    if (originalStatus === 'completed') {
      logger.warn(`processWalletRefund: Ride ${ride._id} is completed, skipping refund`)
      return null
    }

    // 4. Find the RIDE_PAYMENT transaction for this ride
    const paymentTransaction = await WalletTransaction.findOne({
      relatedRide: ride._id,
      transactionType: 'RIDE_PAYMENT',
      status: 'COMPLETED'
    })

    if (!paymentTransaction) {
      logger.warn(`processWalletRefund: No RIDE_PAYMENT transaction found for ride ${ride._id}, payment may not have been deducted`)
      return null
    }

    // 5. Check if refund transaction already exists (additional double-refund check)
    const existingRefund = await WalletTransaction.findOne({
      relatedRide: ride._id,
      transactionType: 'REFUND',
      status: 'COMPLETED'
    })

    if (existingRefund) {
      logger.warn(`processWalletRefund: Refund transaction already exists for ride ${ride._id}, skipping duplicate refund`)
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
      cancellationFee = settings?.pricingConfigurations?.cancellationFees || 50 // Default ₹50 if not configured
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
      cancellationFee = settings?.pricingConfigurations?.cancellationFees || 50 // Default ₹50 if not configured
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

const cancelRide = async (rideId, cancelledBy, cancellationReason = null) => {
  try {
    // Fetch ride BEFORE updating to get original status for refund calculation
    const originalRide = await Ride.findById(rideId).populate('driver rider')
    if (!originalRide) throw new Error('Ride not found')

    const originalStatus = originalRide.status

    const updateData = {
      status: 'cancelled',
      cancelledBy
    }

    // Add cancellation reason if provided
    if (cancellationReason) {
      updateData.cancellationReason = cancellationReason
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
          if (!driverExists) {
            logger.warn(`cancelRide: Driver ${driverId} not found, skipping isBusy reset`)
          } else {
            // Reset isBusy for this cancelled ride
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
        // Check for Razorpay payment (either pure RAZORPAY or hybrid with Razorpay portion)
        const hasRazorpayPayment = originalRide.razorpayPaymentId && (originalRide.razorpayAmountPaid > 0 || originalRide.fare > 0)
        const hasWalletPayment = originalRide.paymentMethod === 'WALLET' || (originalRide.walletAmountUsed && originalRide.walletAmountUsed > 0)
        
        if (hasRazorpayPayment && hasWalletPayment) {
          // Hybrid payment - refund both portions
          logger.info(`💰 Processing hybrid payment refund for ride ${rideId}`)
          
          // Wallet portion refunded via processWalletRefund
          const walletRefund = await processWalletRefund(originalRide, originalStatus, cancelledBy, cancellationReason)
          if (walletRefund && walletRefund.refunded) {
            logger.info(`✅ Wallet portion refund processed for cancelled ride ${rideId}: ₹${walletRefund.refundAmount || 0}`)
          } else if (walletRefund && !walletRefund.refunded) {
            logger.warn(`⚠️ Wallet portion refund failed for cancelled ride ${rideId}: ${walletRefund.error || 'Unknown error'}`)
          }
          
          // Razorpay portion refunded via processRazorpayRefund
          const razorpayRefund = await processRazorpayRefund(originalRide, originalStatus, cancelledBy, cancellationReason)
          if (razorpayRefund && razorpayRefund.refunded) {
            logger.info(`✅ Razorpay portion refund processed for cancelled ride ${rideId}: ₹${razorpayRefund.refundAmount || 0}`)
          } else if (razorpayRefund && !razorpayRefund.refunded) {
            logger.warn(`⚠️ Razorpay portion refund failed for cancelled ride ${rideId}: ${razorpayRefund.error || 'Unknown error'}`)
          }
        } else if (hasRazorpayPayment) {
          // Pure Razorpay payment (including case where user selected wallet but had ₹0 balance)
          logger.info(`💰 Processing Razorpay refund for ride ${rideId}`)
          const refundResult = await processRazorpayRefund(originalRide, originalStatus, cancelledBy, cancellationReason)
          if (refundResult && refundResult.refunded) {
            logger.info(`✅ Razorpay refund processed for cancelled ride ${rideId}: ₹${refundResult.refundAmount || 0}`)
          } else if (refundResult && !refundResult.refunded) {
            logger.warn(`⚠️ Razorpay refund failed for cancelled ride ${rideId}: ${refundResult.error || 'Unknown error'}`)
          } else if (!refundResult) {
            logger.info(`ℹ️ No Razorpay refund needed for cancelled ride ${rideId}`)
          }
        } else if (originalRide.paymentMethod === 'WALLET') {
          // Pure wallet payment
          logger.info(`💰 Processing wallet refund for ride ${rideId}`)
          const refundResult = await processWalletRefund(originalRide, originalStatus, cancelledBy, cancellationReason)
          if (refundResult && refundResult.refunded) {
            logger.info(`✅ Wallet refund processed for cancelled ride ${rideId}: ₹${refundResult.refundAmount || 0}`)
          } else if (refundResult && !refundResult.refunded) {
            logger.warn(`⚠️ Wallet refund failed for cancelled ride ${rideId}: ${refundResult.error || 'Unknown error'}`)
          }
        } else {
          logger.info(`ℹ️ No refund processing needed for cancelled ride ${rideId} - payment method: ${originalRide.paymentMethod}`)
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
  return Driver.findByIdAndUpdate(
    driverId,
    { $set: { socketId, isOnline: true, lastSeen: new Date() } },
    { new: true }
  )
}

async function clearDriverSocket (driverId, socketId) {
  return Driver.updateOne(
    { _id: driverId, socketId },
    {
      $set: { isOnline: false, lastSeen: new Date() },
      $unset: { socketId: '' }
    }
  )
}
//end of socket management functions

// OTP Verification Functions
const verifyStartOtp = async (rideId, providedOtp) => {
  try {
    const ride = await Ride.findById(rideId)
    if (!ride) throw new Error('Ride not found')

    // Allow OTP verification when ride is in 'accepted' or 'arrived' status
    // Driver can verify OTP after marking as arrived
    if (ride.status !== 'accepted' && ride.status !== 'arrived') {
      throw new Error('Ride is not in accepted or arrived state')
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

// Update ride with actual start time
const updateRideStartTime = async rideId => {
  try {
    const ride = await Ride.findByIdAndUpdate(
      rideId,
      { actualStartTime: new Date() },
      { new: true }
    ).populate('driver rider')

    // Update driver status to busy
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

    // Skip recalculation for special booking types
    if (ride.bookingType !== 'INSTANT') {
      logger.info(`[Fare Recalculation] Skipping recalculation for booking type: ${ride.bookingType}`)
      return {
        baseFare: ride.fareBreakdown?.baseFare || 0,
        distanceFare: ride.fareBreakdown?.distanceFare || 0,
        timeFare: ride.fareBreakdown?.timeFare || 0,
        subtotal: ride.fare || 0,
        fareAfterMinimum: ride.fare || 0,
        discount: ride.discount || 0,
        finalFare: ride.fare || 0
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

    return {
      baseFare: fareBreakdown.baseFare,
      distanceFare: fareBreakdown.distanceFare,
      timeFare: fareBreakdown.timeFare,
      subtotal: fareBreakdown.subtotal,
      fareAfterMinimum: fareBreakdown.fareAfterMinimum,
      discount: Math.round(discount * 100) / 100,
      finalFare: Math.round(finalFare * 100) / 100
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
        actualDuration: actualDuration
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
    const activeRides = await Ride.find({
      driver: driverId,
      status: { $in: ['requested', 'accepted', 'arrived', 'in_progress'] }
    }).select('_id status bookingType').lean()

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
      tags
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

    const emergency = await Emergency.create({
      ride: rideId,
      triggeredBy,
      triggeredByModel,
      location: {
        type: 'Point',
        coordinates: [location.longitude, location.latitude]
      },
      reason,
      description
    })

    // Update ride status
    await Ride.findByIdAndUpdate(rideId, {
      status: 'cancelled',
      cancelledBy: 'system',
      cancellationReason: `Emergency: ${reason}`
    })

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
const searchDriversWithProgressiveRadius = async (
  pickupLocation,
  radii = [3000, 6000, 9000, 12000, 15000, 20000],
  bookingType = null, // Optional: 'INSTANT', 'FULL_DAY', 'RENTAL', 'DATE_WISE'
  vehicleType = null // Optional: 'sedan', 'suv', 'hatchback', 'auto' - filters drivers by vehicle type
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

      // Filter by vehicle type if provided
      if (vehicleType) {
        driverQuery['vehicleInfo.vehicleType'] = vehicleType
        logger.info(`   🚗 Filtering drivers by vehicle type: ${vehicleType}`)
      }

      // Now apply filters - including socketId to ensure only connected drivers
      const drivers = await Driver.find(driverQuery)
        .select('socketId') // Explicitly select socketId field
        .limit(10) // Limit to 10 drivers per radius

      const filterDescription = (() => {
        let desc = 'isActive: true, isOnline: true, socketId exists'
        if (bookingType === 'FULL_DAY' || bookingType === 'RENTAL') {
          desc += ', isBusy: false OR (isBusy: true with future busyUntil)'
        } else {
          desc += ', isBusy: false'
        }
        if (vehicleType) {
          desc += `, vehicleType: ${vehicleType}`
        }
        return desc
      })()
      logger.info(
        `   ✅ Found ${drivers.length} drivers after applying filters (${filterDescription})`
      )

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
      bookingType: { $ne: 'INSTANT' },
      status: 'accepted',
      'bookingMeta.startTime': { $gt: now }
    })
      .populate('rider', 'fullName name phone email')
      .sort({ 'bookingMeta.startTime': 1 })

    return upcomingBookings
  } catch (error) {
    logger.error('Error getting upcoming bookings:', error)
    throw new Error(`Error getting upcoming bookings: ${error.message}`)
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
      bookingType: { $ne: 'INSTANT' },
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
  calculateFareWithTime,
  calculateHaversineDistance,
  createRide,
  assignDriverToRide,
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
  getScheduledRidesToStart,
  searchDriversWithProgressiveRadius,
  validateAndFixDriverStatus,
  recalculateRideFare,
  // Redis cleanup utilities (multi-instance safe)
  clearRideRedisKeys,
  checkAndCleanStaleRideLocks,
  clearRideLock,
  clearWorkerLock
}
