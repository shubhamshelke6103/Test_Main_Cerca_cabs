const express = require("express");
const router = express.Router();
const vendorController = require("../../Controllers/Vendor/vendor.controller");
// const { authMiddleware } = require("../middlewares/auth.middleware");

// Register
router.post("/register", vendorController.registerVendor);
router.post("/login", vendorController.loginVendor);
// Protected routes
router.get("/profile/:id", vendorController.getVendorProfile);
router.put("/profile", vendorController.updateVendorProfile);

router.get("/drivers/:id", vendorController.getVendorDrivers);

router.post("/assign-driver", vendorController.assignDriverToVendor);

router.post("/drivers", vendorController.addDriver);
router.patch("/block-driver", vendorController.blockDriver);
router.patch("/unblock-driver", vendorController.unblockDriver);
router.get("/driver-location/:driverId", vendorController.getDriverLocationById);

router.delete("/remove-driver/:driverId/:vendorId",  vendorController.removeDriverFromVendor);

router.patch("/verify-driver", vendorController.verifyDriver);

router.patch("/reject-driver", vendorController.rejectDriver);

router.get("/dashboard/:vendorId",  vendorController.getDashboardStats);

module.exports = router;