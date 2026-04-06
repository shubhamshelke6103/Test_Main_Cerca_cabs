const express = require('express');
const {
  listDrivers,
  getDriverDetails,
  approveDriver,
  rejectDriver,
  blockDriver,
  verifyDriver,
  getDriverDocuments,
  getPriorityDocument,
  getFleetOnlineHoursReport,
} = require('../../Controllers/Admin/drivers.controller');
const { authenticateAdmin } = require('../../utils/adminAuth');
const {
  approvePriorityDriver,
  rejectPriorityDriver,
  approveDriverVehicle,
  rejectDriverVehicle,
  approveDriverVehicleBySubdoc,
  rejectDriverVehicleBySubdoc,
  getDriverOnlineHours,
  updateDriverComplianceDocuments
} = require('../../Controllers/Driver/driver.controller')

const router = express.Router();

router.use(authenticateAdmin);
router.get('/drivers', listDrivers);
router.get('/drivers/:id', getDriverDetails);
router.patch('/drivers/:id/approve', approveDriver);
router.patch('/drivers/:id/reject', rejectDriver);
router.patch('/drivers/:id/block', blockDriver);
router.patch('/drivers/:id/verify', verifyDriver);
router.get('/drivers/:id/documents', getDriverDocuments);
router.get('/drivers/:id/priority-document', getPriorityDocument);
router.patch('/drivers/:id/vehicle/approve', approveDriverVehicle);
router.patch('/drivers/:id/vehicle/reject', rejectDriverVehicle);
router.patch('/drivers/:id/vehicles/:vehicleId/approve', approveDriverVehicleBySubdoc);
router.patch('/drivers/:id/vehicles/:vehicleId/reject', rejectDriverVehicleBySubdoc);
router.get('/drivers/online-hours/report', getFleetOnlineHoursReport);
router.get('/drivers/:id/online-hours', getDriverOnlineHours);
router.put('/drivers/:id/compliance-documents', updateDriverComplianceDocuments);
// Approve / reject priority driver
router.put('/drivers/:id/approve-priority', approvePriorityDriver);
router.put('/drivers/:id/reject-priority', rejectPriorityDriver);

module.exports = router;

