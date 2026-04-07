const FleetVehicle = require('../../Models/Vendor/fleetVehicle.model');
const Driver = require('../../Models/Driver/driver.model');

/**
 * Same fleet filter shape as listVehicleInventory (GET /admin/vehicles).
 * @param {string|undefined} status - raw query status (e.g. UNDER_APPROVAL)
 * @param {{ vendorId?: string, search?: string }} [options]
 */
function buildFleetVehicleFilterForInventory(status, { vendorId, search } = {}) {
  const fleetVehicleFilter = {};
  if (status) {
    fleetVehicleFilter.approvalStatus = status;
  }
  if (vendorId) {
    fleetVehicleFilter.vendorId = vendorId;
  }
  if (search) {
    const regex = new RegExp(search, 'i');
    fleetVehicleFilter.$or = [
      { make: regex },
      { model: regex },
      { color: regex },
      { licensePlate: regex },
      { vehicleType: regex },
    ];
  }
  return fleetVehicleFilter;
}

/**
 * Same standalone-driver filter as listVehicleInventory (vendorId null, not assigned to fleet row).
 * @param {string|undefined} status - raw query status
 * @param {{ search?: string }} [options]
 */
function buildStandaloneDriverFilterForInventory(status, { search } = {}) {
  const normalizedStatus = String(status || '').trim().toUpperCase();
  const standaloneDriverFilter = {
    vendorId: null,
    $or: [
      { vehicleInfo: { $exists: true, $ne: null } },
      { pendingVehicleInfo: { $exists: true, $ne: null } },
    ],
    $and: [
      {
        $or: [
          { assignedFleetVehicleId: null },
          { assignedFleetVehicleId: { $exists: false } },
        ],
      },
    ],
  };

  if (normalizedStatus === 'APPROVED') {
    standaloneDriverFilter.$and.push({
      vehicleInfo: { $exists: true, $ne: null },
    });
  } else if (normalizedStatus === 'UNDER_APPROVAL' || normalizedStatus === 'REJECTED') {
    standaloneDriverFilter.$and.push({
      'pendingVehicleInfo.approvalStatus': normalizedStatus,
    });
  } else if (normalizedStatus) {
    standaloneDriverFilter._id = { $in: [] };
  }
  if (search) {
    const regex = new RegExp(search, 'i');
    standaloneDriverFilter.$and.push({
      $or: [
        { 'vehicleInfo.make': regex },
        { 'vehicleInfo.model': regex },
        { 'vehicleInfo.color': regex },
        { 'vehicleInfo.licensePlate': regex },
        { 'vehicleInfo.vehicleType': regex },
        { 'pendingVehicleInfo.make': regex },
        { 'pendingVehicleInfo.model': regex },
        { 'pendingVehicleInfo.color': regex },
        { 'pendingVehicleInfo.licensePlate': regex },
        { 'pendingVehicleInfo.vehicleType': regex },
        { name: regex },
        { email: regex },
        { phone: regex },
      ],
    });
  }
  return standaloneDriverFilter;
}

/**
 * Counts merged inventory rows for status=UNDER_APPROVAL with no extra query params
 * (same basis as admin menu badge: GET /admin/vehicles?status=UNDER_APPROVAL).
 */
async function countUnderApprovalVehicleInventory() {
  const status = 'UNDER_APPROVAL';
  const fleetFilter = buildFleetVehicleFilterForInventory(status, {});
  const standaloneFilter = buildStandaloneDriverFilterForInventory(status, {});
  const [pendingFleetVehiclesUnderApproval, pendingStandaloneVehiclesUnderApproval] =
    await Promise.all([
      FleetVehicle.countDocuments(fleetFilter),
      Driver.countDocuments(standaloneFilter),
    ]);
  const pendingVehicles =
    pendingFleetVehiclesUnderApproval + pendingStandaloneVehiclesUnderApproval;
  return {
    pendingVehicles,
    pendingFleetVehiclesUnderApproval,
    pendingStandaloneVehiclesUnderApproval,
  };
}

module.exports = {
  buildFleetVehicleFilterForInventory,
  buildStandaloneDriverFilterForInventory,
  countUnderApprovalVehicleInventory,
};
