const { validateShareToken } = require('../utils/shareToken.service')
const Ride = require('../Models/Driver/ride.model')
const logger = require('../utils/logger')
const { createRateLimiter, createRedisStore } = require('./rateLimiter')

// Create Redis store for shared ride rate limiter
const sharedRideStore = createRedisStore('rl:sharedRide:', 60 * 1000) // 1 minute window

// Rate limiter for public shared ride endpoint
// 10 requests per minute per IP
const sharedRideRateLimiter = createRateLimiter(
  {
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute
    message: 'Too many requests. Please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip, // Use IP address for rate limiting
    handler: (req, res) => {
      logger.warn(`Rate limit exceeded for shared ride access from IP: ${req.ip}`)
      res.status(429).json({
        success: false,
        message: 'Too many requests. Please try again later.',
        retryAfter: req.rateLimit?.resetTime ? Math.ceil(req.rateLimit.resetTime / 1000) : 60
      })
    }
  },
  sharedRideStore,
  'sharedRideRateLimiter'
)

/**
 * Middleware to validate share token and check expiration
 * Attaches ride to req.ride if valid
 */
const validateShareTokenMiddleware = async (req, res, next) => {
  try {
    const { shareToken } = req.params

    if (!shareToken) {
      return res.status(400).json({
        success: false,
        message: 'Share token is required'
      })
    }

    // Find ride by share token
    const ride = await Ride.findOne({ shareToken })
      .populate('driver', 'name rating vehicleInfo')
      .populate('rider', 'fullName')

    if (!ride) {
      return res.status(404).json({
        success: false,
        message: 'Ride not found or link is invalid'
      })
    }

    // Validate token
    const validation = validateShareToken(shareToken, ride.shareTokenExpiresAt)
    if (!validation.isValid) {
      // If expired, update ride status
      if (validation.reason === 'EXPIRED') {
        ride.isShared = false
        await ride.save()
      }

      return res.status(400).json({
        success: false,
        message: validation.message,
        reason: validation.reason
      })
    }

    // Check if ride is completed or cancelled (expire share)
    if (ride.status === 'completed' || ride.status === 'cancelled') {
      ride.isShared = false
      ride.shareTokenExpiresAt = new Date()
      await ride.save()

      return res.status(400).json({
        success: false,
        message: 'This ride has ended',
        reason: 'RIDE_ENDED'
      })
    }

    // Attach ride to request (will be sanitized in controller)
    req.ride = ride
    next()
  } catch (error) {
    logger.error('Error validating share token:', error)
    res.status(500).json({
      success: false,
      message: 'Error validating share token',
      error: error.message
    })
  }
}

/**
 * Sanitize ride data for public sharing
 * Removes sensitive information
 */
function sanitizeRideData(ride) {
  const sanitized = {
    _id: ride._id,
    status: ride.status,
    pickupLocation: ride.pickupLocation,
    dropoffLocation: ride.dropoffLocation,
    pickupAddress: ride.pickupAddress,
    dropoffAddress: ride.dropoffAddress,
    fare: ride.fare,
    distanceInKm: ride.distanceInKm,
    service: ride.service,
    vehicleType: ride.vehicleType,
    estimatedDuration: ride.estimatedDuration,
    estimatedArrivalTime: ride.estimatedArrivalTime,
    driverArrivedAt: ride.driverArrivedAt,
    actualStartTime: ride.actualStartTime,
    createdAt: ride.createdAt,
    updatedAt: ride.updatedAt,
    // OTP codes for passenger verification
    startOtp: ride.startOtp,
    stopOtp: ride.stopOtp,
    // Ride sharing info
    rideFor: ride.rideFor,
    passenger: ride.passenger,
    // Driver info (sanitized - no personal contact info)
    driver: ride.driver ? {
      name: ride.driver.name,
      rating: ride.driver.rating,
      location: ride.driver.location || null, // Include driver location for tracking
      vehicleInfo: ride.driver.vehicleInfo ? {
        make: ride.driver.vehicleInfo.make,
        model: ride.driver.vehicleInfo.model,
        color: ride.driver.vehicleInfo.color,
        licensePlate: ride.driver.vehicleInfo.licensePlate
      } : null
    } : null,
    // Rider info (minimal - no personal details)
    rider: ride.rider ? {
      fullName: ride.rider.fullName
    } : null
  }

  return sanitized
}

module.exports = {
  validateShareTokenMiddleware,
  sanitizeRideData,
  sharedRideRateLimiter
}

