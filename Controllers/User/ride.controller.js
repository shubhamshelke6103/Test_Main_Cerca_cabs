const Ride = require('../../Models/Driver/ride.model')
const Settings = require('../../Models/Admin/settings.modal')
const logger = require('../../utils/logger')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const path = require('path')
const fs = require('fs')
const mongoose = require('mongoose')
// const rideBookingQueue = require('../../src/queues/rideBooking.queue')
const rideBookingProducer = require('../../src/queues/rideBooking.producer')
const rideBookingFunctions = require('../../utils/ride_booking_functions')
const {
  normalizeVehicleServicesForResponse,
  VEHICLE_SERVICE_KEYS,
  resolveCanonicalVehicleTier
} = require('../../utils/vehicleServicesKeys')
const {
  mapServiceToVehicleService,
  calculateFareWithTime,
  calculateHaversineDistance,
  calculateIntercityFareBreakdown,
  getIntercityPricingConfig
} = rideBookingFunctions
const Driver = require('../../Models/Driver/driver.model')
const {
  generateTokenForRide,
  validateShareToken
} = require('../../utils/shareToken.service')
const { sanitizeRideData } = require('../../middleware/shareToken.middleware')
const LiveLocationShare = require('../../Models/Shared/liveLocationShare.model')
const {
  createLiveLocationShare,
  revokeLiveLocationShare,
  getSharedLiveLocationPayload
} = require('../../utils/liveLocationShare.service')
const { getSocketIO } = require('../../utils/socket')
const Notification = require('../../Models/User/notification.model.js')
const { normalizeMobileDigits } = require('../../utils/contactValidation')
const AppError = require('../../utils/errors/AppError')
const asyncHandler = require('../../utils/errors/asyncHandler')

const DEFAULT_CITY_SPEED_KMH = 35
const MIN_DESTINATION_MOVE_KM = 0.05 // 50 m — ignore jitter / mis-taps
const MAX_DESTINATION_CHANGES_PER_RIDE = 15

