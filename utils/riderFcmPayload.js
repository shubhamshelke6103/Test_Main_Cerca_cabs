'use strict'

/**
 * Builds the FCM `data` payload for rider-bound notifications.
 *
 * The Ionic rider app's FcmService.routeFromPayload understands:
 *   - data.route   — absolute Angular route, takes precedence
 *   - data.appType — high-level category: ride_status | chat_message | promo | system
 *   - data.type    — legacy field, still supported for backward compatibility
 *
 * Backend stores a richer enum on Notification.type (notification.model.js).
 * This helper translates each backend enum value into the canonical client
 * payload (route + appType) so the rider app can deep-link consistently no
 * matter which event raised the push.
 *
 * Notification enum (User-bound subset, mirrored here for documentation):
 *   ride_request, ride_accepted, ride_started, ride_completed, ride_cancelled,
 *   driver_arrived, rating_received, ride_destination_updated,
 *   live_location_share, proximity_ride_request, ride_chat_message,
 *   system, compliance_alert, emergency
 */

const ACTIVE_RIDE_ROUTE = '/tabs/tabs/tab1'
const PROMO_ROUTE = '/tabs/tabs/tab2'
const FALLBACK_ROUTE = '/tabs/tabs/tab1'

const RIDER_TYPE_TO_ROUTE = {
  // Ride lifecycle — keep rider on the active-ride tab where status is shown.
  ride_request: { route: ACTIVE_RIDE_ROUTE, appType: 'ride_status' },
  ride_accepted: { route: ACTIVE_RIDE_ROUTE, appType: 'ride_status' },
  ride_started: { route: ACTIVE_RIDE_ROUTE, appType: 'ride_status' },
  ride_completed: { route: ACTIVE_RIDE_ROUTE, appType: 'ride_status' },
  ride_cancelled: { route: ACTIVE_RIDE_ROUTE, appType: 'ride_status' },
  driver_arrived: { route: ACTIVE_RIDE_ROUTE, appType: 'ride_status' },
  ride_destination_updated: { route: ACTIVE_RIDE_ROUTE, appType: 'ride_status' },
  live_location_share: { route: ACTIVE_RIDE_ROUTE, appType: 'ride_status' },
  proximity_ride_request: { route: ACTIVE_RIDE_ROUTE, appType: 'ride_status' },
  rating_received: { route: ACTIVE_RIDE_ROUTE, appType: 'ride_status' },

  // Chat — deep-link into the per-ride chat screen via builder below.
  ride_chat_message: { route: null, appType: 'chat_message' },

  // Promo / marketing
  promo: { route: PROMO_ROUTE, appType: 'promo' },

  // Generic admin / system
  system: { route: FALLBACK_ROUTE, appType: 'system' },
  compliance_alert: { route: FALLBACK_ROUTE, appType: 'system' },
  emergency: { route: FALLBACK_ROUTE, appType: 'system' },
}

/**
 * Build the rider FCM data payload.
 *
 * @param {object} input
 * @param {string} input.notificationType   Backend Notification.type enum value
 * @param {string|object|null} [input.relatedRideId]  ObjectId or string of the related ride
 * @param {object} [input.extra]            Extra string-coercible fields callers want to merge
 * @returns {object} flat data object with string values (FCM requirement)
 */
const buildRiderPushData = ({
  notificationType,
  relatedRideId,
  extra = {},
} = {}) => {
  const mapping =
    RIDER_TYPE_TO_ROUTE[notificationType] || {
      route: FALLBACK_ROUTE,
      appType: 'system',
    }

  const rideIdStr = relatedRideId ? String(relatedRideId) : ''

  // Chat deep link is dynamic — needs the rideId.
  let route = mapping.route
  if (notificationType === 'ride_chat_message' && rideIdStr) {
    route = `/driver-chat/${rideIdStr}`
  }
  if (!route) {
    route = FALLBACK_ROUTE
  }

  const payload = {
    route,
    appType: mapping.appType,
    backendType: String(notificationType || ''),
  }
  if (rideIdStr) {
    payload.rideId = rideIdStr
    payload.relatedRide = rideIdStr
  }

  // Merge caller-supplied extras (last-write wins so callers can override route).
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue
    payload[key] = typeof value === 'string' ? value : String(value)
  }

  return payload
}

module.exports = {
  buildRiderPushData,
  RIDER_TYPE_TO_ROUTE,
  ACTIVE_RIDE_ROUTE,
  PROMO_ROUTE,
  FALLBACK_ROUTE,
}
