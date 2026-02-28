const express = require("express");
const router = express.Router();
const adminVendorController = require("../../Controllers/Admin/vendor.controller");

const { authenticateAdmin } = require('../../utils/adminAuth');


// All routes protected for admin only
router.get("/", authenticateAdmin, adminVendorController.getAllVendors);

router.get("/:id", authenticateAdmin, adminVendorController.getVendorById);
router.get("/:id/documents", authenticateAdmin, adminVendorController.getVendorDocuments);

router.patch("/verify", authenticateAdmin, adminVendorController.verifyVendor);

router.patch("/reject", authenticateAdmin, adminVendorController.rejectVendor);

router.patch("/block", authenticateAdmin, adminVendorController.blockVendor);

router.patch("/unblock", authenticateAdmin, adminVendorController.unblockVendor);

module.exports = router;