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
      address
    } = req.body;

    // Basic validation
    if (!businessName || !ownerName || !email || !phone || !password) {
      return res.status(400).json({
        message: "All required fields must be provided"
      });
    }

    const existing = await Vendor.findOne({ email });
    if (existing) {
      return res.status(400).json({
        message: "Vendor already exists"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const vendor = await Vendor.create({
      businessName,
      ownerName,
      email,
      phone,
      password: hashedPassword,
      address,
      documents: req.body.documents || [],
      isVerified: false,   // default pending
      isActive: true       // default active
    });

    res.status(201).json({
      success: true,
      message: "Vendor registered successfully. Awaiting admin approval.",
      vendor
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
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
      return res.status(400).json({ message: "Vendor account not found. Please register first." });
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
    const vendor = await Vendor.findById(req.params.id).select("-password");

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
    let vendorId = req.body.id;
    const vendor = await Vendor.findByIdAndUpdate(
      vendorId,
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
    const drivers = await Driver.find({ vendorId: req.params.id });

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
    const { driverId,vendorId } = req.body;

    const driver = await Driver.findById(driverId);
    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    driver.vendorId = vendorId;
    await driver.save();

    await Vendor.findByIdAndUpdate(vendorId, {
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
    const { driverId ,vendorId} = req.params;

    const driver = await Driver.findOne({
      _id: driverId,
      vendorId: vendorId
    });

    if (!driver) {
      return res.status(404).json({ message: "Driver not found" });
    }

    driver.vendorId = null;
    await driver.save();

    await Vendor.findByIdAndUpdate(vendorId, {
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
    const { driverId,vendorId } = req.body;

    if (!driverId) {
      return res.status(400).json({
        message: "driverId is required"
      });
    }

    const driver = await Driver.findOne({
      _id: driverId,
      vendorId: vendorId
    });

    if (!driver) {
      return res.status(404).json({
        message: "Driver not found or not under your vendor account"
      });
    }

    driver.isVerified = true;
    driver.rejectionReason = null;

    await driver.save();

    res.json({
      success: true,
      message: "Driver verified successfully",
      driver
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// =============================
// 8. Reject Vendor Driver
// =============================
exports.rejectDriver = async (req, res) => {
  try {
    const { driverId, reason } = req.body;

    if (!driverId) {
      return res.status(400).json({
        message: "driverId is required"
      });
    }

    if (!reason) {
      return res.status(400).json({
        message: "Rejection reason is required"
      });
    }

    const driver = await Driver.findOne({
      _id: driverId,
      vendorId: req.user.id
    });

    if (!driver) {
      return res.status(404).json({
        message: "Driver not found or not under your vendor account"
      });
    }

    driver.isVerified = false;
    driver.rejectionReason = reason;

    await driver.save();

    res.json({
      success: true,
      message: "Driver rejected successfully",
      driver
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// =============================
// 9. Vendor Dashboard Stats
// =============================
exports.getDashboardStats = async (req, res) => {
  try {
    const { vendorId } = req.params;

    if (!vendorId) {
      return res.status(400).json({
        message: "vendorId is required"
      });
    }

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
      success: true,
      totalDrivers,
      onlineDrivers,
      totalEarnings: totalEarnings[0]?.total || 0
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};


//Documents Uploads

// Add Driver To Vendor
exports.addDriver = async (req, res) => {
  try {
    const vendorId = req.body.vendorId;
    const { name, email, phone, password, location } = req.body;

    if (!vendorId) {
      return res.status(400).json({ message: "vendorId is required" });
    }

    if (!name || !phone || !password) {
      return res.status(400).json({ message: "name, phone and password are required" });
    }

    // prevent duplicate phone
    const existing = await Driver.findOne({ phone });
    if (existing) {
      return res.status(400).json({ message: "Driver with this phone already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const driver = await Driver.create({
      name,
      email,
      phone,
      password: hashedPassword,
      location: location || {},
      documents: [],
      vendorId: vendorId,
      isVerified: false, // vendor-created drivers require vendor approval
      isActive: false
    });

    // increment vendor's driver count
    await Vendor.findByIdAndUpdate(vendorId, { $inc: { totalDrivers: 1 } });

    res.status(201).json({ success: true, message: "Driver created under vendor", driver });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// Block/Unblock Driver 
exports.blockDriver = async (req, res) => {
  try {
    const { driverId } = req.body;
    const vendorId = req.body.vendorId;

    if (!driverId) {
      return res.status(400).json({ message: "driverId is required" });
    }

    const driver = await Driver.findOne({ _id: driverId, vendorId });
    if (!driver) {
      return res.status(404).json({ message: "Driver not found or not under your vendor account" });
    }

    driver.isActive = false;
    await driver.save();

    res.json({ success: true, message: "Driver blocked successfully", driver });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.unblockDriver = async (req, res) => {
  try {
    const { driverId } = req.body;
    const vendorId = req.body.vendorId;

    if (!driverId) {
      return res.status(400).json({ message: "driverId is required" });
    }

    const driver = await Driver.findOne({ _id: driverId, vendorId });
    if (!driver) {
      return res.status(404).json({ message: "Driver not found or not under your vendor account" });
    }

    driver.isActive = true;
    await driver.save();

    res.json({ success: true, message: "Driver unblocked successfully", driver });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// Vendor Drivers Locations
exports.getVendorDriversLocations = async (req, res) => {
  try {
    const vendorId = req.params.vendorId || req.query.vendorId || req.body.vendorId || req.user?.id;

    if (!vendorId) {
      return res.status(400).json({ message: "vendorId is required" });
    }

    const drivers = await Driver.find({ vendorId }).select("name phone isOnline location");

    const locations = drivers.map((d) => ({
      id: d._id,
      name: d.name,
      phone: d.phone,
      isOnline: d.isOnline,
      location: d.location
    }));

    res.json({ success: true, total: locations.length, locations });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// Add Vendor Bank Account Details


// Get Vendor Bank Account Details 



// Update Vendor Bank Account Details


// Delete Vendor Bank Account Details



//Vendor Heatmap to show most active rides