const parseExpectedRevision = req => {
  if (req.body && req.body.expectedRevision !== undefined && req.body.expectedRevision !== null) {
    const n = Number(req.body.expectedRevision)
    return Number.isFinite(n) ? n : undefined
  }
  const ifMatch = req.headers['if-match'] || req.headers['If-Match']
  if (ifMatch && typeof ifMatch === 'string') {
    const cleaned = ifMatch.replace(/^W\//, '').replace(/^"|"$/g, '').trim()
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

const haversineKmBetweenPoints = (a, b) => {
  if (!a?.coordinates || !b?.coordinates || a.coordinates.length < 2 || b.coordinates.length < 2) {
    return Infinity
  }
  const [lng1, lat1] = a.coordinates
  const [lng2, lat2] = b.coordinates
  return calculateHaversineDistance(lat1, lng1, lat2, lng2)
}

const normalizeQueryLocation = (q, fieldName) => {
  const lat = q.latitude ?? q.lat
  const lng = q.longitude ?? q.lng ?? q.lon
  if (lat === undefined || lng === undefined) {
    throw new Error(`${fieldName}: latitude and longitude query params are required`)
  }
  return {
    type: 'Point',
    coordinates: [Number(lng), Number(lat)]
  }
}

const notifyDestinationChangeAsync = (ride, userId, quote, refreshedRide) => {
  const rideId = refreshedRide._id
  const fareStr = quote.fare != null ? `₹${Number(quote.fare).toFixed(2)}` : ''
  const addr = refreshedRide.dropoffAddress || 'Destination updated'
  const msg = `New estimated fare ${fareStr}. ${addr}`

  const tasks = [
    Notification.create({
      recipient: userId,
      recipientModel: 'User',
      title: 'Destination updated',
      message: msg,
      type: 'ride_destination_updated',
      relatedRide: rideId,
      data: { rideId: String(rideId), fare: quote.fare, role: 'rider' }
    })
  ]
  const driverId = refreshedRide.driver?._id || refreshedRide.driver
  if (driverId) {
    tasks.push(
      Notification.create({
        recipient: driverId,
        recipientModel: 'Driver',
        title: 'Rider changed destination',
        message: msg,
        type: 'ride_destination_updated',
        relatedRide: rideId,
        data: { rideId: String(rideId), fare: quote.fare, role: 'driver' }
      })
    )
  }
  Promise.all(tasks).catch(err =>
    logger.warn('Destination change in-app notifications failed:', err)
  )
}

const normalizeLocationInput = (location, fieldName) => {
  if (!location) {
    throw new Error(`${fieldName} is required`)
  }

  if (Array.isArray(location.coordinates) && location.coordinates.length === 2) {
    const [lng, lat] = location.coordinates
    return {
      type: 'Point',
      coordinates: [Number(lng), Number(lat)]
    }
  }

  if (
    location.longitude !== undefined &&
    location.latitude !== undefined
  ) {
    return {
      type: 'Point',
      coordinates: [Number(location.longitude), Number(location.latitude)]
    }
  }

  throw new Error(`Invalid ${fieldName} format`)
}

const normalizeServiceName = (serviceName) => {
  if (serviceName === undefined || serviceName === null) {
    return ''
  }
  return String(serviceName).toLowerCase().trim().replace(/\s+/g, ' ')
}

const resolveVehiclePricingConfig = (ride, settings) => {
  const vehicleServiceKey =
    ride.vehicleService || mapServiceToVehicleService(ride.service)
  const vehicleService = settings.vehicleServices?.[vehicleServiceKey]

  if (!vehicleService || vehicleService.enabled === false) {
    throw new Error(`Invalid or disabled vehicle service: ${vehicleServiceKey}`)
  }

  return {
    vehicleServiceKey,
    basePrice: vehicleService.price || 0,
    perMinuteRate: vehicleService.perMinuteRate || 0
  }
}

const applyRidePromoDiscount = async (ride, vehicleServiceKey, fareAfterMinimum) => {
  let discount = 0
  let finalFare = fareAfterMinimum

  if (!ride.promoCode) {
    return { discount, finalFare }
  }

  const Coupon = require('../../Models/Admin/coupon.modal')
  const coupon = await Coupon.findOne({
    couponCode: ride.promoCode.toUpperCase().trim()
  })

  if (!coupon) {
    return { discount, finalFare }
  }

  const canUse = coupon.canUserUse(ride.rider?._id || ride.rider)
  if (!canUse.canUse) {
    return { discount, finalFare }
  }

  const serviceApplicable =
    !coupon.applicableServices ||
    coupon.applicableServices.length === 0 ||
    coupon.applicableServices.includes(ride.service) ||
    coupon.applicableServices.includes(vehicleServiceKey)

  if (!serviceApplicable) {
    return { discount, finalFare }
  }

  const discountResult = coupon.calculateDiscount(fareAfterMinimum)
  if (discountResult.discount > 0) {
    discount = Math.round(discountResult.discount * 100) / 100
    finalFare = Math.round(discountResult.finalFare * 100) / 100
  }

  return { discount, finalFare }
}

const buildDestinationUpdateQuote = async ({
  ride,
  pricingOrigin,
  dropoffLocation,
  estimatedDuration
}) => {
  const settings = await Settings.findOne()
  if (!settings) {
    throw new Error('Admin settings not found')
  }

  const { perKmRate, minimumFare, platformFees, driverCommissions } =
    settings.pricingConfigurations
  const { vehicleServiceKey, basePrice, perMinuteRate } =
    resolveVehiclePricingConfig(ride, settings)

  const [pickupLng, pickupLat] = pricingOrigin.coordinates
  const [dropoffLng, dropoffLat] = dropoffLocation.coordinates

  const distance = calculateHaversineDistance(
    pickupLat,
    pickupLng,
    dropoffLat,
    dropoffLng
  )

  let duration = Number(estimatedDuration)
  if (!duration || duration <= 0) {
    duration = Math.ceil((distance / DEFAULT_CITY_SPEED_KMH) * 60)
  }

  const rawFareBreakdown = calculateFareWithTime(
    basePrice,
    distance,
    duration,
    perKmRate,
    perMinuteRate,
    minimumFare
  )

  const { discount, finalFare } = await applyRidePromoDiscount(
    ride,
    vehicleServiceKey,
    rawFareBreakdown.fareAfterMinimum
  )

  const driverEarnings = driverCommissions
    ? Math.round(finalFare * (driverCommissions / 100) * 100) / 100
    : Math.round((finalFare - finalFare * (platformFees / 100)) * 100) / 100
  const platformFee = platformFees
    ? Math.round(finalFare * (platformFees / 100) * 100) / 100
    : 0

  return {
    distanceInKm: Math.round(distance * 100) / 100,
    estimatedDuration: duration,
    discount,
    fare: finalFare,
    fareBreakdown: {
      baseFare: rawFareBreakdown.baseFare,
      distanceFare: rawFareBreakdown.distanceFare,
      timeFare: rawFareBreakdown.timeFare,
      subtotal: rawFareBreakdown.subtotal,
      fareAfterMinimum: rawFareBreakdown.fareAfterMinimum,
      discount,
      finalFare
    },
    earnings: {
      driverEarnings,
      platformFees: platformFee,
      adminEarnings: platformFee
    },
    pricingOriginSource: pricingOrigin.source
  }
}

const resolveRidePricingOrigin = async ride => {
  if (ride.status === 'in_progress' && ride.driver) {
    const driver = await Driver.findById(ride.driver)
      .select('location')
      .lean()

    if (driver?.location?.coordinates?.length === 2) {
      return {
        source: 'driver_current_location',
        coordinates: driver.location.coordinates
      }
    }
  }

  return {
    source: 'ride_pickup_location',
    coordinates: ride.pickupLocation.coordinates
  }
}

/**
 * @desc    Create a new ride
 * @route   POST /rides
 */
const createRide = asyncHandler(async (req, res) => {
    const rideData = req.body

    // ============================
    // Rider Security (Extract from Token)
    // ============================
    const riderId =
      getUserIdFromToken(req) || rideData.rider || rideData.riderId

    if (!riderId) {
      throw new AppError('Rider authentication required', 401, {
        code: 'RIDER_AUTH_REQUIRED'
      })
    }

    rideData.rider = riderId
    delete rideData.riderId // ⭐ cleanup legacy field


    // ============================
    // Ride For Handling
    // ============================
    rideData.rideFor = rideData.rideFor || 'SELF'

    if (rideData.rideFor === 'OTHER') {
      if (!rideData.passenger?.name || !rideData.passenger?.phone) {
        throw new AppError(
          'Passenger name and phone are required when booking ride for another person',
          400,
          { code: 'PASSENGER_DETAILS_REQUIRED' }
        )
      }
      const phoneResult = normalizeMobileDigits(rideData.passenger.phone)
      if (phoneResult.error || !phoneResult.value) {
        throw new AppError(phoneResult.error || 'Passenger phone is required', 400, {
          code: 'INVALID_PASSENGER_PHONE'
        })
      }
      rideData.passenger.phone = phoneResult.value
    }


    // ============================
    // Validate Location Payload
    // ============================
    if (
      !rideData.pickupLocation?.coordinates ||
      !rideData.dropoffLocation?.coordinates
    ) {
      throw new AppError('Pickup and dropoff coordinates are required', 400, {
        code: 'RIDE_COORDINATES_REQUIRED'
      })
    }

    // ============================
    // Prevent Duplicate Active Ride
    // ============================
    try {
      const {
        checkAndCleanStaleRideLocks
      } = require('../../utils/ride_booking_functions')

      await checkAndCleanStaleRideLocks(riderId)

    } catch (cleanupError) {
      logger.warn(
        `⚠️ Stale lock check failed for rider ${riderId}: ${cleanupError.message}`
      )
    }

    const existingActiveRide = await Ride.findOne({
      rider: riderId,
      status: { $in: ['requested', 'accepted', 'in_progress'] }
    })

    if (existingActiveRide) {
      throw new AppError(
        'You already have an active ride. Please cancel it before booking a new one.',
        409,
        {
          code: 'ACTIVE_RIDE_EXISTS',
          details: { activeRideId: existingActiveRide._id }
        }
      )
    }


    // ============================
    // Fetch Admin Settings
    // ============================
    const settings = await Settings.findOne()
    if (!settings) {
      throw new AppError('Admin settings not found', 500, {
        code: 'ADMIN_SETTINGS_NOT_FOUND'
      })
    }

    const { perKmRate, minimumFare } = settings.pricingConfigurations


    // ============================
    // Distance Calculation
    // ============================
    const [pickupLng, pickupLat] = rideData.pickupLocation.coordinates
    const [dropoffLng, dropoffLat] = rideData.dropoffLocation.coordinates

    const distance = calculateDistance(
      pickupLat,
      pickupLng,
      dropoffLat,
      dropoffLng
    )

    rideData.estimatedDistanceInKm = distance
    rideData.distanceInKm = distance
    let vehicleServiceKey = null


    // ============================
    // Service Validation
    // ============================
    const rideType = String(rideData.rideType || 'normal').toLowerCase()
    const scheduleType = String(rideData.scheduleType || 'now').toLowerCase()
    const isIntercityRide = rideType === 'intercity'

    const selectedService = normalizeServiceName(
      rideData.service || rideData.vehicleType || ''
    )

    let service = settings.services?.find(
      (s) => normalizeServiceName(s.name) === selectedService
    )

    if (!service && selectedService) {
      vehicleServiceKey = mapServiceToVehicleService(selectedService)
      const vehicleService = settings.vehicleServices?.[vehicleServiceKey]
      if (vehicleService && vehicleService.enabled !== false) {
        service = {
          name: vehicleService.name,
          price: vehicleService.price || 0
        }
        logger.info(
          `Fallback matched ride service "${rideData.service}" to vehicleService ${vehicleServiceKey}`
        )
      }
    }

    if (!service && isIntercityRide) {
      vehicleServiceKey = mapServiceToVehicleService(
        rideData.vehicleType || 'cercaZip'
      )
      const vehicleService = settings.vehicleServices?.[vehicleServiceKey]
      if (vehicleService && vehicleService.enabled !== false) {
        service = {
          name: vehicleService.name,
          price: vehicleService.price || 0
        }
      }
    }

    if (!service) {
      throw new AppError('Invalid service selected', 400, {
        code: 'INVALID_SERVICE_SELECTED'
      })
    }

    if (isIntercityRide) {
      if (
        rideData.pickupCity &&
        rideData.dropCity &&
        String(rideData.pickupCity).trim().toLowerCase() ===
          String(rideData.dropCity).trim().toLowerCase()
      ) {
        throw new AppError('Intercity rides must be between different cities', 400, {
          code: 'INTERCITY_SAME_CITY_NOT_ALLOWED'
        })
      }
    }


    // ============================
    // Fare Calculation
    // ============================
    let fare = service.price + distance * perKmRate
    fare = Math.max(fare, minimumFare)
    let intercityBreakdown = null

    if (isIntercityRide) {
      const intercityConfig = getIntercityPricingConfig(settings)
      if (!intercityConfig.enabled) {
        throw new AppError('Intercity rides are currently disabled', 400, {
          code: 'INTERCITY_DISABLED'
        })
      }

      const tripMode =
        String(rideData.tripMode || (rideData.roundTrip ? 'round_trip' : 'one_way')).toLowerCase() ===
        'round_trip'
          ? 'round_trip'
          : 'one_way'

      const scheduledAt =
        rideData.scheduledAt ||
        rideData.bookingMeta?.startTime ||
        rideData.bookingMeta?.scheduledAt ||
        null

      if (scheduleType === 'scheduled' && !scheduledAt) {
        throw new AppError('Scheduled intercity rides require a scheduled time', 400, {
          code: 'INTERCITY_SCHEDULE_TIME_REQUIRED'
        })
      }

      intercityBreakdown = calculateIntercityFareBreakdown({
        pickupLocation: rideData.pickupLocation,
        dropoffLocation: rideData.dropoffLocation,
        durationMinutes:
          Number(rideData.estimatedDuration || 0) ||
          Math.ceil((distance / 35) * 60),
        vehicleType:
          vehicleServiceKey || mapServiceToVehicleService(selectedService || rideData.vehicleType || 'cercaZip'),
        tripMode,
        tollCharges: rideData.tollCharges || 0,
        parkingCharges: rideData.parkingCharges || 0,
        settings
      })

      fare = intercityBreakdown.finalFare
      rideData.tripMode = tripMode
      rideData.scheduleType = scheduleType
      rideData.scheduledAt = scheduledAt ? new Date(scheduledAt) : null
      rideData.rideType = 'intercity'
      rideData.vehicleType =
        vehicleServiceKey ||
        mapServiceToVehicleService(selectedService || rideData.vehicleType || 'cercaZip')
      rideData.service = service.name.toLowerCase()
      rideData.fare = fare
      rideData.distanceInKm = intercityBreakdown.distanceKm
      rideData.estimatedDistanceInKm = intercityBreakdown.distanceKm
      rideData.fareBreakdown = {
        baseFare: intercityBreakdown.baseFare,
        distanceFare: intercityBreakdown.distanceFare,
        timeFare: 0,
        subtotal: intercityBreakdown.finalFare,
        fareAfterMinimum: intercityBreakdown.finalFare,
        discount: 0,
        finalFare: intercityBreakdown.finalFare,
        tollCharges: intercityBreakdown.tollCharges,
        parkingCharges: intercityBreakdown.parkingCharges,
        driverAllowance: intercityBreakdown.driverAllowance
      }
    } else {
      rideData.fare = fare
      rideData.service = service.name.toLowerCase()
    }


    // ============================
    // OTP Generation
    // ============================
    const startOtp = crypto.randomInt(1000, 9999).toString()
    const stopOtp = crypto.randomInt(1000, 9999).toString()

    rideData.startOtp = startOtp
    rideData.stopOtp = stopOtp


    // ============================
    // Create Ride
    // ============================
    const ride = new Ride({
      ...rideData,
      rideType,
      scheduleType: rideData.scheduleType || 'now',
      intercityMatchState: isIntercityRide
        ? {
            batchIndex: 0,
            lastBatchSentAt: null,
            firstDispatchedAt: null,
            requestExpiresAt: scheduleType === 'scheduled' ? null : new Date(Date.now() + 30 * 60 * 1000),
            currentBatchDriverIds: [],
            userNotifiedAt: null,
            driverNotifiedAt: null,
            dayReminderSentAt: null,
            hourReminderSentAt: null,
            nextBatchAt: null
          }
        : rideData.intercityMatchState
    })
    await ride.save()

    logger.info(`Ride created successfully with ID: ${ride._id}`)


    // ============================
    // Queue Ride For Driver Discovery
    // ============================
    if (!isIntercityRide || scheduleType === 'now') {
      logger.info(`📥 Queuing ride ${ride._id} for driver discovery`)

      await rideBookingProducer.add('process-ride', {
        rideId: ride._id.toString(),
        mode: isIntercityRide ? 'intercity-now' : 'standard',
        batchIndex: 0
      })

      logger.info(`✅ Ride ${ride._id} successfully added to Redis queue`)
    } else {
      logger.info(`⏭️ Intercity scheduled ride ${ride._id} stored for cron-based matching`)
    }


    // ============================
    // Response
    // ============================
    res.status(201).json({
      ride,
      otpReceiver: ride.otpReceiver,
      startOtp,
      stopOtp,
      intercityFare: intercityBreakdown
    })
})


/**
 * Calculate the distance between two coordinates using the Haversine formula
 * @param {number} lat1 - Latitude of the first point
 * @param {number} lon1 - Longitude of the first point
 * @param {number} lat2 - Latitude of the second point
 * @param {number} lon2 - Longitude of the second point
 * @returns {number} - Distance in kilometers
 */
function calculateDistance (lat1, lon1, lat2, lon2) {
  const toRadians = degrees => (degrees * Math.PI) / 180
  const R = 6371 // Radius of the Earth in kilometers

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

/**
 * @desc    Get all rides
 * @route   GET /rides
 */
const getAllRides = asyncHandler(async (req, res) => {
  const rides = await Ride.find()
  res.status(200).json(rides)
})

/**
 * @desc    Get a single ride by ID
 * @route   GET /rides/:id
 */
const getRideById = asyncHandler(async (req, res) => {
  const rideId = req.params.id

  // Reject non-ObjectId values (like favicon.ico, robots.txt, etc.)
  if (!mongoose.Types.ObjectId.isValid(rideId)) {
    throw new AppError('Ride not found', 404, {
      code: 'RIDE_NOT_FOUND'
    })
  }

  const ride = await Ride.findById(rideId).populate('driver rider')
  if (!ride) {
    throw new AppError('Ride not found', 404, {
      code: 'RIDE_NOT_FOUND'
    })
  }
  res.status(200).json(ride)
})

/**
 * @desc    Update a ride by ID
 * @route   PUT /rides/:id
 */
const updateRide = asyncHandler(async (req, res) => {

  const rideId = req.params.id
  const updateData = req.body

    // ============================
    // Fetch Existing Ride
    // ============================
  const existingRide = await Ride.findById(rideId)

  if (!existingRide) {
    throw new AppError('Ride not found', 404, {
      code: 'RIDE_NOT_FOUND'
    })
  }

    // ============================
    // SECURITY RULES
    // ============================

    // ❌ Prevent rider change
  if (updateData.rider && updateData.rider.toString() !== existingRide.rider.toString()) {
    throw new AppError('Rider cannot be changed', 400, {
      code: 'RIDER_CHANGE_NOT_ALLOWED'
    })
  }

  if (
    updateData.rideFor &&
    updateData.rideFor !== existingRide.rideFor &&
    ['accepted', 'in_progress', 'completed'].includes(existingRide.status)
  ) {
    throw new AppError('rideFor cannot be changed after ride is accepted', 400, {
      code: 'RIDE_FOR_CHANGE_NOT_ALLOWED'
    })
  }

  if (
    updateData.passenger &&
    ['accepted', 'in_progress', 'completed'].includes(existingRide.status)
  ) {
    throw new AppError('Passenger details cannot be modified after ride is accepted', 400, {
      code: 'PASSENGER_UPDATE_NOT_ALLOWED'
    })
  }

  if (updateData.startOtp || updateData.stopOtp) {
    throw new AppError('OTP values cannot be updated', 400, {
      code: 'OTP_UPDATE_NOT_ALLOWED'
    })
  }

  const updatedRide = await Ride.findByIdAndUpdate(
    rideId,
    updateData,
    {
      new: true,
      runValidators: true
    }
  )

  logger.info(`Ride updated successfully: ${updatedRide._id}`)

  res.status(200).json(updatedRide)
})

const switchRideToCash = asyncHandler(async (req, res) => {
  const { rideId } = req.params
  const userId =
    req.body?.userId ||
    req.query?.userId ||
    req.headers['x-user-id'] ||
    req.headers['x-userid'] ||
    req.user?.id ||
    getUserIdFromToken(req)

  if (!mongoose.Types.ObjectId.isValid(rideId)) {
    throw new AppError('Ride not found', 404, {
      code: 'RIDE_NOT_FOUND'
    })
  }

  if (!userId) {
    throw new AppError('User ID is required', 401, {
      code: 'USER_ID_REQUIRED'
    })
  }

  const ride = await Ride.findById(rideId)

  if (!ride) {
    throw new AppError('Ride not found', 404, {
      code: 'RIDE_NOT_FOUND'
    })
  }

  const riderId = ride.rider?._id || ride.rider
  if (!riderId || String(riderId) !== String(userId)) {
    throw new AppError('Unauthorized: This ride does not belong to you', 403, {
      code: 'UNAUTHORIZED_RIDE_ACCESS'
    })
  }

  if (ride.status === 'cancelled') {
    throw new AppError('Cannot switch payment method after ride is cancelled', 400, {
      code: 'RIDE_PAYMENT_CHANGE_NOT_ALLOWED'
    })
  }

  if (ride.paymentMethod === 'CASH') {
    return res.status(200).json({
      success: true,
      message: 'Ride payment method is already set to CASH',
      data: ride
    })
  }

  if (ride.paymentStatus === 'completed') {
    throw new AppError('Cannot switch to CASH after payment is already completed', 400, {
      code: 'RIDE_PAYMENT_ALREADY_PROCESSED'
    })
  }

  if (ride.paymentMethod === 'WALLET' && ride.walletAmountUsed > 0) {
    throw new AppError('Cannot switch to CASH after wallet payment has been applied', 400, {
      code: 'CANNOT_SWITCH_AFTER_WALLET_PAYMENT'
    })
  }

  ride.paymentMethod = 'CASH'
  ride.transactionId = null
  ride.razorpayPaymentId = null
  ride.razorpayRefundId = null
  ride.razorpayRefundStatus = null
  await ride.save()

  res.status(200).json({
    success: true,
    message: 'Ride payment method switched to CASH',
    data: ride
  })
})


/**
 * Shared validation for destination change / quote (rider auth + ride state).
 */
const loadRideForDestinationChange = async (rideId, userId) => {
  if (!userId) {
    return { error: { status: 401, body: { success: false, message: 'Authentication required' } } }
  }
  if (!mongoose.Types.ObjectId.isValid(rideId)) {
    return { error: { status: 404, body: { success: false, message: 'Ride not found' } } }
  }
  const ride = await Ride.findById(rideId).populate('driver rider')
  if (!ride) {
    return { error: { status: 404, body: { success: false, message: 'Ride not found' } } }
  }
  if (String(ride.rider?._id || ride.rider) !== String(userId)) {
    return {
      error: {
        status: 403,
        body: { success: false, message: 'You do not have permission to update this ride destination' }
      }
    }
  }
  if (ride.bookingType !== 'INSTANT') {
    return {
      error: {
        status: 400,
        body: { success: false, message: 'Destination updates are only supported for instant rides' }
      }
    }
  }
  const allowedStatuses = ['requested', 'accepted', 'arrived', 'in_progress']
  if (!allowedStatuses.includes(ride.status)) {
    return {
      error: {
        status: 400,
        body: { success: false, message: 'Destination can only be updated for active rides' }
      }
    }
  }
  return { ride }
}

/**
 * @desc    Preview fare for a new dropoff without persisting
 * @route   GET /rides/:id/destination-quote
 * @query   latitude, longitude (or lat, lng) — optional estimatedDuration (minutes)
 */
const getDestinationQuote = async (req, res) => {
  try {
    const rideId = req.params.id
    const userId = getUserIdFromToken(req)
    const gate = await loadRideForDestinationChange(rideId, userId)
    if (gate.error) {
      return res.status(gate.error.status).json(gate.error.body)
    }
    const { ride } = gate

    const dropoffLocation = normalizeQueryLocation(req.query, 'destination-quote')
    const moveKm = haversineKmBetweenPoints(ride.dropoffLocation, dropoffLocation)
    if (moveKm < MIN_DESTINATION_MOVE_KM) {
      return res.status(400).json({
        success: false,
        message: `New destination must be at least ${MIN_DESTINATION_MOVE_KM * 1000}m from the current drop-off`
      })
    }

    const pricingOrigin = await resolveRidePricingOrigin(ride)
    const quote = await buildDestinationUpdateQuote({
      ride,
      pricingOrigin,
      dropoffLocation,
      estimatedDuration: req.query.estimatedDuration
    })

    const previousFare = Number(ride.fare || 0)
    return res.status(200).json({
      success: true,
      destinationRevision: ride.destinationRevision ?? 0,
      pricing: {
        previousFare,
        newFare: quote.fare,
        fareDifference: Math.round((quote.fare - previousFare) * 100) / 100,
        previousDistanceInKm: Number(ride.distanceInKm || 0),
        newDistanceInKm: quote.distanceInKm,
        previousEstimatedDuration: Number(ride.estimatedDuration || 0),
        newEstimatedDuration: quote.estimatedDuration,
        pricingOriginSource: quote.pricingOriginSource,
        earnings: quote.earnings
      },
      quotePreview: quote
    })
  } catch (error) {
    logger.error('Error getting destination quote:', error)
    return res.status(400).json({
      success: false,
      message: error.message || 'Error getting destination quote'
    })
  }
}

/**
 * @desc    Update active ride destination and recalculate fare
 * @route   PATCH /rides/:id/destination
 */
const updateRideDestination = async (req, res) => {
  try {
    const rideId = req.params.id
    const userId = getUserIdFromToken(req)

    const gate = await loadRideForDestinationChange(rideId, userId)
    if (gate.error) {
      return res.status(gate.error.status).json(gate.error.body)
    }
    const { ride } = gate

    const logLen = (ride.destinationChangeLog && ride.destinationChangeLog.length) || 0
    if (logLen >= MAX_DESTINATION_CHANGES_PER_RIDE) {
      return res.status(400).json({
        success: false,
        message: `Maximum of ${MAX_DESTINATION_CHANGES_PER_RIDE} destination changes per ride reached`
      })
    }

    const expectedRevision = parseExpectedRevision(req)
    const currentRev = ride.destinationRevision ?? 0
    if (expectedRevision !== undefined && expectedRevision !== currentRev) {
      return res.status(409).json({
        success: false,
        message: 'Destination was updated by another action. Refresh and try again.',
        destinationRevision: currentRev
      })
    }

    const dropoffLocation = normalizeLocationInput(
      req.body.dropoffLocation,
      'dropoffLocation'
    )
    const moveKm = haversineKmBetweenPoints(ride.dropoffLocation, dropoffLocation)
    if (moveKm < MIN_DESTINATION_MOVE_KM) {
      return res.status(400).json({
        success: false,
        message: `New destination must be at least ${MIN_DESTINATION_MOVE_KM * 1000}m from the current drop-off`
      })
    }

    const pricingOrigin = await resolveRidePricingOrigin(ride)

    const previousFare = Number(ride.fare || 0)
    const previousDistanceInKm = Number(ride.distanceInKm || 0)
    const previousEstimatedDuration = Number(ride.estimatedDuration || 0)
    const previousDropoffAddress = ride.dropoffAddress || null
    const previousDropoffLocation = ride.dropoffLocation
      ? {
          type: ride.dropoffLocation.type || 'Point',
          coordinates: [...ride.dropoffLocation.coordinates]
        }
      : null

    const quote = await buildDestinationUpdateQuote({
      ride,
      pricingOrigin,
      dropoffLocation,
      estimatedDuration: req.body.estimatedDuration
    })

    const newDropoffAddress =
      typeof req.body.dropoffAddress === 'string' && req.body.dropoffAddress.trim()
        ? req.body.dropoffAddress.trim()
        : ride.dropoffAddress

    ride.dropoffLocation = dropoffLocation
    if (typeof req.body.dropoffAddress === 'string' && req.body.dropoffAddress.trim()) {
      ride.dropoffAddress = req.body.dropoffAddress.trim()
    }
    ride.distanceInKm = quote.distanceInKm
    ride.estimatedDuration = quote.estimatedDuration
    ride.discount = quote.discount
    ride.fare = quote.fare
    ride.fareBreakdown = quote.fareBreakdown

    if (!ride.destinationChangeLog) {
      ride.destinationChangeLog = []
    }
    ride.destinationChangeLog.push({
      at: new Date(),
      previousDropoffLocation,
      previousDropoffAddress,
      previousFare,
      newDropoffLocation: {
        type: dropoffLocation.type || 'Point',
        coordinates: [...dropoffLocation.coordinates]
      },
      newDropoffAddress: newDropoffAddress || null,
      newFare: quote.fare,
      pricingOriginSource: quote.pricingOriginSource,
      requestedBy: userId
    })
    ride.destinationRevision = currentRev + 1

    await ride.save()

    const refreshedRide = await Ride.findById(rideId).populate('driver rider')

    const responsePayload = {
      success: true,
      message: 'Ride destination updated successfully',
      ride: refreshedRide,
      destinationRevision: refreshedRide.destinationRevision,
      pricing: {
        previousFare,
        newFare: quote.fare,
        fareDifference: Math.round((quote.fare - previousFare) * 100) / 100,
        previousDistanceInKm,
        newDistanceInKm: quote.distanceInKm,
        previousEstimatedDuration,
        newEstimatedDuration: quote.estimatedDuration,
        previousDropoffAddress,
        newDropoffAddress: refreshedRide.dropoffAddress || null,
        previousDropoffLocation,
        newDropoffLocation: refreshedRide.dropoffLocation,
        pricingOriginSource: quote.pricingOriginSource,
        earnings: quote.earnings
      }
    }

    notifyDestinationChangeAsync(ride, userId, quote, refreshedRide)

    try {
      const io = getSocketIO()
      if (io) {
        const rideIdStr = String(refreshedRide._id || rideId)
        const ridePlain =
          refreshedRide && typeof refreshedRide.toObject === 'function'
            ? refreshedRide.toObject({ flattenMaps: true })
            : refreshedRide
        let destinationUpdateEvent
        try {
          destinationUpdateEvent = JSON.parse(
            JSON.stringify({
              ride: ridePlain,
              pricing: responsePayload.pricing
            })
          )
        } catch (serializeErr) {
          logger.warn('rideDestinationUpdated: JSON serialize failed, using lean payload', serializeErr)
          destinationUpdateEvent = {
            ride: ridePlain,
            pricing: responsePayload.pricing
          }
        }

        const riderIdentifier =
          refreshedRide && refreshedRide.rider
            ? refreshedRide.rider._id || refreshedRide.rider
            : null
        const driverIdentifier =
          refreshedRide && refreshedRide.driver
            ? refreshedRide.driver._id || refreshedRide.driver
            : null
        const riderIdStr =
          riderIdentifier != null ? String(riderIdentifier) : null
        const driverIdStr =
          driverIdentifier != null ? String(driverIdentifier) : null
        const roomName = `ride_${rideIdStr}`

        try {
          if (riderIdStr) {
            io.in(`user_${riderIdStr}`).socketsJoin(roomName)
          }
          if (driverIdStr) {
            io.in(`driver_${driverIdStr}`).socketsJoin(roomName)
          }
        } catch (joinErr) {
          logger.warn('Destination update: auto-join ride room failed', { err: joinErr.message })
        }

        io.to(roomName).emit('rideDestinationUpdated', destinationUpdateEvent)
        io.to(roomName).emit('rideUpdated', destinationUpdateEvent)

        if (refreshedRide.userSocketId) {
          io.to(refreshedRide.userSocketId).emit(
            'rideDestinationUpdated',
            destinationUpdateEvent
          )
        }

        if (refreshedRide.driverSocketId) {
          io.to(refreshedRide.driverSocketId).emit(
            'rideDestinationUpdated',
            destinationUpdateEvent
          )
        }

        if (riderIdStr) {
          io.to(`user_${riderIdStr}`).emit(
            'rideDestinationUpdated',
            destinationUpdateEvent
          )
        }
        if (driverIdStr) {
          io.to(`driver_${driverIdStr}`).emit(
            'rideDestinationUpdated',
            destinationUpdateEvent
          )
        }

        logger.info('rideDestinationUpdated emitted', {
          rideId: rideIdStr,
          roomName,
          riderIdStr,
          driverIdStr,
          hasUserSocket: Boolean(refreshedRide.userSocketId),
          hasDriverSocket: Boolean(refreshedRide.driverSocketId)
        })

        io.to('admin').emit('rideStatusUpdated', {
          rideId: rideIdStr,
          status: refreshedRide.status,
          ride: destinationUpdateEvent.ride
        })
        io.to('admin').emit('rideDestinationUpdated', destinationUpdateEvent)

        if (refreshedRide.shareToken && refreshedRide.isShared) {
          io.to(`shared_ride_${refreshedRide.shareToken}`).emit(
            'sharedRideStatusUpdate',
            {
              status: refreshedRide.status,
              ride: {
                _id: refreshedRide._id,
                status: refreshedRide.status,
                dropoffAddress: refreshedRide.dropoffAddress,
                dropoffLocation: refreshedRide.dropoffLocation,
                fare: refreshedRide.fare,
                distanceInKm: refreshedRide.distanceInKm,
                estimatedDuration: refreshedRide.estimatedDuration
              }
            }
          )
        }
      }
    } catch (socketError) {
      logger.warn('Ride destination updated but socket broadcast failed:', socketError)
    }

    return res.status(200).json(responsePayload)
  } catch (error) {
    logger.error('Error updating ride destination:', error)
    return res.status(500).json({
      success: false,
      message: 'Error updating ride destination',
      error: error.message
    })
  }
}



/**
 * @desc    Delete a ride by ID
 * @route   DELETE /rides/:id
 */
const deleteRide = async (req, res) => {
  try {
    const ride = await Ride.findByIdAndDelete(req.params.id)

    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' })
    }

    logger.info(`Ride deleted successfully: ${ride._id}`)
    res.status(200).json({ message: 'Ride deleted successfully' })
  } catch (error) {
    logger.error('Error deleting ride:', error)
    res.status(500).json({ message: 'Error deleting ride', error })
  }
}

/**
 * @desc    Get rides for a specific user by user ID
 * @route   GET /rides/user/:userId
 * @query   limit - Optional limit for number of rides to return
 * @query   status - Optional status filter (completed, cancelled, etc.)
 */
const getRidesByUserId = async (req, res) => {
  try {
    const { limit, status } = req.query
    const userId = req.params.userId
    
    let query = { rider: userId }
    
    // Optional status filter
    if (status) {
      query.status = status
    }
    
    let ridesQuery = Ride.find(query)
      .populate('driver', 'name phone rating totalTrips profilePic vehicleInfo')
      .populate('rider', 'name email phoneNumber')
      .sort({ updatedAt: -1 }) // Sort by most recent activity first
    
    // Apply limit if provided
    if (limit && !isNaN(parseInt(limit))) {
      ridesQuery = ridesQuery.limit(parseInt(limit))
    }
    
    const rides = await ridesQuery
    
    // Return empty array instead of 404 when no rides found
    res.status(200).json(rides || [])
  } catch (error) {
    logger.error('Error fetching rides for user:', error)
    res.status(500).json({ message: 'Error fetching rides for user', error })
  }
}

/**
 * @desc    Get upcoming scheduled bookings for a user
 * @route   GET /rides/user/:userId/upcoming-bookings
 */
const getUpcomingBookingsForUser = async (req, res) => {
  try {
    const { getUpcomingBookingsForUser: getUpcomingBookings } = require('../../utils/ride_booking_functions')
    
    // Check if user exists (optional, but good practice)
    // You can add user validation here if needed
    
    // Get upcoming bookings
    const upcomingBookings = await getUpcomingBookings(req.params.userId)

    res.status(200).json({
      message: 'Upcoming bookings retrieved successfully',
      bookings: upcomingBookings,
      count: upcomingBookings.length
    })
  } catch (error) {
    logger.error('Error fetching upcoming bookings for user:', error)
    res.status(500).json({ message: 'Error fetching upcoming bookings for user', error: error.message })
  }
}

/**
 * @desc    Get rides for a specific driver by driver ID
 * @route   GET /rides/driver/:driverId
 */
const getRidesByDriverId = async (req, res) => {
  try {
    const rides = await Ride.find({ driver: req.params.driverId })
    if (!rides || rides.length === 0) {
      return res.status(404).json({ message: 'No rides found for this driver' })
    }
    res.status(200).json(rides)
  } catch (error) {
    logger.error('Error fetching rides for driver:', error)
    res.status(500).json({ message: 'Error fetching rides for driver', error })
  }
}

// Search for nearby drivers based on user location
const searchRide = async (req, res) => {
  const { pickupLocation, dropoffLocation, rideType, tripMode, scheduleType } = req.body // User's locations
  const lat = pickupLocation?.lat ?? pickupLocation?.latitude
  const lon = pickupLocation?.lon ?? pickupLocation?.longitude

  if (lat === undefined || lon === undefined) {
    return res.status(400).json({
      success: false,
      message: 'pickupLocation must include lat/lon or latitude/longitude'
    })
  }

  try {
    if (String(rideType || '').toLowerCase() === 'intercity') {
      if (!dropoffLocation) {
        return res.status(400).json({
          success: false,
          message: 'dropoffLocation is required for intercity rides'
        })
      }

      const settings = await Settings.findOne()
      if (!settings) {
        return res.status(500).json({
          success: false,
          message: 'Admin settings not found'
        })
      }

      const intercityConfig = getIntercityPricingConfig(settings)
      const breakdown = calculateIntercityFareBreakdown({
        pickupLocation,
        dropoffLocation,
        durationMinutes: req.body.estimatedDuration || 0,
        vehicleType: req.body.vehicleType || 'cercaZip',
        tripMode: String(tripMode || 'one_way').toLowerCase() === 'round_trip'
          ? 'round_trip'
          : 'one_way',
        tollCharges: req.body.tollCharges || 0,
        parkingCharges: req.body.parkingCharges || 0,
        settings
      })

      return res.status(200).json({
        success: true,
        rideType: 'intercity',
        scheduleType: scheduleType || 'now',
        data: {
          distance: breakdown.distanceKm,
          estimatedDuration: breakdown.durationMinutes,
          fareBreakdown: breakdown,
          availableVehicleTypes: Object.keys(intercityConfig.perKmRates || {})
        }
      })
    }

    const nearbyDrivers = await Driver.find({
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [lon, lat] // MongoDB uses [longitude, latitude]
          },
          $maxDistance: 5000 // Example: 5 km radius
        }
      },
      isActive: true // Only active drivers
    })

    // Notify nearby drivers (via Socket.IO)
    // if (nearbyDrivers.length > 0) {
    //    getSocketIO().emit('newRideRequest', { userId: req.params.id, location: pickupLocation });
    // }

    res.status(200).json({ nearbyDrivers })
  } catch (error) {
    console.error(error)
    res.status(500).json({ message: 'Error fetching nearby drivers' })
  }
}

