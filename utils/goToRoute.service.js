const https = require('https')
const { URL } = require('url')

const GOOGLE_DIRECTIONS_API_URL =
  'https://maps.googleapis.com/maps/api/directions/json'
const DEFAULT_CORRIDOR_RADIUS_METERS = 500
const ROUTE_REFRESH_DISTANCE_METERS = 300
const ROUTE_REFRESH_INTERVAL_MS = 2 * 60 * 1000

const toRadians = degrees => (degrees * Math.PI) / 180

const normalizeLocationCoordinates = location => {
  if (!location) {
    throw new Error('Location is required')
  }

  const coordinates = Array.isArray(location.coordinates)
    ? location.coordinates
    : [location.longitude, location.latitude]

  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    throw new Error(
      `Invalid coordinates format: ${JSON.stringify(location)}`
    )
  }

  const [longitude, latitude] = coordinates

  if (
    typeof longitude !== 'number' ||
    Number.isNaN(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error(`Invalid longitude: ${longitude}`)
  }

  if (
    typeof latitude !== 'number' ||
    Number.isNaN(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new Error(`Invalid latitude: ${latitude}`)
  }

  return [longitude, latitude]
}

const normalizeGeoPoint = location => ({
  type: 'Point',
  coordinates: normalizeLocationCoordinates(location)
})

const haversineDistanceMeters = (start, end) => {
  const [startLng, startLat] = normalizeLocationCoordinates(start)
  const [endLng, endLat] = normalizeLocationCoordinates(end)
  const earthRadiusMeters = 6371000
  const deltaLat = toRadians(endLat - startLat)
  const deltaLng = toRadians(endLng - startLng)
  const lat1 = toRadians(startLat)
  const lat2 = toRadians(endLat)

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(deltaLng / 2) *
      Math.sin(deltaLng / 2)

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

const decodePolyline = encoded => {
  if (!encoded || typeof encoded !== 'string') {
    return []
  }

  let index = 0
  let latitude = 0
  let longitude = 0
  const coordinates = []

  while (index < encoded.length) {
    let result = 0
    let shift = 0
    let byte = null

    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1
    latitude += deltaLat

    result = 0
    shift = 0

    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)

    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1
    longitude += deltaLng

    coordinates.push([longitude / 1e5, latitude / 1e5])
  }

  return coordinates
}

const httpsGetJson = url =>
  new Promise((resolve, reject) => {
    const urlObject = new URL(url)

    const request = https.get(
      {
        hostname: urlObject.hostname,
        path: `${urlObject.pathname}${urlObject.search}`,
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      },
      response => {
        let rawData = ''

        response.on('data', chunk => {
          rawData += chunk
        })

        response.on('end', () => {
          try {
            resolve(JSON.parse(rawData))
          } catch (error) {
            reject(new Error('Failed to parse directions response'))
          }
        })
      }
    )

    request.on('error', reject)
    request.setTimeout(15000, () => {
      request.destroy()
      reject(new Error('Directions request timed out'))
    })
  })

const getMetersPerDegree = latitude => ({
  x: 111320 * Math.cos(toRadians(latitude)),
  y: 110540
})

const toLocalMeters = (coordinate, referenceLatitude) => {
  const [longitude, latitude] = coordinate
  const metersPerDegree = getMetersPerDegree(referenceLatitude)

  return {
    x: longitude * metersPerDegree.x,
    y: latitude * metersPerDegree.y
  }
}

const projectPointOnSegmentMeters = (point, segmentStart, segmentEnd, referenceLatitude) => {
  const pointMeters = toLocalMeters(point, referenceLatitude)
  const startMeters = toLocalMeters(segmentStart, referenceLatitude)
  const endMeters = toLocalMeters(segmentEnd, referenceLatitude)

  const deltaX = endMeters.x - startMeters.x
  const deltaY = endMeters.y - startMeters.y
  const segmentLengthSquared = deltaX * deltaX + deltaY * deltaY

  if (segmentLengthSquared === 0) {
    return {
      ratio: 0,
      distanceMeters: Math.sqrt(
        Math.pow(pointMeters.x - startMeters.x, 2) +
          Math.pow(pointMeters.y - startMeters.y, 2)
      )
    }
  }

  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((pointMeters.x - startMeters.x) * deltaX +
        (pointMeters.y - startMeters.y) * deltaY) /
        segmentLengthSquared
    )
  )

  const projectedX = startMeters.x + ratio * deltaX
  const projectedY = startMeters.y + ratio * deltaY

  return {
    ratio,
    distanceMeters: Math.sqrt(
      Math.pow(pointMeters.x - projectedX, 2) +
        Math.pow(pointMeters.y - projectedY, 2)
    )
  }
}

