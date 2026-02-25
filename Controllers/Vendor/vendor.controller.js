const Vendor = require("../../Models/vendor/vendor.models");
const Driver = require("../../Models/Driver/driver.model");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");


// =============================
// 1. Register Vendor
// =============================
exports.registerVendor = async (req, res) => {
  try {
    const {
      businessName,
      ownerName,
      email,
      phone,
      password,
      address,
      location
    } = req.body;

    const existing = await Vendor.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "Vendor already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const vendor = await Vendor.create({
      businessName,
      ownerName,
      email,
      phone,
      password: hashedPassword,
      address,
      location,
      documents: req.body.documents || []
    });

    res.status(201).json({
      message: "Vendor registered successfully. Awaiting admin approval.",
      vendor
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};



// =============================
// Vendor Login
// =============================
exports.loginVendor = async (req, res) => {
  try {
    const { email, password } = req.body;

    const vendor = await Vendor.findOne({ email });

    if (!vendor) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    if (!vendor.isVerified) {
      return res.status(403).json({ message: "Vendor not verified by admin" });
    }

    if (!vendor.isActive) {
      return res.status(403).json({ message: "Vendor account is inactive" });
    }

    const isMatch = await bcrypt.compare(password, vendor.password);

    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const accessToken = jwt.sign(
      {
        id: vendor._id,
        role: "vendor"
      },
      process.env.ACCESS_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful",
      accessToken,
      vendor: {
        id: vendor._id,
        businessName: vendor.businessName,
        email: vendor.email
      }
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// =============================
// 2. Get Vendor Profile
// =============================
exports.getVendorProfile = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.user.id).select("-password");

    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    res.json(vendor);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// =============================
// 3. Update Vendor Profile
// =============================
exports.updateVendorProfile = async (req, res) => {
  try {
    const vendor = await Vendor.findByIdAndUpdate(
      req.user.id,
      req.body,
      { new: true }
    );

    res.json({
      message: "Vendor profile updated",
      vendor
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// =============================
// 4. Get All Drivers of Vendor
// =============================
exports.getVendorDrivers = async (req, res) => {
  try {
    const drivers = await Driver.find({ vendorId: req.user.id });

    res.json({
      total: drivers.length,
      drivers
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// =============================
// 5. Assign Existing Driver to Vendor
// =============================
exports.assignDriverToVendor = async (req, res) => {
  try {
    const { driverId } = req.body;

    const driver = await Driver.findById(driverId);
    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    driver.vendorId = req.user.id;
    await driver.save();

    await Vendor.findByIdAndUpdate(req.user.id, {
      $inc: { totalDrivers: 1 }
    });

    res.json({
      message: "Driver assigned to vendor successfully",
      driver
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// =============================
// 6. Remove Driver from Vendor
// =============================
exports.removeDriverFromVendor = async (req, res) => {
  try {
    const { driverId } = req.params;

    const driver = await Driver.findOne({
      _id: driverId,
      vendorId: req.user.id
    });

    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    driver.vendorId = null;
    await driver.save();

    await Vendor.findByIdAndUpdate(req.user.id, {
      $inc: { totalDrivers: -1 }
    });

    res.json({
      message: "Driver removed from vendor"
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// =============================
// 7. Verify Vendor Driver
// =============================
exports.verifyDriver = async (req, res) => {
  try {
    const { driverId } = req.params;

    const driver = await Driver.findOne({
      _id: driverId,
      vendorId: req.user.id
    });

    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    driver.isVerified = true;
    driver.rejectionReason = null;

    await driver.save();

    res.json({ message: "Driver verified successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// =============================
// 8. Reject Vendor Driver
// =============================
exports.rejectDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { reason } = req.body;

    const driver = await Driver.findOne({
      _id: driverId,
      vendorId: req.user.id
    });

    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    driver.isVerified = false;
    driver.rejectionReason = reason;

    await driver.save();

    res.json({ message: "Driver rejected" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// =============================
// 9. Vendor Dashboard Stats
// =============================
exports.getDashboardStats = async (req, res) => {
  try {
    const vendorId = req.user.id;

    const totalDrivers = await Driver.countDocuments({ vendorId });

    const onlineDrivers = await Driver.countDocuments({
      vendorId,
      isOnline: true
    });

    const totalEarnings = await Driver.aggregate([
      { $match: { vendorId: vendorId } },
      { $group: { _id: null, total: { $sum: "$totalEarnings" } } }
    ]);

    res.json({
      totalDrivers,
      onlineDrivers,
      totalEarnings: totalEarnings[0]?.total || 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};