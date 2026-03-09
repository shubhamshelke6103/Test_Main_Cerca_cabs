const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const vendorController = require("../../Controllers/Vendor/vendor.controller");
const { authenticateVendor } = require("../../utils/vendorAuth");

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

// Public routes
router.post("/register", vendorController.registerVendor);
router.post("/login", vendorController.loginVendor);
// Post-registration Aadhaar upload (no login yet); body must include vendorId
router.post("/register/upload-document", vendorUpload.single("document"), vendorController.uploadVendorDocumentPostRegister);

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

router.get("/dashboard/:vendorId",  vendorController.getDashboardStats);

// Bank account CRUD
router.post('/:vendorId/bank-account', vendorController.addVendorBankAccount);
router.get('/:vendorId/bank-account', vendorController.getVendorBankAccount);
router.put('/:vendorId/bank-account', vendorController.updateVendorBankAccount);
router.delete('/:vendorId/bank-account', vendorController.deleteVendorBankAccount);

module.exports = router;