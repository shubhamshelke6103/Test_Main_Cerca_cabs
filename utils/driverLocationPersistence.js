const Driver = require('../Models/Driver/driver.model')
const logger = require('./logger')
const {
  DEFAULT_CORRIDOR_RADIUS_METERS,
  buildGoToRouteSnapshot,
  markGoToRouteStale,
  shouldRefreshGoToRoute
} = require('./goToRoute.service')

/**
 * Persists driver GeoJSON location and runs GO TO route refresh when thresholds match
 * (same semantics as PATCH /drivers/:id/location).
 *
 * @param {string} driverId
 * @param {number} longitude
 * @param {number} latitude
 * @returns {Promise<{ driver: import('mongoose').Document, goToRouteRefreshed: boolean }>}
 * @throws {Error} 'Driver not found' when missing
 */
async function persistDriverLocationWithGoTo (driverId, longitude, latitude) {
  const driver = await Driver.findById(driverId)
  if (!driver) {
    throw new Error('Driver not found')
  }

  driver.set('location', {
    type: 'Point',
    coordinates: [longitude, latitude]
  })

  const coordinates = [longitude, latitude]
  let goToRouteRefreshed = false

  if (
    driver.goTo?.isEnabled &&
    driver.goTo?.homeLocation?.coordinates &&
    shouldRefreshGoToRoute(driver.goTo, { coordinates })
  ) {
    try {
      driver.goTo = await buildGoToRouteSnapshot({
        origin: { coordinates },
        destination: driver.goTo.homeLocation,
        homeAddress: driver.goTo.homeAddress,
        corridorRadiusMeters:
          driver.goTo.corridorRadiusMeters || DEFAULT_CORRIDOR_RADIUS_METERS,
        activatedAt: driver.goTo.activatedAt || new Date()
      })
      goToRouteRefreshed = true
    } catch (routeError) {
      driver.goTo = markGoToRouteStale(
        driver.goTo?.toObject?.() || driver.goTo || {},
        'ROUTE_REFRESH_FAILED'
      )
      logger.warn(
        `GO TO route refresh failed for driver ${driver._id}: ${routeError.message}`
      )
    }
  }

  await driver.save()
  return { driver, goToRouteRefreshed }
}

module.exports = { persistDriverLocationWithGoTo }
