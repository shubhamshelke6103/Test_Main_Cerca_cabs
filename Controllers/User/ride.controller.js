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
  mapServiceToVehicleService,
  calculateFareWithTime,
  calculateHaversineDistance
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
const createRide = async (req, res) => {
  try {
    const rideData = req.body

    // ============================
    // Rider Security (Extract from Token)
    // ============================
    const riderId =
      getUserIdFromToken(req) || rideData.rider || rideData.riderId

    if (!riderId) {
      return res.status(401).json({ message: 'Rider authentication required' })
    }

    rideData.rider = riderId
    delete rideData.riderId // ⭐ cleanup legacy field


    // ============================
    // Ride For Handling
    // ============================
    rideData.rideFor = rideData.rideFor || 'SELF'

    if (rideData.rideFor === 'OTHER') {
      if (!rideData.passenger?.name || !rideData.passenger?.phone) {
        return res.status(400).json({
          message:
            'Passenger name and phone are required when booking ride for another person'
        })
      }
    }


    // ============================
    // Validate Location Payload
    // ============================
    if (
      !rideData.pickupLocation?.coordinates ||
      !rideData.dropoffLocation?.coordinates
    ) {
      return res.status(400).json({
        message: 'Pickup and dropoff coordinates are required'
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
      return res.status(409).json({
        message:
          'You already have an active ride. Please cancel it before booking a new one.',
        activeRideId: existingActiveRide._id
      })
    }


    // ============================
    // Fetch Admin Settings
    // ============================
    const settings = await Settings.findOne()
    if (!settings) {
      return res.status(500).json({ message: 'Admin settings not found' })
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

    rideData.distanceInKm = distance


    // ============================
    // Service Validation
    // ============================
    const selectedService = rideData.service?.toLowerCase()

    const service = settings.services.find(
      s => s.name.toLowerCase() === selectedService
    )

    if (!service) {
      return res.status(400).json({ message: 'Invalid service selected' })
    }1


    // ============================
    // Fare Calculation
    // ============================
    let fare = service.price + distance * perKmRate
    fare = Math.max(fare, minimumFare)

    rideData.fare = fare
    rideData.service = service.name.toLowerCase()


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
    const ride = new Ride(rideData)
    await ride.save()

    logger.info(`Ride created successfully with ID: ${ride._id}`)


    // ============================
    // Queue Ride For Driver Discovery
    // ============================
    logger.info(`📥 Queuing ride ${ride._id} for driver discovery`)

    await rideBookingProducer.add('process-ride', {
      rideId: ride._id.toString()
    })

    logger.info(`✅ Ride ${ride._id} successfully added to Redis queue`)


    // ============================
    // Response
    // ============================
    res.status(201).json({
      ride,
      otpReceiver: ride.otpReceiver,
      startOtp,
      stopOtp
    })

  } catch (error) {

    logger.error('Error creating ride:', error)

    res.status(400).json({
      message: 'Error creating ride',
      error: error.message
    })
  }
}


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
const getAllRides = async (req, res) => {
  try {
    const rides = await Ride.find()
    res.status(200).json(rides)
  } catch (error) {
    logger.error('Error fetching rides:', error)
    res.status(500).json({ message: 'Error fetching rides', error })
  }
}

/**
 * @desc    Get a single ride by ID
 * @route   GET /rides/:id
 */
const getRideById = async (req, res) => {
  try {
    const rideId = req.params.id

    // Reject non-ObjectId values (like favicon.ico, robots.txt, etc.)
    if (!mongoose.Types.ObjectId.isValid(rideId)) {
      return res.status(404).json({ message: 'Ride not found' })
    }

    const ride = await Ride.findById(rideId).populate('driver rider')
    if (!ride) {
      return res.status(404).json({ message: 'Ride not found' })
    }
    res.status(200).json(ride)
  } catch (error) {
    logger.error('Error fetching ride:', error)
    res.status(500).json({ message: 'Error fetching ride', error })
  }
}

/**
 * @desc    Update a ride by ID
 * @route   PUT /rides/:id
 */
const updateRide = async (req, res) => {
  try {

    const rideId = req.params.id
    const updateData = req.body

    // ============================
    // Fetch Existing Ride
    // ============================
    const existingRide = await Ride.findById(rideId)

    if (!existingRide) {
      return res.status(404).json({ message: 'Ride not found' })
    }

    // ============================
    // SECURITY RULES
    // ============================

    // ❌ Prevent rider change
    if (updateData.rider && updateData.rider.toString() !== existingRide.rider.toString()) {
      return res.status(400).json({
        message: 'Rider cannot be changed'
      })
    }

    // ❌ Prevent rideFor change after driver accepted ride
    if (
      updateData.rideFor &&
      updateData.rideFor !== existingRide.rideFor &&
      ['accepted', 'in_progress', 'completed'].includes(existingRide.status)
    ) {
      return res.status(400).json({
        message: 'rideFor cannot be changed after ride is accepted'
      })
    }

    // ❌ Prevent passenger modification after acceptance
    if (
      updateData.passenger &&
      ['accepted', 'in_progress', 'completed'].includes(existingRide.status)
    ) {
      return res.status(400).json({
        message: 'Passenger details cannot be modified after ride is accepted'
      })
    }

    // ❌ Prevent OTP tampering
    if (updateData.startOtp || updateData.stopOtp) {
      return res.status(400).json({
        message: 'OTP values cannot be updated'
      })
    }

    // ============================
    // Perform Update
    // ============================
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

  } catch (error) {

    logger.error('Error updating ride:', error)

    res.status(400).json({
      message: 'Error updating ride',
      error: error.message
    })
  }
}

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
        const destinationUpdateEvent = {
          ride: refreshedRide,
          pricing: responsePayload.pricing
        }

        io.to(`ride_${rideId}`).emit('rideDestinationUpdated', destinationUpdateEvent)
        io.to(`ride_${rideId}`).emit('rideUpdated', destinationUpdateEvent)

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

        io.to('admin').emit('rideStatusUpdated', {
          rideId,
          status: refreshedRide.status,
          ride: refreshedRide
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
  const { pickupLocation } = req.body // User's pickup location (lat, lon)
  const { lat, lon } = pickupLocation

  try {
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

    // Estimate duration if not provided (using average speed of 35 km/h for city driving)
    let duration = estimatedDuration
    if (!duration || duration <= 0) {
      const averageSpeedKmh = 35.0
      duration = Math.ceil((distance / averageSpeedKmh) * 60) // Convert to minutes
    }

    // Fetch admin settings
    const settings = await Settings.findOne()
    if (!settings) {
      return res.status(500).json({
        success: false,
        message: 'Admin settings not found'
      })
    }

    const { perKmRate, minimumFare, platformFees, driverCommissions } =
      settings.pricingConfigurations

    // Map vehicle type directly to vehicleService keys
    const vehicleServiceKeyMap = {
      small: 'cercaSmall',
      medium: 'cercaMedium',
      large: 'cercaLarge'
    }
    const vehicleServiceKey = vehicleServiceKeyMap[vehicleType] || 'cercaSmall'

    // Get vehicle service directly from vehicleServices
    const vehicleService = settings.vehicleServices?.[vehicleServiceKey]

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
            cercaSmall: 'hatchback',
            cercaMedium: 'sedan',
            cercaLarge: 'suv'
          }
          const serviceName = serviceNameMap[vehicleServiceKey] || 'hatchback'

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
        vehicleType: vehicleType || 'small',
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

    // Estimate duration if not provided (using average speed of 35 km/h for city driving)
    let duration = estimatedDuration
    if (!duration || duration <= 0) {
      const averageSpeedKmh = 35.0
      duration = Math.ceil((distance / averageSpeedKmh) * 60) // Convert to minutes
    }

    // Fetch admin settings
    const settings = await Settings.findOne()
    if (!settings) {
      return res.status(500).json({
        success: false,
        message: 'Admin settings not found'
      })
    }

    const { perKmRate, minimumFare, platformFees, driverCommissions } =
      settings.pricingConfigurations
    const vehicleServices = settings.vehicleServices || {}

    // Calculate fare for each enabled vehicle service
    const fares = {}
    const vehicleServiceKeys = ['cercaSmall', 'cercaMedium', 'cercaLarge']

    for (const vehicleServiceKey of vehicleServiceKeys) {
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
              cercaSmall: 'hatchback',
              cercaMedium: 'sedan',
              cercaLarge: 'suv'
            }
            const serviceName = serviceNameMap[vehicleServiceKey] || 'hatchback'

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
    // If API is api.myserverdevops.com, frontend is likely myserverdevops.com
    if (!baseUrl) {
      const apiUrl = process.env.API_URL || 'https://api.myserverdevops.com'
      try {
        const apiUrlObj = new URL(apiUrl)
        // Convert api.myserverdevops.com -> myserverdevops.com
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
      'https://api.myserverdevops.com'

    // Generate share URL pointing to Express HTML page
    // Format: https://api.myserverdevops.com/shared-ride/{token}
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
  updateRideDestination,
  getDestinationQuote,
  acknowledgeDriverCancelSettlement,
  confirmCashDriverCancelSettlement,
  payWalletDriverCancelSettlement,
  verifyRazorpayDriverCancelSettlement
}
