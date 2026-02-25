const express = require("express");
const router = express.Router();
const adminVendorController = require("../../Controllers/Admin/vendor.controller");

const { authenticateAdmin } = require('../../utils/adminAuth');


// All routes protected for admin only
router.get("/", authenticateAdmin, adminVendorController.getAllVendors);

router.get("/:id", authenticateAdmin, adminVendorController.getVendorById);

router.patch("/verify/:id", authenticateAdmin, adminVendorController.verifyVendor);

router.patch("/reject/:id", authenticateAdmin, adminVendorController.rejectVendor);

router.patch("/block/:id", authenticateAdmin, adminVendorController.blockVendor);

router.patch("/unblock/:id", authenticateAdmin, adminVendorController.unblockVendor);

module.exports = router;