/**
 * @desc    Calculate fare with time component
 * @route   POST /rides/calculate-fare
 */
const calculateFare = async (req, res) => {
  try {
    const {
      pickupLocation,
      dropoffLocation,
      vehicleType,
      promoCode,
      userId,
      estimatedDuration
    } = req.body

    // Validate required fields
    if (!pickupLocation || !dropoffLocation) {
      return res.status(400).json({
        success: false,
        message: 'Pickup and dropoff locations are required'
      })
    }

    // Extract coordinates
    let pickupLat, pickupLng, dropoffLat, dropoffLng

    if (
      pickupLocation.coordinates &&
      Array.isArray(pickupLocation.coordinates)
    ) {
      ;[pickupLng, pickupLat] = pickupLocation.coordinates
    } else if (pickupLocation.latitude && pickupLocation.longitude) {
      pickupLat = pickupLocation.latitude
      pickupLng = pickupLocation.longitude
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid pickup location format'
      })
    }

    if (
      dropoffLocation.coordinates &&
      Array.isArray(dropoffLocation.coordinates)
    ) {
      ;[dropoffLng, dropoffLat] = dropoffLocation.coordinates
    } else if (dropoffLocation.latitude && dropoffLocation.longitude) {
      dropoffLat = dropoffLocation.latitude
      dropoffLng = dropoffLocation.longitude
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid dropoff location format'
      })
    }

    // Calculate distance using Haversine formula
    const distance = calculateHaversineDistance(
      pickupLat,
      pickupLng,
      dropoffLat,
      dropoffLng
    )

    const settings = await Settings.findOne()
    if (!settings) {
      return res.status(500).json({
        success: false,
        message: 'Admin settings not found'
      })
    }

    let duration = estimatedDuration
    if (!duration || duration <= 0) {
      const pc = settings.pricingConfigurations || {}
      const averageSpeedKmh =
        Number(pc.estimatedAverageSpeedKmh) > 0
          ? Number(pc.estimatedAverageSpeedKmh)
          : 35
      duration = Math.ceil((distance / averageSpeedKmh) * 60) // Convert to minutes
    }

    const rideType = String(req.body.rideType || 'normal').toLowerCase()
    const tripMode = String(req.body.tripMode || (req.body.roundTrip ? 'round_trip' : 'one_way')).toLowerCase() === 'round_trip'
      ? 'round_trip'
      : 'one_way'

    if (rideType === 'intercity') {
      const intercityConfig = getIntercityPricingConfig(settings)
      if (!intercityConfig.enabled) {
        return res.status(400).json({
          success: false,
          message: 'Intercity rides are currently disabled'
        })
      }

      if (
        req.body.pickupCity &&
        req.body.dropCity &&
        String(req.body.pickupCity).trim().toLowerCase() === String(req.body.dropCity).trim().toLowerCase()
      ) {
        return res.status(400).json({
          success: false,
          message: 'Intercity rides must be between different cities'
        })
      }

      const intercityVehicleKeyMap = {
        cercaZip: 'cercaZip',
        cercaGlide: 'cercaGlide',
        cercaTitan: 'cercaTitan',
        zip: 'cercaZip',
        glide: 'cercaGlide',
        titan: 'cercaTitan'
      }
      const vehicleServiceKey =
        intercityVehicleKeyMap[String(vehicleType || req.body.vehicleType || 'cercaZip').toLowerCase()] ||
        'cercaZip'

      const breakdown = calculateIntercityFareBreakdown({
        pickupLocation,
        dropoffLocation,
        durationMinutes: duration,
        vehicleType: vehicleServiceKey,
        tripMode,
        tollCharges: req.body.tollCharges || 0,
        parkingCharges: req.body.parkingCharges || 0,
        settings
      })

      return res.status(200).json({
        success: true,
        data: {
          distance: breakdown.distanceKm,
          estimatedDuration: breakdown.durationMinutes,
          fareBreakdown: {
            baseFare: breakdown.baseFare,
            distanceFare: breakdown.distanceFare,
            timeFare: 0,
            subtotal: breakdown.finalFare,
            minimumFare: 0,
            fareAfterMinimum: breakdown.finalFare,
            promoCode: null,
            discount: 0,
            finalFare: breakdown.finalFare,
            tollCharges: breakdown.tollCharges,
            parkingCharges: breakdown.parkingCharges,
            driverAllowance: breakdown.driverAllowance,
            driverEarnings: null,
            platformFees: null,
            adminEarnings: null
          },
          rideType: 'intercity',
          tripMode,
          vehicleType: vehicleServiceKey,
          availableVehicleTypes: Object.keys(intercityConfig.perKmRates || {})
        }
      })
    }

    const { perKmRate, minimumFare, platformFees, driverCommissions } =
      settings.pricingConfigurations

    const vehicleServicesNorm = normalizeVehicleServicesForResponse(
      settings.vehicleServices || {}
    )
    const rawTierInput = vehicleType ?? req.body.service
    const tierResolved = resolveCanonicalVehicleTier(rawTierInput)
    if (tierResolved === false) {
      return res.status(400).json({
        success: false,
        message: 'Invalid vehicle type'
      })
    }
    const vehicleServiceKey =
      tierResolved === null ? 'cercaZip' : tierResolved

    const vehicleService = vehicleServicesNorm[vehicleServiceKey]

    if (!vehicleService || !vehicleService.enabled) {
      return res.status(400).json({
        success: false,
        message: `Invalid or disabled vehicle type: ${vehicleType}`
      })
    }

    const basePrice = vehicleService.price || 0
    const perMinuteRate = vehicleService.perMinuteRate || 0

    // Calculate fare breakdown
    const fareBreakdown = calculateFareWithTime(
      basePrice,
      distance,
      duration,
      perKmRate,
      perMinuteRate,
      minimumFare
    )

    // Apply promo code if provided
    let discount = 0
    let finalFare = fareBreakdown.fareAfterMinimum
    let promoCodeApplied = null

    if (promoCode && userId) {
      const Coupon = require('../../Models/Admin/coupon.modal')
      const coupon = await Coupon.findOne({
        couponCode: promoCode.toUpperCase().trim()
      })

      if (coupon) {
        const canUse = coupon.canUserUse(userId)
        if (canUse.canUse) {
          // Map vehicleServiceKey to service names for coupon validation
          const serviceNameMap = {
            cercaZip: 'cercaZip',
            cercaGlide: 'cercaGlide',
            cercaTitan: 'cercaTitan'
          }
          const serviceName = serviceNameMap[vehicleServiceKey] || 'cercaZip'

          const serviceApplicable =
            !coupon.applicableServices ||
            coupon.applicableServices.length === 0 ||
            coupon.applicableServices.includes(serviceName)

          if (serviceApplicable) {
            const discountResult = coupon.calculateDiscount(
              fareBreakdown.fareAfterMinimum
            )
            if (discountResult.discount > 0) {
              discount = discountResult.discount
              finalFare = discountResult.finalFare
              promoCodeApplied = coupon.couponCode
            }
          }
        }
      }
    }

    // Calculate driver and admin earnings
    const driverEarnings = driverCommissions
      ? Math.round(finalFare * (driverCommissions / 100) * 100) / 100
      : Math.round((finalFare - finalFare * (platformFees / 100)) * 100) / 100
    const platformFee = platformFees
      ? Math.round(finalFare * (platformFees / 100) * 100) / 100
      : 0
    const adminEarnings = platformFee

    res.status(200).json({
      success: true,
      data: {
        distance: Math.round(distance * 100) / 100,
        estimatedDuration: duration,
        fareBreakdown: {
          baseFare: fareBreakdown.baseFare,
          distanceFare: fareBreakdown.distanceFare,
          timeFare: fareBreakdown.timeFare,
          subtotal: fareBreakdown.subtotal,
          minimumFare: minimumFare,
          fareAfterMinimum: fareBreakdown.fareAfterMinimum,
          promoCode: promoCodeApplied,
          discount: Math.round(discount * 100) / 100,
          finalFare: Math.round(finalFare * 100) / 100,
          // Earnings breakdown
          driverEarnings: driverEarnings,
          platformFees: platformFee,
          adminEarnings: adminEarnings
        },
        vehicleType: vehicleServiceKey,
        vehicleServiceKey: vehicleServiceKey
      }
    })
  } catch (error) {
    logger.error('Error calculating fare:', error)
    res.status(500).json({
      success: false,
      message: 'Error calculating fare',
      error: error.message
    })
  }
}

