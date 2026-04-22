const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const Ride = require('../Models/Driver/ride.model');
const Driver = require('../Models/Driver/driver.model');
const { getSocketIO } = require('./socket');
const { createNotification } = require('./ride_booking_functions');
const { redis } = require('../config/redis');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyDQq0QpnwQKzDR99ObP1frWj_uRTQ54pbo';
const DIRECTIONS_API_URL = 'https://maps.googleapis.com/maps/api/directions/json';

// Load proximity config
let proximityConfig = {};
try {
  const configPath = path.join(__dirname, '../config/proximityConfig.json');
  proximityConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  logger.error('Failed to load proximity config:', error);
  proximityConfig = {
    proximityRideAssignment: {
      enabled: false,
      maxTravelTimeMinutes: 15,
      maxDistanceKm: 5,
      searchRadiusKm: 3,
      maxConcurrentRides: 1,
      notificationCooldownMinutes: 5,
      maxProximityRidesPerHour: 10
    }
  };
}

/**
 * Helper function to make HTTPS GET requests
 */
const httpsGet = (url) => {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    };

    const req = https.get(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          resolve(jsonData);
        } catch (error) {
          reject(new Error('Failed to parse JSON response'));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
};

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {Array} coord1 [longitude, latitude]
 * @param {Array} coord2 [longitude, latitude]
 * @returns {number} Distance in kilometers
 */
const calculateHaversineDistance = (coord1, coord2) => {
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;

  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

/**
 * Get travel time and distance from Google Maps Directions API
 * @param {Array} origin [longitude, latitude]
 * @param {Array} destination [longitude, latitude]
 * @returns {Promise<Object>} {durationMinutes, distanceKm, status}
 */
const getTravelTimeAndDistance = async (origin, destination) => {
  try {
    const [originLng, originLat] = origin;
    const [destLng, destLat] = destination;

    const url = `${DIRECTIONS_API_URL}?origin=${originLat},${originLng}&destination=${destLat},${destLng}&key=${GOOGLE_MAPS_API_KEY}&units=metric&mode=driving`;

    const data = await httpsGet(url);

    if (data.status !== 'OK') {
      logger.warn(`Google Directions API error: ${data.status}`);
      // Fallback to haversine distance
      const distanceKm = calculateHaversineDistance(origin, destination);
      return {
        durationMinutes: Math.ceil(distanceKm * 2), // Rough estimate: 30km/h average
        distanceKm,
        status: 'FALLBACK'
      };
    }

    const route = data.routes[0];
    if (!route || !route.legs || route.legs.length === 0) {
      throw new Error('No route found');
    }

    const leg = route.legs[0];
    const durationMinutes = Math.ceil(leg.duration.value / 60); // Convert seconds to minutes
    const distanceKm = leg.distance.value / 1000; // Convert meters to km

    return {
      durationMinutes,
      distanceKm,
      status: 'OK'
    };
  } catch (error) {
    logger.error('Error calculating travel time:', error);
    // Fallback to haversine distance
    const distanceKm = calculateHaversineDistance(origin, destination);
    return {
      durationMinutes: Math.ceil(distanceKm * 2),
      distanceKm,
      status: 'ERROR_FALLBACK'
    };
  }
};

/**
 * Check if driver is within proximity threshold of their destination
 * @param {string} driverId
 * @param {Array} currentLocation [longitude, latitude]
 * @returns {Promise<Object>} {isNearDestination, ride, travelInfo}
 */
const checkDriverProximityToDestination = async (driverId, currentLocation) => {
  try {
    // Find driver's current in_progress ride
    const ride = await Ride.findOne({
      driver: driverId,
      status: 'in_progress'
    }).populate('rider', 'name phone');

    if (!ride) {
      return { isNearDestination: false, ride: null, travelInfo: null };
    }

    const destination = ride.dropoffLocation.coordinates; // [lng, lat]

    // Calculate travel time and distance
    const travelInfo = await getTravelTimeAndDistance(currentLocation, destination);

    const config = proximityConfig.proximityRideAssignment;

    // Check if within thresholds
    const withinTimeThreshold = travelInfo.durationMinutes <= config.maxTravelTimeMinutes;
    const withinDistanceThreshold = travelInfo.distanceKm <= config.maxDistanceKm;

    const isNearDestination = withinTimeThreshold || withinDistanceThreshold;

    logger.info(`Driver ${driverId} proximity check: ${travelInfo.durationMinutes}min, ${travelInfo.distanceKm}km, near: ${isNearDestination}`);

    return {
      isNearDestination,
      ride,
      travelInfo
    };
  } catch (error) {
    logger.error('Error checking driver proximity:', error);
    return { isNearDestination: false, ride: null, travelInfo: null };
  }
};

/**
 * Find available rides near a destination point
 * @param {Array} destinationCoords [longitude, latitude]
 * @param {number} searchRadiusKm
 * @param {string} excludeDriverId
 * @param {string} vehicleType
 * @returns {Promise<Array>} Array of nearby rides
 */
const findRidesNearDestination = async (destinationCoords, searchRadiusKm, excludeDriverId, vehicleType) => {
  try {
    const [destLng, destLat] = destinationCoords;

    // Find rides within radius that are requested and not assigned
    const rides = await Ride.find({
      status: 'requested',
      driver: { $exists: false },
      pickupLocation: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [destLng, destLat]
          },
          $maxDistance: searchRadiusKm * 1000 // Convert km to meters
        }
      },
      vehicleType: vehicleType || { $exists: true },
      rejectedDrivers: { $ne: excludeDriverId }
    })
    .populate('rider', 'name phone')
    .limit(5) // Limit to 5 rides to avoid spam
    .sort({ createdAt: 1 }); // Oldest first

    logger.info(`Found ${rides.length} rides near destination for driver ${excludeDriverId}`);

    return rides;
  } catch (error) {
    logger.error('Error finding rides near destination:', error);
    return [];
  }
};

