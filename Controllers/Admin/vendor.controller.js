const Vendor = require("../../Models/vendor/vendor.models");

// ======================================
// Get All Vendors
// ======================================
exports.getAllVendors = async (req, res) => {
  try {
    const vendors = await Vendor.find().select("-password");

    res.json({
      total: vendors.length,
      vendors
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================================
// Get Single Vendor Profile
// ======================================
exports.getVendorById = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id).select("-password");

    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    res.json(vendor);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================================
// Verify Vendor
// ======================================
exports.verifyVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);

    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    vendor.isVerified = true;
    vendor.rejectionReason = null;

    await vendor.save();

    res.json({ message: "Vendor verified successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================================
// Reject Vendor
// ======================================
exports.rejectVendor = async (req, res) => {
  try {
    const { reason } = req.body;

    const vendor = await Vendor.findById(req.params.id);

    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    vendor.isVerified = false;
    vendor.rejectionReason = reason;

    await vendor.save();

    res.json({ message: "Vendor rejected successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================================
// Block Vendor
// ======================================
exports.blockVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);

    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    vendor.isActive = false;
    await vendor.save();

    res.json({ message: "Vendor blocked successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================================
// Unblock Vendor
// ======================================
exports.unblockVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);

    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    vendor.isActive = true;
    await vendor.save();

    res.json({ message: "Vendor unblocked successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};