/**
 * @desc    Calculate fare for all enabled vehicle types at once
 * @route   POST /rides/calculate-all-fares
 */
const calculateAllFares = async (req, res) => {
  try {
    const {
      pickupLocation,
      dropoffLocation,
      promoCode,
      userId,
      estimatedDuration
    } = req.body

    // Validate required fields
    if (!pickupLocation || !dropoffLocation) {
      return res.status(400).json({
        success: false,
        message: 'Pickup and dropoff locations are required'
      })
    }

    // Extract coordinates
    let pickupLat, pickupLng, dropoffLat, dropoffLng

    if (
      pickupLocation.coordinates &&
      Array.isArray(pickupLocation.coordinates)
    ) {
      ;[pickupLng, pickupLat] = pickupLocation.coordinates
    } else if (pickupLocation.latitude && pickupLocation.longitude) {
      pickupLat = pickupLocation.latitude
      pickupLng = pickupLocation.longitude
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid pickup location format'
      })
    }

    if (
      dropoffLocation.coordinates &&
      Array.isArray(dropoffLocation.coordinates)
    ) {
      ;[dropoffLng, dropoffLat] = dropoffLocation.coordinates
    } else if (dropoffLocation.latitude && dropoffLocation.longitude) {
      dropoffLat = dropoffLocation.latitude
      dropoffLng = dropoffLocation.longitude
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid dropoff location format'
      })
    }

    // Calculate distance using Haversine formula
    const distance = calculateHaversineDistance(
      pickupLat,
      pickupLng,
      dropoffLat,
      dropoffLng
    )

    const settings = await Settings.findOne()
    if (!settings) {
      return res.status(500).json({
        success: false,
        message: 'Admin settings not found'
      })
    }

    let duration = estimatedDuration
    if (!duration || duration <= 0) {
      const pc = settings.pricingConfigurations || {}
      const averageSpeedKmh =
        Number(pc.estimatedAverageSpeedKmh) > 0
          ? Number(pc.estimatedAverageSpeedKmh)
          : 35
      duration = Math.ceil((distance / averageSpeedKmh) * 60) // Convert to minutes
    }

    const { perKmRate, minimumFare, platformFees, driverCommissions } =
      settings.pricingConfigurations
    const vehicleServices = normalizeVehicleServicesForResponse(
      settings.vehicleServices || {}
    )

    // Calculate fare for each enabled vehicle service
    const fares = {}

    for (const vehicleServiceKey of VEHICLE_SERVICE_KEYS) {
      const vehicleService = vehicleServices[vehicleServiceKey]

      // Skip if service doesn't exist or is disabled
      if (!vehicleService || !vehicleService.enabled) {
        continue
      }

      const basePrice = vehicleService.price || 0
      const perMinuteRate = vehicleService.perMinuteRate || 0

      // Calculate fare breakdown
      const fareBreakdown = calculateFareWithTime(
        basePrice,
        distance,
        duration,
        perKmRate,
        perMinuteRate,
        minimumFare
      )

      let finalFare = fareBreakdown.fareAfterMinimum
      let discount = 0
      let promoCodeApplied = null

      // Apply promo code if provided
      if (promoCode && userId) {
        const Coupon = require('../../Models/Admin/coupon.modal')
        const coupon = await Coupon.findOne({
          couponCode: promoCode.toUpperCase().trim()
        })

        if (coupon) {
          const canUse = coupon.canUserUse(userId)
          if (canUse.canUse) {
            // Map vehicleServiceKey to service names for coupon validation
            const serviceNameMap = {
              cercaZip: 'cercaZip',
              cercaGlide: 'cercaGlide',
              cercaTitan: 'cercaTitan'
            }
            const serviceName = serviceNameMap[vehicleServiceKey] || 'cercaZip'

            const serviceApplicable =
              !coupon.applicableServices ||
              coupon.applicableServices.length === 0 ||
              coupon.applicableServices.includes(serviceName)

            if (serviceApplicable) {
              const discountResult = coupon.calculateDiscount(
                fareBreakdown.fareAfterMinimum
              )
              if (discountResult.discount > 0) {
                discount = discountResult.discount
                finalFare = discountResult.finalFare
                promoCodeApplied = coupon.couponCode
              }
            }
          }
        }
      }

      // Calculate driver and admin earnings
      const driverEarnings = driverCommissions
        ? Math.round(finalFare * (driverCommissions / 100) * 100) / 100
        : Math.round((finalFare - finalFare * (platformFees / 100)) * 100) / 100
      const platformFee = platformFees
        ? Math.round(finalFare * (platformFees / 100) * 100) / 100
        : 0
      const adminEarnings = platformFee

      fares[vehicleServiceKey] = {
        baseFare: fareBreakdown.baseFare,
        distanceFare: fareBreakdown.distanceFare,
        timeFare: fareBreakdown.timeFare,
        subtotal: fareBreakdown.subtotal,
        minimumFare: minimumFare,
        fareAfterMinimum: fareBreakdown.fareAfterMinimum,
        promoCode: promoCodeApplied,
        discount: Math.round(discount * 100) / 100,
        finalFare: Math.round(finalFare * 100) / 100,
        driverEarnings: driverEarnings,
        platformFees: platformFee,
        adminEarnings: adminEarnings
      }
    }

    res.status(200).json({
      success: true,
      data: {
        distance: Math.round(distance * 100) / 100,
        estimatedDuration: duration,
        fares: fares
      }
    })
  } catch (error) {
    logger.error('Error calculating all fares:', error)
    res.status(500).json({
      success: false,
      message: 'Error calculating fares',
      error: error.message
    })
  }
}

