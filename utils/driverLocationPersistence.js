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
 * Uses atomic $set updates so legacy drivers with invalid `documents` subdocs are not
 * re-validated on full-document save().
 *
 * @param {string} driverId
 * @param {number} longitude
 * @param {number} latitude
 * @returns {Promise<{ driver: import('mongoose').Document, goToRouteRefreshed: boolean }>}
 * @throws {Error} 'Driver not found' when missing
 */
async function persistDriverLocationWithGoTo (driverId, longitude, latitude) {
  const existing = await Driver.findById(driverId).select('goTo').lean()
  if (!existing) {
    throw new Error('Driver not found')
  }

  const location = {
    type: 'Point',
    coordinates: [longitude, latitude]
  }

  const coordinates = [longitude, latitude]
  let goToRouteRefreshed = false

  const $set = { location }

  const goTo = existing.goTo
  if (
    goTo?.isEnabled &&
    goTo?.homeLocation?.coordinates &&
    shouldRefreshGoToRoute(goTo, { coordinates })
  ) {
    try {
      $set.goTo = await buildGoToRouteSnapshot({
        origin: { coordinates },
        destination: goTo.homeLocation,
        homeAddress: goTo.homeAddress,
        corridorRadiusMeters:
          goTo.corridorRadiusMeters || DEFAULT_CORRIDOR_RADIUS_METERS,
        activatedAt: goTo.activatedAt || new Date()
      })
      goToRouteRefreshed = true
    } catch (routeError) {
      $set.goTo = markGoToRouteStale(goTo, 'ROUTE_REFRESH_FAILED')
      logger.warn(
        `GO TO route refresh failed for driver ${driverId}: ${routeError.message}`
      )
    }
  }

  const driver = await Driver.findByIdAndUpdate(
    driverId,
    { $set },
    { new: true, runValidators: true }
  )
  if (!driver) {
    throw new Error('Driver not found')
  }

  return { driver, goToRouteRefreshed }
}

module.exports = { persistDriverLocationWithGoTo }
