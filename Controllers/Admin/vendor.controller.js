const mongoose = require("mongoose");
const Vendor = require("../../Models/vendor/vendor.models");
const VendorPayout = mongoose.model("VendorPayout");
const Driver = require("../../Models/Driver/driver.model");
const AdminEarnings = require("../../Models/Admin/adminEarnings.model");

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;
const ADMIN_VENDOR_FILTER_VALUES = ["ALL", "VERIFIED", "PENDING", "REJECTED"];

const normalizeAdminVendorFilter = (value) => {
  if (!value) return "ALL";
  const normalized = String(value).trim().toUpperCase();
  return ADMIN_VENDOR_FILTER_VALUES.includes(normalized) ? normalized : null;
};

const getVendorDisplayStatus = (vendor) => {
  if (!vendor) return "PENDING";
  if (vendor.vendorReviewStatus === "REJECTED") return "REJECTED";
  if (vendor.vendorReviewStatus === "APPROVED" && vendor.isVerified) {
    return vendor.isActive ? "ACTIVE" : "INACTIVE";
  }
  return "PENDING";
};

const serializeVendorForResponse = (vendorDoc) => {
  if (!vendorDoc) return vendorDoc;

  const vendor = vendorDoc.toObject ? vendorDoc.toObject() : { ...vendorDoc };
  const displayStatus = getVendorDisplayStatus(vendor);

  if (displayStatus !== "ACTIVE" && displayStatus !== "INACTIVE") {
    vendor.isActive = false;
  }
  vendor.status = displayStatus;
  vendor.approvalStatus = displayStatus;
  vendor.vendorReviewStatus = vendor.vendorReviewStatus || displayStatus;

  return vendor;
};

const matchesAdminVendorFilter = (vendor, filter) => {
  if (filter === "ALL") return true;
  if (filter === "VERIFIED") {
    return vendor.vendorReviewStatus === "APPROVED" && vendor.isVerified === true;
  }
  if (filter === "PENDING") {
    return vendor.status === "PENDING";
  }
  if (filter === "REJECTED") {
    return vendor.status === "REJECTED";
  }
  return true;
};

const calculateVendorCommission = (vendor, driverEarning) => {
  const normalizedDriverEarning = Number(driverEarning) || 0;
  if (!vendor || normalizedDriverEarning <= 0) return 0;

  if (vendor.commissionType === "FIXED") {
    return roundCurrency(
      Math.min(Number(vendor.commissionValue) || 0, normalizedDriverEarning)
    );
  }

  return roundCurrency(
    normalizedDriverEarning * ((Number(vendor.commissionValue) || 0) / 100)
  );
};

const syncVendorFinancialFields = async (vendorId) => {
  const vendor = await Vendor.findById(vendorId)
    .select("commissionType commissionValue")
    .lean();

  if (!vendor) {
    return null;
  }

  const drivers = await Driver.find({ vendorId }).select("_id").lean();
  const driverIds = drivers.map((driver) => driver._id);

  if (driverIds.length === 0) {
    await Vendor.findByIdAndUpdate(vendorId, {
      $set: {
        walletBalance: 0,
        totalEarnings: 0,
        totalRides: 0,
      },
    });
    return true;
  }

  const [completedEarnings, payouts] = await Promise.all([
    AdminEarnings.find({
      driverId: { $in: driverIds },
      paymentStatus: "completed",
    })
      .select("driverEarning")
      .lean(),
    VendorPayout.find({
      vendor: vendorId,
      status: { $in: ["PENDING", "PROCESSING", "COMPLETED"] },
    })
      .select("amount relatedEarnings")
      .lean(),
  ]);

  const reservedEarningIds = new Set();
  payouts.forEach((payout) => {
    if (!Array.isArray(payout.relatedEarnings)) return;
    payout.relatedEarnings.forEach((earningId) => {
      if (earningId) reservedEarningIds.add(earningId.toString());
    });
  });

  const totalCompletedCommission = roundCurrency(
    completedEarnings.reduce(
      (sum, earning) =>
        sum + calculateVendorCommission(vendor, earning.driverEarning),
      0
    )
  );

  const availableBalance = roundCurrency(
    completedEarnings.reduce((sum, earning) => {
      const earningId = earning._id ? earning._id.toString() : null;
      if (!earningId || reservedEarningIds.has(earningId)) {
        return sum;
      }
      return sum + calculateVendorCommission(vendor, earning.driverEarning);
    }, 0)
  );

  await Vendor.findByIdAndUpdate(vendorId, {
    $set: {
      walletBalance: availableBalance,
      totalEarnings: totalCompletedCommission,
      totalRides: completedEarnings.length,
    },
  });

  return true;
};

// ======================================
// Get All Vendors
// ======================================
exports.getAllVendors = async (req, res) => {
  try {
    const filter = normalizeAdminVendorFilter(req.query.filter || req.query.status);
    if (!filter) {
      return res.status(400).json({
        message: `Invalid vendor filter. Use one of: ${ADMIN_VENDOR_FILTER_VALUES.join(", ")}`
      });
    }

    const vendors = await Vendor.find().select("-password");
    const serializedVendors = vendors.map(serializeVendorForResponse);
    const filteredVendors = serializedVendors.filter((vendor) =>
      matchesAdminVendorFilter(vendor, filter)
    );

    res.json({
      total: filteredVendors.length,
      filter,
      vendors: filteredVendors
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

    res.json(serializeVendorForResponse(vendor));
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
    vendor.isActive = true;
    vendor.rejectionReason = null;
    vendor.allowDocumentResubmit = false;
    vendor.vendorReviewStatus = "APPROVED";

    await vendor.save();

    res.json({
      success: true,
      message: "Vendor verified successfully",
      vendor: serializeVendorForResponse(vendor)
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
    const { vendorId, reason: rawReason, allowDocumentResubmit } = req.body;

    if (!vendorId) {
      return res.status(400).json({
        message: "vendorId is required"
      });
    }

    const reason = String(rawReason || "").trim();
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
    vendor.isActive = false;
    vendor.rejectionReason = reason;
    vendor.allowDocumentResubmit = Boolean(allowDocumentResubmit);
    vendor.vendorReviewStatus = "REJECTED";

    await vendor.save();

    res.json({
      success: true,
      message: "Vendor rejected successfully",
      vendor: serializeVendorForResponse(vendor)
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
      vendor: serializeVendorForResponse(vendor)
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

    if (!vendor.isVerified || vendor.vendorReviewStatus !== "APPROVED") {
      return res.status(400).json({
        message: "Vendor must be approved before it can be activated"
      });
    }

    vendor.isActive = true;

    await vendor.save();

    res.json({
      success: true,
      message: "Vendor unblocked successfully",
      vendor: serializeVendorForResponse(vendor)
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Vendor payout list/process: use payments.controller via Routes/Admin/vendor.routes.js (wallet-safe).