/**
 * Helper function to extract userId from JWT token
 * @param {Object} req - Express request object
 * @returns {string|null} User ID or null if not found
 */
function getUserIdFromToken (req) {
  try {
    const authHeader =
      req.headers.authorization || req.headers.Authorization || ''
    if (!authHeader.startsWith('Bearer ')) {
      return null
    }
    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(
      token,
      '@#@!#@dasd4234jkdh3874#$@#$#$@#$#$dkjashdlk$#442343%#$%f34234T$vtwefcEC$%'
    )
    return decoded.id || decoded.userId || null
  } catch (error) {
    return null
  }
}

/**
 * @desc    Generate share link for a ride
 * @route   POST /rides/:rideId/share
 */
const generateShareLink = async (req, res) => {
  try {
    logger.info(
      `[generateShareLink] Request received: ${req.method} ${req.path}`
    )
    logger.info(`[generateShareLink] Params:`, req.params)
    logger.info(`[generateShareLink] Headers:`, {
      authorization: req.headers.authorization ? 'Bearer ***' : 'missing',
      'content-type': req.headers['content-type']
    })

    const { rideId } = req.params
    logger.info(`[generateShareLink] Ride ID: ${rideId}`)

    const userId = getUserIdFromToken(req)
    logger.info(`[generateShareLink] User ID extracted: ${userId || 'null'}`)

    if (!userId) {
      logger.warn(`[generateShareLink] Authentication failed - no user ID`)
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      })
    }

    // Find the ride
    const ride = await Ride.findById(rideId)
    if (!ride) {
      return res.status(404).json({
        success: false,
        message: 'Ride not found'
      })
    }

    // Verify ride belongs to user
    if (ride.rider.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to share this ride'
      })
    }

    // Check if ride is active (can only share active rides)
    const activeStatuses = ['requested', 'accepted', 'arrived', 'in_progress']
    if (!activeStatuses.includes(ride.status)) {
      return res.status(400).json({
        success: false,
        message: 'Can only share active rides'
      })
    }

    // Generate token if not exists or expired
    let shareToken = ride.shareToken
    let shareTokenExpiresAt = ride.shareTokenExpiresAt

    if (
      !shareToken ||
      (shareTokenExpiresAt && new Date() > new Date(shareTokenExpiresAt))
    ) {
      const tokenData = generateTokenForRide(ride)
      shareToken = tokenData.token
      shareTokenExpiresAt = tokenData.expiresAt

      // Update ride with share token
      ride.shareToken = shareToken
      ride.shareTokenExpiresAt = shareTokenExpiresAt
      ride.isShared = true
      ride.shareCreatedAt = new Date()
      await ride.save()
    } else {
      // Update isShared flag if token exists
      if (!ride.isShared) {
        ride.isShared = true
        ride.shareCreatedAt = ride.shareCreatedAt || new Date()
        await ride.save()
      }
    }

    // Generate share URL
    // Priority: SHARE_BASE_URL env var > FRONTEND_URL env var > derive from API domain > default fallback
    let baseUrl = process.env.SHARE_BASE_URL || process.env.FRONTEND_URL

    // If no env var set, try to derive from API domain
    // If API is api.cercacars.online, frontend is likely cercacars.online
    if (!baseUrl) {
      const apiUrl = process.env.API_URL || 'https://api.cercacars.online'
      try {
        const apiUrlObj = new URL(apiUrl)
        // Convert api.cercacars.online -> cercacars.online
        // Or api.cerca.app -> cerca.app
        const hostname = apiUrlObj.hostname
        if (hostname.startsWith('api.')) {
          baseUrl = `${apiUrlObj.protocol}//${hostname.substring(4)}` // Remove 'api.' prefix
        } else if (hostname.includes('api-')) {
          // Handle api-subdomain patterns
          baseUrl = `${apiUrlObj.protocol}//${hostname.replace('api-', '')}`
        } else {
          // If API is at root, try common frontend subdomains
          baseUrl = `${apiUrlObj.protocol}//app.${hostname}`
        }
      } catch (e) {
        logger.warn('Could not parse API URL for share link generation:', e)
      }
    }

    // Use API domain for share links (since HTML page is served by Express backend)
    // The share link should point to the backend server where the HTML page is hosted
    const apiUrl =
      process.env.API_URL ||
      req.protocol + '://' + req.get('host') ||
      'https://api.cercacars.online'

    // Generate share URL pointing to Express HTML page
    // Format: https://api.cercacars.online/shared-ride/{token}
    const shareUrl = `${apiUrl}/shared-ride/${shareToken}`

    logger.info(`Share URL generated: ${shareUrl} (API URL: ${apiUrl})`)

    logger.info(`Share link generated for ride ${rideId} by user ${userId}`)

    res.status(200).json({
      success: true,
      data: {
        shareUrl,
        shareToken,
        expiresAt: shareTokenExpiresAt,
        isShared: true
      }
    })
  } catch (error) {
    logger.error('Error generating share link:', error)
    res.status(500).json({
      success: false,
      message: 'Error generating share link',
      error: error.message
    })
  }
}

