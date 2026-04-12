/**
 * Aggregate `vehicleStatus` for API responses — aligned with startDriverOnlineSession:
 * if the driver has a usable ride snapshot (fleet assignment or vehicleInfo with plate/make),
 * status is APPROVED even when another garage row is REJECTED/UNDER_APPROVAL (details live on vehicles[] / pendingVehicleInfo).
 */

const hasOperationalRideSnapshot = (driver) => {
  if (!driver) return false
  const fleet = driver.assignedFleetVehicleId
  if (fleet != null && String(fleet).trim() !== '') return true
  const vi = driver.vehicleInfo
  if (
    vi &&
    typeof vi === 'object' &&
    (vi.licensePlate || vi.make)
  ) {
    return true
  }
  return false
}

/**
 * @param {object} driver Mongoose doc or plain object
 * @returns {'APPROVED'|'UNDER_APPROVAL'|'REJECTED'|'NOT_ADDED'}
 */
const resolveAggregateVehicleStatus = (driver) => {
  if (hasOperationalRideSnapshot(driver)) {
    return 'APPROVED'
  }
  const pending = driver.pendingVehicleInfo?.approvalStatus
  if (pending) {
    return pending
  }
  if (driver.vehicleInfo || driver.assignedFleetVehicleId) {
    return 'APPROVED'
  }
  return 'NOT_ADDED'
}

module.exports = {
  hasOperationalRideSnapshot,
  resolveAggregateVehicleStatus,
}
