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
// Get Vendor Documents (for admin – list with full URLs)
// ======================================
exports.getVendorDocuments = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id).select("documents");

    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    const raw = vendor.documents || [];
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const documents = raw.map((doc) => {
      if (typeof doc !== "string") return doc;
      if (/^https?:\/\//i.test(doc)) return doc;
      const path = doc.startsWith("/") ? doc : `/${doc}`;
      return `${baseUrl}${path}`;
    });

    res.status(200).json({ documents });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================================
// Verify Vendor
// ======================================
exports.verifyVendor = async (req, res) => {
  try {
    const { vendorId } = req.body;

    if (!vendorId) {
      return res.status(400).json({
        message: "vendorId is required"
      });
    }

    const vendor = await Vendor.findById(vendorId);

    if (!vendor) {
      return res.status(404).json({
        message: "Vendor not found"
      });
    }

    vendor.isVerified = true;
    vendor.rejectionReason = null;

    await vendor.save();

    res.json({
      success: true,
      message: "Vendor verified successfully",
      vendor
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ======================================
// Reject Vendor
// ======================================
exports.rejectVendor = async (req, res) => {
  try {
    const { vendorId, reason } = req.body;

    if (!vendorId) {
      return res.status(400).json({
        message: "vendorId is required"
      });
    }

    if (!reason) {
      return res.status(400).json({
        message: "Rejection reason is required"
      });
    }

    const vendor = await Vendor.findById(vendorId);

    if (!vendor) {
      return res.status(404).json({
        message: "Vendor not found"
      });
    }

    vendor.isVerified = false;
    vendor.rejectionReason = reason;

    await vendor.save();

    res.json({
      success: true,
      message: "Vendor rejected successfully",
      vendor
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ======================================
// Block Vendor
// ======================================
exports.blockVendor = async (req, res) => {
  try {
    const { vendorId } = req.body;

    if (!vendorId) {
      return res.status(400).json({
        message: "vendorId is required"
      });
    }

    const vendor = await Vendor.findById(vendorId);

    if (!vendor) {
      return res.status(404).json({
        message: "Vendor not found"
      });
    }

    vendor.isActive = false;

    await vendor.save();

    res.json({
      success: true,
      message: "Vendor blocked successfully",
      vendor
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ======================================
// Unblock Vendor
// ======================================
// exports.unblockVendor = async (req, res) => {
//   try {
//     const vendor = await Vendor.findById(req.params.id);

//     if (!vendor) {
//       return res.status(404).json({ message: "Vendor not found" });
//     }

//     vendor.isActive = true;
//     await vendor.save();

//     res.json({ message: "Vendor unblocked successfully" });
//   } catch (error) {
//     res.status(500).json({ message: error.message });
//   }
// };

exports.unblockVendor = async (req, res) => {
  try {
    const { vendorId } = req.body;

    if (!vendorId) {
      return res.status(400).json({
        message: "vendorId is required"
      });
    }

    const vendor = await Vendor.findById(vendorId);

    if (!vendor) {
      return res.status(404).json({
        message: "Vendor not found"
      });
    }

    vendor.isActive = true;

    await vendor.save();

    res.json({
      success: true,
      message: "Vendor unblocked successfully",
      vendor
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};