/**
 * @desc    Get shared ride data by token (public endpoint)
 * @route   GET /rides/shared/:shareToken
 */
const getSharedRide = async (req, res) => {
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
      .populate('driver', 'name rating vehicleInfo location')
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

    // Sanitize ride data (remove sensitive information)
    const sanitizedRide = sanitizeRideData(ride)

    logger.info(
      `Shared ride accessed: ${ride._id} with token ${shareToken.substring(
        0,
        8
      )}...`
    )

    res.status(200).json({
      success: true,
      data: sanitizedRide
    })
  } catch (error) {
    logger.error('Error fetching shared ride:', error)
    res.status(500).json({
      success: false,
      message: 'Error fetching shared ride',
      error: error.message
    })
  }
}

/**
 * @desc    Serve shared ride HTML page
 * @route   GET /shared-ride/:shareToken
 */
const serveSharedRidePage = async (req, res) => {
  try {
    const { shareToken } = req.params

    if (!shareToken) {
      return res.status(400).send('Invalid share link. No token provided.')
    }

    // Validate token by checking if ride exists
    const ride = await Ride.findOne({ shareToken })
      .populate('driver', 'name rating vehicleInfo')
      .populate('rider', 'fullName')

    if (!ride) {
      return res.status(404).send('Ride not found or link is invalid')
    }

    // Validate token expiration
    const validation = validateShareToken(shareToken, ride.shareTokenExpiresAt)
    if (!validation.isValid) {
      if (validation.reason === 'EXPIRED') {
        ride.isShared = false
        await ride.save()
      }
      return res
        .status(400)
        .send(
          `Share link ${
            validation.reason === 'EXPIRED' ? 'has expired' : 'is invalid'
          }`
        )
    }

    // Check if ride is completed or cancelled
    if (ride.status === 'completed' || ride.status === 'cancelled') {
      ride.isShared = false
      ride.shareTokenExpiresAt = new Date()
      await ride.save()
      return res.status(400).send('This ride has ended')
    }

    // Read and serve HTML file
    // Path from Controllers/User/ride.controller.js to public/views/shared-ride.html
    const htmlPath = path.join(__dirname, '../../public/views/shared-ride.html')

    try {
      if (!fs.existsSync(htmlPath)) {
        logger.error(`HTML file not found at: ${htmlPath}`)
        return res.status(500).send('Page not found')
      }

      const htmlContent = fs.readFileSync(htmlPath, 'utf8')
      res.setHeader('Content-Type', 'text/html')
      res.status(200).send(htmlContent)
    } catch (fileError) {
      logger.error('Error reading HTML file:', fileError)
      logger.error('Attempted path:', htmlPath)
      res.status(500).send('Error loading page')
    }
  } catch (error) {
    logger.error('Error serving shared ride page:', error)
    res.status(500).send('Error loading page')
  }
}