const projectPointOnRoute = (routePoints, pointLocation) => {
  const point = normalizeLocationCoordinates(pointLocation)

  if (!Array.isArray(routePoints) || routePoints.length < 2) {
    return {
      distanceMeters: Number.POSITIVE_INFINITY,
      progressMeters: Number.POSITIVE_INFINITY,
      segmentIndex: -1
    }
  }

  let bestMatch = {
    distanceMeters: Number.POSITIVE_INFINITY,
    progressMeters: Number.POSITIVE_INFINITY,
    segmentIndex: -1
  }

  let cumulativeProgressMeters = 0

  for (let index = 0; index < routePoints.length - 1; index += 1) {
    const segmentStart = routePoints[index]
    const segmentEnd = routePoints[index + 1]
    const referenceLatitude = (segmentStart[1] + segmentEnd[1] + point[1]) / 3
    const segmentLengthMeters = haversineDistanceMeters(
      { coordinates: segmentStart },
      { coordinates: segmentEnd }
    )
    const projection = projectPointOnSegmentMeters(
      point,
      segmentStart,
      segmentEnd,
      referenceLatitude
    )

    if (projection.distanceMeters < bestMatch.distanceMeters) {
      bestMatch = {
        distanceMeters: projection.distanceMeters,
        progressMeters: cumulativeProgressMeters + segmentLengthMeters * projection.ratio,
        segmentIndex: index
      }
    }

    cumulativeProgressMeters += segmentLengthMeters
  }

  return bestMatch
}

const getDirectionsApiKey = () => {
  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY ||
    'AIzaSyDQq0QpnwQKzDR99ObP1frWj_uRTQ54pbo'

  if (!apiKey) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured')
  }

  return apiKey
}

const buildGoToRouteSnapshot = async ({
  origin,
  destination,
  homeAddress = '',
  corridorRadiusMeters = DEFAULT_CORRIDOR_RADIUS_METERS,
  activatedAt = new Date()
}) => {
  const [originLng, originLat] = normalizeLocationCoordinates(origin)
  const [destinationLng, destinationLat] = normalizeLocationCoordinates(destination)
  const url =
    `${GOOGLE_DIRECTIONS_API_URL}?origin=${originLat},${originLng}` +
    `&destination=${destinationLat},${destinationLng}` +
    '&mode=driving&alternatives=false' +
    `&key=${encodeURIComponent(getDirectionsApiKey())}`

  const data = await httpsGetJson(url)

  if (data.status !== 'OK' || !Array.isArray(data.routes) || data.routes.length === 0) {
    throw new Error(
      `Directions API error: ${data.status}${data.error_message ? ` - ${data.error_message}` : ''}`
    )
  }

  const route = data.routes[0]
  const leg = Array.isArray(route.legs) && route.legs[0] ? route.legs[0] : null
  const routePolyline = route.overview_polyline?.points || ''
  const decodedRoutePoints = decodePolyline(routePolyline)

  if (decodedRoutePoints.length < 2) {
    throw new Error('Directions API returned an unusable route polyline')
  }

  return {
    isEnabled: true,
    status: 'ACTIVE',
    staleReason: null,
    homeAddress,
    homeLocation: normalizeGeoPoint(destination),
    routeOrigin: normalizeGeoPoint(origin),
    routePolyline,
    routePoints: decodedRoutePoints,
    routeBounds: route.bounds
      ? {
          north: route.bounds.northeast?.lat ?? null,
          south: route.bounds.southwest?.lat ?? null,
          east: route.bounds.northeast?.lng ?? null,
          west: route.bounds.southwest?.lng ?? null
        }
      : null,
    routeDistanceMeters: leg?.distance?.value || null,
    routeDurationSeconds: leg?.duration?.value || null,
    corridorRadiusMeters:
      typeof corridorRadiusMeters === 'number' && corridorRadiusMeters > 0
        ? corridorRadiusMeters
        : DEFAULT_CORRIDOR_RADIUS_METERS,
    activatedAt,
    lastRouteRefreshAt: new Date()
  }
}

const deactivateGoToState = currentGoTo => ({
  ...currentGoTo,
  isEnabled: false,
  status: 'OFF',
  staleReason: null,
  routeOrigin: null,
  routePolyline: null,
  routePoints: [],
  routeBounds: null,
  routeDistanceMeters: null,
  routeDurationSeconds: null,
  activatedAt: null,
  lastRouteRefreshAt: null
})

const markGoToRouteStale = (currentGoTo, reason = 'ROUTE_REFRESH_FAILED') => ({
  ...currentGoTo,
  isEnabled: true,
  status: 'STALE',
  staleReason: reason
})

