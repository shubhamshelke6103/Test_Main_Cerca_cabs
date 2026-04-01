const express = require("express");
const router = express.Router();
const adminVendorController = require("../../Controllers/Admin/vendor.controller");
const {
  listVendorPayouts,
  processVendorPayout,
} = require("../../Controllers/Admin/payments.controller");

const { authenticateAdmin } = require('../../utils/adminAuth');


// All routes protected for admin only
router.get("/", authenticateAdmin, adminVendorController.getAllVendors);

// Vendor payouts (same handlers as /admin/payments/vendor-payouts — wallet-safe processing)
router.get("/payouts", authenticateAdmin, listVendorPayouts);
router.patch("/payouts/:id", authenticateAdmin, processVendorPayout);

router.get("/:id/documents", authenticateAdmin, adminVendorController.getVendorDocuments);
router.get("/:id", authenticateAdmin, adminVendorController.getVendorById);

router.patch("/verify", authenticateAdmin, adminVendorController.verifyVendor);

router.patch("/reject", authenticateAdmin, adminVendorController.rejectVendor);

router.patch("/block", authenticateAdmin, adminVendorController.blockVendor);

router.patch("/unblock", authenticateAdmin, adminVendorController.unblockVendor);

module.exports = router;