/**
 * @desc    Revoke share link for a ride
 * @route   DELETE /rides/:rideId/share
 */
const revokeShareLink = async (req, res) => {
  try {
    const { rideId } = req.params
    const userId = getUserIdFromToken(req)

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      })
    }

    // Find the ride
    const ride = await Ride.findById(rideId)
    if (!ride) {
      return res.status(404).json({
        success: false,
        message: 'Ride not found'
      })
    }

    // Verify ride belongs to user
    if (ride.rider.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to revoke this share link'
      })
    }

    // Revoke share
    ride.shareToken = null
    ride.shareTokenExpiresAt = null
    ride.isShared = false
    await ride.save()

    logger.info(`Share link revoked for ride ${rideId} by user ${userId}`)

    res.status(200).json({
      success: true,
      message: 'Share link revoked successfully'
    })
  } catch (error) {
    logger.error('Error revoking share link:', error)
    res.status(500).json({
      success: false,
      message: 'Error revoking share link',
      error: error.message
    })
  }
}

const createRideLiveLocationShare = async (req, res) => {
  try {
    const { rideId } = req.params
    const userId = getUserIdFromToken(req)

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      })
    }

    const ride = await Ride.findById(rideId)
    if (!ride) {
      return res.status(404).json({
        success: false,
        message: 'Ride not found'
      })
    }

    if (ride.rider.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to share this ride location'
      })
    }

    const {
      recipientName,
      recipientPhone,
      recipientEmail,
      recipientType,
      relation,
      durationMinutes
    } = req.body

    if (!recipientName) {
      return res.status(400).json({
        success: false,
        message: 'recipientName is required'
      })
    }

    const share = await createLiveLocationShare({
      ownerId: userId,
      ownerModel: 'User',
      rideId,
      recipientName,
      recipientPhone,
      recipientEmail,
      recipientType,
      relation,
      durationMinutes: durationMinutes || 180
    })

    const apiUrl =
      process.env.API_URL ||
      req.protocol + '://' + req.get('host')

    res.status(201).json({
      success: true,
      message: 'Ride live location share created successfully',
      data: {
        shareId: share._id,
        shareUrl: `${apiUrl}/rides/live-location/shared/${share.shareToken}`,
        expiresAt: share.expiresAt,
        recipientName: share.recipientName,
        recipientType: share.recipientType
      }
    })
  } catch (error) {
    logger.error('Error creating ride live location share:', error)
    res.status(500).json({
      success: false,
      message: 'Error creating ride live location share',
      error: error.message
    })
  }
}

