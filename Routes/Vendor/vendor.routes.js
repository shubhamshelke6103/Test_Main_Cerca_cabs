const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const vendorController = require("../../Controllers/Vendor/vendor.controller");
const vendorPayoutController = require("../../Controllers/Vendor/vendorPayout.controller");
const fleetVehicleController = require("../../Controllers/Vendor/fleetVehicle.controller");
const { authenticateVendor } = require("../../utils/vendorAuth");
const {
  vendorForgotPasswordLimiter,
  vendorResetPasswordLimiter,
  vendorEarningsExportLimiter,
} = require("../../middleware/rateLimiter");

const vendorDocsDir = path.join(__dirname, "../../uploads/vendorDocuments");
if (!fs.existsSync(vendorDocsDir)) {
  fs.mkdirSync(vendorDocsDir, { recursive: true });
}
const vendorUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, vendorDocsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
});

const fleetVehicleDocsDir = path.join(__dirname, "../../uploads/fleetVehicleDocuments");
if (!fs.existsSync(fleetVehicleDocsDir)) {
  fs.mkdirSync(fleetVehicleDocsDir, { recursive: true });
}
const fleetVehicleUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, fleetVehicleDocsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
});
const fleetVehicleFileFields = fleetVehicleUpload.fields([
  { name: "vehicleRc", maxCount: 1 },
  { name: "vehicleInsurance", maxCount: 1 },
  { name: "vehiclePermit", maxCount: 1 },
  { name: "vehiclePuc", maxCount: 1 },
]);

// Public routes
router.post("/register", vendorController.registerVendor);
router.post("/login", vendorController.loginVendor);
router.post(
  "/forgot-password",
  vendorForgotPasswordLimiter,
  vendorController.forgotVendorPassword
);
router.post(
  "/reset-password",
  vendorResetPasswordLimiter,
  vendorController.resetVendorPassword
);
// Post-registration Aadhaar upload (no login yet); body must include vendorId
router.post("/register/upload-document", vendorUpload.single("document"), vendorController.uploadVendorDocumentPostRegister);
router.post("/register/reupload-document", vendorUpload.single("document"), vendorController.uploadVendorDocumentPostRegister);

// All routes below require vendor JWT
router.use(authenticateVendor);

// Protected document upload (logged-in vendor)
router.post("/documents", vendorUpload.single("document"), vendorController.uploadVendorDocument);

// Protected routes
router.get("/profile/:id", vendorController.getVendorProfile);
router.put("/profile", vendorController.updateVendorProfile);

router.get("/drivers/:id", vendorController.getVendorDrivers);
router.get("/driver/:driverId", vendorController.getVendorDriverById);

router.post("/assign-driver", vendorController.assignDriverToVendor);

router.post("/drivers/lookup", vendorController.lookupDriverByPhoneForVendor);
router.post("/drivers", vendorController.addDriver);
router.patch("/drivers/:driverId", vendorController.updateVendorDriver);
router.patch("/block-driver", vendorController.blockDriver);
router.patch("/unblock-driver", vendorController.unblockDriver);
router.get("/driver-location/:driverId", vendorController.getDriverLocationById);

// vendor can fetch documents of their own driver
router.get("/driver-document/:driverId", vendorController.getDriverDocuments);

router.delete("/remove-driver/:driverId/:vendorId",  vendorController.removeDriverFromVendor);

router.patch("/verify-driver", vendorController.verifyDriver);

router.patch("/reject-driver", vendorController.rejectDriver);
router.patch("/drivers/:driverId/vehicle/approve", vendorController.approveDriverVehicle);
router.patch("/drivers/:driverId/vehicle/reject", vendorController.rejectDriverVehicle);
router.delete("/drivers/:driverId/vehicle", vendorController.deleteVendorDriverVehicle);
router.patch("/drivers/:driverId/fleet-vehicle", vendorController.assignDriverFleetVehicle);

router.post(
  "/fleet-vehicles",
  fleetVehicleFileFields,
  fleetVehicleController.createFleetVehicle
);
router.get("/fleet-vehicles", fleetVehicleController.listFleetVehicles);
router.get("/fleet-vehicles/:id", fleetVehicleController.getFleetVehicle);
router.post(
  "/fleet-vehicles/:id/resubmit",
  fleetVehicleFileFields,
  fleetVehicleController.resubmitFleetVehicle
);

router.get("/dashboard/:vendorId",  vendorController.getDashboardStats);
router.get("/total-rides", vendorController.getVendorTotalRides);
router.get("/earnings-report", vendorController.getVendorEarningsReport);
router.get(
  "/earnings-export",
  vendorEarningsExportLimiter,
  vendorController.getVendorEarningsExport
);
router.get("/driver-wise-earnings", vendorController.getVendorDriverWiseEarnings);
router.get("/payout/available-balance", vendorController.getVendorAvailableBalance);
router.post("/payout/request", vendorController.requestVendorPayout);
router.get("/payout/history", vendorController.getVendorPayoutHistory);
router.get("/payout/:payoutId", vendorController.getVendorPayoutById);
router.get("/online-hours-report", vendorController.getVendorOnlineHoursReport);
router.put("/compliance-documents", vendorController.updateVendorComplianceDocuments);
router.put("/drivers/:driverId/compliance-documents", vendorController.updateVendorDriverComplianceDocuments);

// Bank account CRUD (JWT-scoped; preferred)
router.get("/bank-account", vendorController.getVendorBankAccountSelf);
router.post("/bank-account", vendorController.addVendorBankAccountSelf);
router.put("/bank-account", vendorController.updateVendorBankAccountSelf);
router.delete("/bank-account", vendorController.deleteVendorBankAccountSelf);

router.get("/payout/available-balance", vendorPayoutController.getVendorPayoutAvailableBalance);
router.get("/payout/history", vendorPayoutController.getVendorPayoutHistory);
router.post("/payout/request", vendorPayoutController.requestVendorPayout);

// Legacy paths — vendorId must match authenticated vendor
router.post('/:vendorId/bank-account', vendorController.addVendorBankAccount);
router.get('/:vendorId/bank-account', vendorController.getVendorBankAccount);
router.put('/:vendorId/bank-account', vendorController.updateVendorBankAccount);
router.delete('/:vendorId/bank-account', vendorController.deleteVendorBankAccount);

module.exports = router;