/**
 * Check if driver can receive proximity ride notifications
 * @param {string} driverId
 * @returns {Promise<boolean>}
 */
const canReceiveProximityRide = async (driverId) => {
  try {
    const config = proximityConfig.proximityRideAssignment;

    // Check cooldown
    const cooldownKey = `proximity_cooldown:${driverId}`;
    const lastNotification = await redis.get(cooldownKey);

    if (lastNotification) {
      const timeSinceLast = Date.now() - parseInt(lastNotification);
      const cooldownMs = config.notificationCooldownMinutes * 60 * 1000;
      if (timeSinceLast < cooldownMs) {
        return false;
      }
    }

    // Check hourly limit
    const hourKey = `proximity_hour:${driverId}`;
    const hourCount = await redis.get(hourKey);
    if (hourCount && parseInt(hourCount) >= config.maxProximityRidesPerHour) {
      return false;
    }

    // Check if driver is already accepting a ride
    const acceptingRide = await Ride.findOne({
      driver: driverId,
      status: { $in: ['accepted', 'upcoming'] },
      createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) } // Within last 5 minutes
    });

    if (acceptingRide) {
      return false;
    }

    return true;
  } catch (error) {
    logger.error('Error checking proximity ride eligibility:', error);
    return false;
  }
};

/**
 * Send proximity ride notification to driver
 * @param {string} driverId
 * @param {Object} ride
 * @returns {Promise<boolean>} Success status
 */
const sendProximityRideNotification = async (driverId, ride) => {
  try {
    const io = getSocketIO();

    // Create notification
    await createNotification({
      recipientId: driverId,
      recipientModel: 'Driver',
      title: 'Nearby Ride Available',
      message: 'A ride is available near your destination. Accept it to continue seamlessly.',
      type: 'proximity_ride_request',
      relatedRide: ride._id.toString(),
      data: {
        rideId: ride._id.toString(),
        type: 'proximity',
        destinationPickup: true
      }
    });

    // Send socket event
    const driver = await Driver.findById(driverId);
    if (driver && driver.socketId) {
      io.to(driver.socketId).emit('newRideRequest', {
        ...ride.toObject(),
        proximityNotification: true,
        message: 'This ride is near your destination - accept to continue seamlessly!'
      });
    }

    // Update cooldown and hourly counters
    const config = proximityConfig.proximityRideAssignment;
    const cooldownKey = `proximity_cooldown:${driverId}`;
    const hourKey = `proximity_hour:${driverId}`;

    await redis.set(cooldownKey, Date.now().toString(), 'EX', config.notificationCooldownMinutes * 60);

    // Increment hourly counter (expires in 1 hour)
    const currentCount = await redis.get(hourKey);
    const newCount = (currentCount ? parseInt(currentCount) : 0) + 1;
    await redis.set(hourKey, newCount.toString(), 'EX', 3600);

    logger.info(`Sent proximity ride notification to driver ${driverId} for ride ${ride._id}`);
    return true;
  } catch (error) {
    logger.error('Error sending proximity ride notification:', error);
    return false;
  }
};

/**
 * Main function to check and assign proximity rides
 * @param {string} driverId
 * @param {Array} currentLocation [longitude, latitude]
 * @returns {Promise<Object>} {assigned: boolean, ridesFound: number}
 */
const checkAndAssignProximityRides = async (driverId, currentLocation) => {
  try {
    const config = proximityConfig.proximityRideAssignment;

    if (!config.enabled) {
      return { assigned: false, ridesFound: 0, reason: 'Feature disabled' };
    }

    // Check proximity
    const { isNearDestination, ride: currentRide } = await checkDriverProximityToDestination(driverId, currentLocation);

    if (!isNearDestination || !currentRide) {
      return { assigned: false, ridesFound: 0, reason: 'Not near destination' };
    }

    // Check if driver can receive notifications
    const canReceive = await canReceiveProximityRide(driverId);
    if (!canReceive) {
      return { assigned: false, ridesFound: 0, reason: 'Cannot receive notifications' };
    }

    // Find nearby rides
    const nearbyRides = await findRidesNearDestination(
      currentRide.dropoffLocation.coordinates,
      config.searchRadiusKm,
      driverId,
      currentRide.vehicleType
    );

    if (nearbyRides.length === 0) {
      return { assigned: false, ridesFound: 0, reason: 'No nearby rides' };
    }

    // Send notification for the first ride (can be extended to send multiple)
    const success = await sendProximityRideNotification(driverId, nearbyRides[0]);

    return {
      assigned: success,
      ridesFound: nearbyRides.length,
      rideAssigned: success ? nearbyRides[0]._id : null
    };

  } catch (error) {
    logger.error('Error in checkAndAssignProximityRides:', error);
    return { assigned: false, ridesFound: 0, reason: 'Error occurred' };
  }
};

module.exports = {
  checkDriverProximityToDestination,
  findRidesNearDestination,
  checkAndAssignProximityRides,
  canReceiveProximityRide,
  sendProximityRideNotification,
  getTravelTimeAndDistance,
  calculateHaversineDistance
};