const listRideLiveLocationShares = async (req, res) => {
  try {
    const userId = getUserIdFromToken(req)
    const { rideId } = req.params

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' })
    }

    const ride = await Ride.findById(rideId)
    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' })
    }

    if (ride.rider.toString() !== userId.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied' })
    }

    const shares = await LiveLocationShare.find({
      owner: userId,
      ownerModel: 'User',
      ride: rideId
    }).sort({ createdAt: -1 })

    res.status(200).json({
      success: true,
      data: shares
    })
  } catch (error) {
    logger.error('Error listing ride live location shares:', error)
    res.status(500).json({
      success: false,
      message: 'Error listing ride live location shares',
      error: error.message
    })
  }
}

const revokeRideLiveLocationShare = async (req, res) => {
  try {
    const userId = getUserIdFromToken(req)
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' })
    }

    const share = await revokeLiveLocationShare(req.params.shareId, userId)
    if (!share) {
      return res.status(404).json({ success: false, message: 'Share not found' })
    }

    res.status(200).json({
      success: true,
      message: 'Ride live location share revoked successfully',
      data: share
    })
  } catch (error) {
    logger.error('Error revoking ride live location share:', error)
    res.status(500).json({
      success: false,
      message: 'Error revoking ride live location share',
      error: error.message
    })
  }
}

const getSharedLiveLocation = async (req, res) => {
  try {
    const data = await getSharedLiveLocationPayload(req.params.shareToken)
    res.status(200).json({
      success: true,
      data
    })
  } catch (error) {
    logger.error('Error fetching shared live location:', error)
    res.status(400).json({
      success: false,
      message: error.message
    })
  }
}

/**
 * GET /rides/:id/rider-in-progress-cancel-billing?userId=
 * Rider-safe billing summary for driver-cancelled in-progress trips (socket may omit details).
 */
const getRiderInProgressCancelBilling = async (req, res) => {
  try {
    const rideId = req.params.id
    const userId = req.query.userId
    if (!mongoose.Types.ObjectId.isValid(rideId)) {
      return res.status(404).json({ success: false, message: 'Ride not found' })
    }
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' })
    }
    const ride = await Ride.findById(rideId)
      .select(
        'rider status cancelledBy driverInProgressCancelSettlement cancellationReason'
      )
      .lean()
    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' })
    }
    if (String(ride.rider) !== String(userId)) {
      return res.status(403).json({ success: false, message: 'Unauthorized' })
    }
    if (ride.status !== 'cancelled' || ride.cancelledBy !== 'driver') {
      return res.status(200).json({
        success: true,
        data: {
          summary: null,
          cancellationReason: ride.cancellationReason || null
        }
      })
    }
    const summary = rideBookingFunctions.toRiderInProgressCancelBillingSummary(
      ride.driverInProgressCancelSettlement
    )
    return res.status(200).json({
      success: true,
      data: {
        summary,
        cancellationReason: ride.cancellationReason || null
      }
    })
  } catch (error) {
    logger.error('getRiderInProgressCancelBilling:', error)
    res.status(500).json({ success: false, message: error.message })
  }
}

const {
  riderAcknowledgeDriverInProgressCancel,
  riderConfirmCashDriverInProgressCancel,
  riderPayWalletDriverInProgressCancel,
  riderVerifyRazorpayDriverInProgressCancel
} = rideBookingFunctions

/**
 * POST /rides/:rideId/driver-cancel-settlement/acknowledge
 * Rider confirms receipt when no additional amount is due (or to sync ledger).
 */
const acknowledgeDriverCancelSettlement = async (req, res) => {
  try {
    const { rideId } = req.params
    const { userId } = req.body
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' })
    }
    const result = await riderAcknowledgeDriverInProgressCancel(rideId, userId)
    const ride = await Ride.findById(rideId).populate('driver rider')
    res.status(200).json({ success: true, data: { result, ride } })
  } catch (error) {
    logger.error('acknowledgeDriverCancelSettlement:', error)
    res.status(400).json({ success: false, message: error.message })
  }
}

/**
 * POST /rides/:rideId/driver-cancel-settlement/confirm-cash
 */
const confirmCashDriverCancelSettlement = async (req, res) => {
  try {
    const { rideId } = req.params
    const { userId } = req.body
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' })
    }
    const result = await riderConfirmCashDriverInProgressCancel(rideId, userId)
    const ride = await Ride.findById(rideId).populate('driver rider')
    res.status(200).json({ success: true, data: { result, ride } })
  } catch (error) {
    logger.error('confirmCashDriverCancelSettlement:', error)
    res.status(400).json({ success: false, message: error.message })
  }
}

/**
 * POST /rides/:rideId/driver-cancel-settlement/pay-wallet
 */
const payWalletDriverCancelSettlement = async (req, res) => {
  try {
    const { rideId } = req.params
    const { userId } = req.body
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' })
    }
    const result = await riderPayWalletDriverInProgressCancel(rideId, userId)
    const ride = await Ride.findById(rideId).populate('driver rider')
    res.status(200).json({ success: true, data: { result, ride } })
  } catch (error) {
    logger.error('payWalletDriverCancelSettlement:', error)
    res.status(400).json({ success: false, message: error.message })
  }
}

/**
 * POST /rides/:rideId/driver-cancel-settlement/verify-razorpay
 */
const verifyRazorpayDriverCancelSettlement = async (req, res) => {
  try {
    const { rideId } = req.params
    const { userId, razorpay_payment_id: razorpayPaymentId } = req.body
    if (!userId || !razorpayPaymentId) {
      return res.status(400).json({
        success: false,
        message: 'userId and razorpay_payment_id are required'
      })
    }
    const result = await riderVerifyRazorpayDriverInProgressCancel(
      rideId,
      userId,
      razorpayPaymentId
    )
    const ride = await Ride.findById(rideId).populate('driver rider')
    res.status(200).json({ success: true, data: { result, ride } })
  } catch (error) {
    logger.error('verifyRazorpayDriverCancelSettlement:', error)
    res.status(400).json({ success: false, message: error.message })
  }
}

module.exports = {
  createRide,
  getAllRides,
  getRideById,
  updateRide,
  deleteRide,
  getRidesByUserId,
  getUpcomingBookingsForUser,
  getRidesByDriverId,
  searchRide,
  calculateFare,
  calculateAllFares,
  generateShareLink,
  getSharedRide,
  revokeShareLink,
  serveSharedRidePage,
  createRideLiveLocationShare,
  listRideLiveLocationShares,
  revokeRideLiveLocationShare,
  getSharedLiveLocation,
  getRiderInProgressCancelBilling,
  updateRideDestination,
  getDestinationQuote,
  acknowledgeDriverCancelSettlement,
  confirmCashDriverCancelSettlement,
  payWalletDriverCancelSettlement,
  verifyRazorpayDriverCancelSettlement,
  switchRideToCash
}