const shouldRefreshGoToRoute = (currentGoTo, currentLocation) => {
  if (!currentGoTo?.isEnabled || currentGoTo.status !== 'ACTIVE') {
    return false
  }

  if (!currentGoTo.routeOrigin?.coordinates) {
    return true
  }

  const lastRefreshAt = currentGoTo.lastRouteRefreshAt
    ? new Date(currentGoTo.lastRouteRefreshAt).getTime()
    : 0
  const movedDistanceMeters = haversineDistanceMeters(
    { coordinates: currentGoTo.routeOrigin.coordinates },
    currentLocation
  )

  return (
    movedDistanceMeters >= ROUTE_REFRESH_DISTANCE_METERS &&
    Date.now() - lastRefreshAt >= ROUTE_REFRESH_INTERVAL_MS
  )
}

const isGoToRideEligible = (goToState, pickupLocation, dropoffLocation) => {
  if (!goToState?.isEnabled || goToState.status !== 'ACTIVE') {
    return { eligible: true, reason: 'GO_TO_INACTIVE' }
  }

  if (
    !Array.isArray(goToState.routePoints) ||
    goToState.routePoints.length < 2 ||
    !dropoffLocation
  ) {
    return { eligible: false, reason: 'GO_TO_ROUTE_UNAVAILABLE' }
  }

  const pickupProjection = projectPointOnRoute(
    goToState.routePoints,
    pickupLocation
  )
  const dropoffProjection = projectPointOnRoute(
    goToState.routePoints,
    dropoffLocation
  )
  const corridorRadiusMeters =
    goToState.corridorRadiusMeters || DEFAULT_CORRIDOR_RADIUS_METERS

  if (pickupProjection.distanceMeters > corridorRadiusMeters) {
    return {
      eligible: false,
      reason: 'PICKUP_OUTSIDE_ROUTE',
      pickupDistanceMeters: pickupProjection.distanceMeters,
      dropoffDistanceMeters: dropoffProjection.distanceMeters
    }
  }

  if (dropoffProjection.distanceMeters > corridorRadiusMeters) {
    return {
      eligible: false,
      reason: 'DROPOFF_OUTSIDE_ROUTE',
      pickupDistanceMeters: pickupProjection.distanceMeters,
      dropoffDistanceMeters: dropoffProjection.distanceMeters
    }
  }

  if (pickupProjection.progressMeters > dropoffProjection.progressMeters) {
    return {
      eligible: false,
      reason: 'RIDE_MOVES_AWAY_FROM_HOME',
      pickupDistanceMeters: pickupProjection.distanceMeters,
      dropoffDistanceMeters: dropoffProjection.distanceMeters,
      pickupProgressMeters: pickupProjection.progressMeters,
      dropoffProgressMeters: dropoffProjection.progressMeters
    }
  }

  return {
    eligible: true,
    reason: 'MATCHED_GO_TO_ROUTE',
    pickupDistanceMeters: pickupProjection.distanceMeters,
    dropoffDistanceMeters: dropoffProjection.distanceMeters,
    pickupProgressMeters: pickupProjection.progressMeters,
    dropoffProgressMeters: dropoffProjection.progressMeters
  }
}

const sanitizeGoToResponse = goToState => {
  if (!goToState) {
    return null
  }

  return {
    isEnabled: !!goToState.isEnabled,
    status: goToState.status || 'OFF',
    staleReason: goToState.staleReason || null,
    homeAddress: goToState.homeAddress || '',
    homeLocation: goToState.homeLocation || null,
    routeOrigin: goToState.routeOrigin || null,
    routePolyline: goToState.routePolyline || null,
    routeBounds: goToState.routeBounds || null,
    routeDistanceMeters: goToState.routeDistanceMeters || null,
    routeDurationSeconds: goToState.routeDurationSeconds || null,
    corridorRadiusMeters:
      goToState.corridorRadiusMeters || DEFAULT_CORRIDOR_RADIUS_METERS,
    activatedAt: goToState.activatedAt || null,
    lastRouteRefreshAt: goToState.lastRouteRefreshAt || null,
    routePointCount: Array.isArray(goToState.routePoints)
      ? goToState.routePoints.length
      : 0
  }
}

module.exports = {
  DEFAULT_CORRIDOR_RADIUS_METERS,
  buildGoToRouteSnapshot,
  deactivateGoToState,
  haversineDistanceMeters,
  isGoToRideEligible,
  markGoToRouteStale,
  normalizeGeoPoint,
  normalizeLocationCoordinates,
  sanitizeGoToResponse,
  shouldRefreshGoToRoute
}
