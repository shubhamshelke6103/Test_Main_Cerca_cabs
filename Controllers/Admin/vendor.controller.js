const mongoose = require("mongoose");
const Vendor = require("../../Models/vendor/vendor.models");
const VendorPayout = mongoose.model("VendorPayout");
const Driver = require("../../Models/Driver/driver.model");
const AdminEarnings = require("../../Models/Admin/adminEarnings.model");

const roundCurrency = (value) => Math.round((Number(value) || 0) * 100) / 100;

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
    vendor.allowDocumentResubmit = false;
    vendor.vendorReviewStatus = "PENDING";

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
    vendor.rejectionReason = reason;
    vendor.allowDocumentResubmit = Boolean(allowDocumentResubmit);
    vendor.vendorReviewStatus = "REJECTED";

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

// ======================================
// List Vendor Payouts
// ======================================
exports.listVendorPayouts = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, vendorId } = req.query;
    const query = {};
    if (status) query.status = status;
    if (vendorId) query.vendor = vendorId;

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const [payouts, total] = await Promise.all([
      VendorPayout.find(query)
        .sort({ requestedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .populate("vendor", "businessName ownerName email phone")
        .populate("processedBy", "fullName email"),
      VendorPayout.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: {
        payouts,
        pagination: {
          currentPage: parseInt(page, 10),
          totalPages: Math.ceil(total / parseInt(limit, 10)),
          total,
          limit: parseInt(limit, 10),
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ======================================
// Process Vendor Payout
// ======================================
exports.processVendorPayout = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, transactionId, transactionReference, failureReason, notes } = req.body;

    const allowed = ["PROCESSING", "COMPLETED", "FAILED", "CANCELLED"];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payout status",
      });
    }

    const payout = await VendorPayout.findById(id);
    if (!payout) {
      return res.status(404).json({
        success: false,
        message: "Vendor payout not found",
      });
    }

    payout.status = status;
    payout.processedAt = new Date();
    payout.processedBy = req.adminId;
    if (transactionId) payout.transactionId = transactionId;
    if (transactionReference) payout.transactionReference = transactionReference;
    if (failureReason) payout.failureReason = failureReason;
    if (notes) payout.notes = notes;

    await payout.save();
    await syncVendorFinancialFields(payout.vendor);

    res.status(200).json({
      success: true,
      message: "Vendor payout updated successfully",
      payout,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
