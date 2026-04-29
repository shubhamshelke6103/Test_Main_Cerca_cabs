const CANCEL_BLOCK_WITHIN_DROP_RADIUS_METERS = Number(
  process.env.CANCEL_BLOCK_WITHIN_DROP_RADIUS_METERS || 1000
)
const PICKUP_SHIFT_REASON_THRESHOLD_METERS = Number(
  process.env.PICKUP_SHIFT_REASON_THRESHOLD_METERS || 100
)

const normalizeCancellationReasonCode = rawCode => {
  const allowed = new Set([
    'GENERAL',
    'DRIVER_WITHDREW_BEFORE_ARRIVAL',
    'DRIVER_ENDED_AT_PICKUP',
    'DRIVER_ENDED_DURING_TRIP',
    'RIDER_PICKUP_SHIFT_TOO_FAR'
  ])
  const normalized = String(rawCode || 'GENERAL').trim().toUpperCase()
  return allowed.has(normalized) ? normalized : 'GENERAL'
}

const shouldBlockCancelWithinDropRadius = distanceMeters =>
  Number.isFinite(distanceMeters) &&
  distanceMeters <= CANCEL_BLOCK_WITHIN_DROP_RADIUS_METERS

module.exports = {
  CANCEL_BLOCK_WITHIN_DROP_RADIUS_METERS,
  PICKUP_SHIFT_REASON_THRESHOLD_METERS,
  normalizeCancellationReasonCode,
  shouldBlockCancelWithinDropRadius
}
