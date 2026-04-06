/**
 * One-time migration: ensure each self-owned driver has at most one APPROVED
 * subdoc with isActive true; if none active among multiple approved, pick latest by approvedAt.
 *
 * Usage: node scripts/normalize-driver-vehicle-active.js
 * Requires MONGO_URI or MONGODB_URI in .env
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Driver = require('../Models/Driver/driver.model.js');

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
  console.error('Set MONGO_URI or MONGODB_URI');
  process.exit(1);
}

const pickLatestApproved = (approved) => {
  if (!approved.length) return null;
  return [...approved].sort((a, b) => {
    const ta = new Date(a.approvedAt || a.submittedAt || 0).getTime();
    const tb = new Date(b.approvedAt || b.submittedAt || 0).getTime();
    return tb - ta;
  })[0];
};

const syncLegacyVehicleFields = (driver) => {
  const vehicles = Array.isArray(driver.vehicles) ? driver.vehicles : [];
  const approved = vehicles.filter((v) => v.approvalStatus === 'APPROVED');
  const activeVehicle =
    approved.find((v) => v.isActive) || pickLatestApproved(approved);

  if (!driver.assignedFleetVehicleId) {
    driver.vehicleInfo = activeVehicle
      ? {
          make: activeVehicle.make,
          model: activeVehicle.model,
          year: activeVehicle.year,
          color: activeVehicle.color,
          licensePlate: activeVehicle.licensePlate,
          vehicleType: activeVehicle.vehicleType,
        }
      : null;
  }

  let pendingVehicle = null;
  for (let i = vehicles.length - 1; i >= 0; i -= 1) {
    const v = vehicles[i];
    if (v.approvalStatus === 'UNDER_APPROVAL' || v.approvalStatus === 'REJECTED') {
      pendingVehicle = v;
      break;
    }
  }

  if (pendingVehicle) {
    const plain = pendingVehicle.toObject ? pendingVehicle.toObject() : pendingVehicle;
    driver.pendingVehicleInfo = { ...plain, sourceVehicleId: pendingVehicle._id };
  } else {
    driver.pendingVehicleInfo = null;
  }
};

async function main() {
  await mongoose.connect(uri);
  const cursor = Driver.find({
    vendorId: null,
    'vehicles.0': { $exists: true },
  }).cursor();

  let scanned = 0;
  let updated = 0;

  for await (const driver of cursor) {
    scanned += 1;
    if (driver.assignedFleetVehicleId) continue;

    const vehicles = Array.isArray(driver.vehicles) ? driver.vehicles : [];
    const approved = vehicles.filter((v) => v.approvalStatus === 'APPROVED');
    if (approved.length === 0) continue;

    const activeOnes = approved.filter((v) => v.isActive);
    let needsSave = false;

    if (activeOnes.length > 1) {
      const keep = pickLatestApproved(approved);
      approved.forEach((v) => {
        v.isActive = keep && String(v._id) === String(keep._id);
      });
      needsSave = true;
    } else if (activeOnes.length === 0) {
      const keep = pickLatestApproved(approved);
      approved.forEach((v) => {
        v.isActive = keep && String(v._id) === String(keep._id);
      });
      needsSave = true;
    }

    if (needsSave) {
      syncLegacyVehicleFields(driver);
      await driver.save();
      updated += 1;
    }
  }

  console.log(`Scanned ${scanned} drivers with vehicles; normalized ${updated}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
