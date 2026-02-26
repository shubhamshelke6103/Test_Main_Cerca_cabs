const Vendor = require('../../Models/vendor/vendor.models')
const Driver = require('../../Models/Driver/driver.model')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

// =============================
// 1. Register Vendor
// =============================
exports.registerVendor = async (req, res) => {
  try {
    const { businessName, ownerName, email, phone, password, address } =
      req.body

    // Basic validation
    if (!businessName || !ownerName || !email || !phone || !password) {
      return res.status(400).json({
        message: 'All required fields must be provided'
      })
    }

    const existing = await Vendor.findOne({ email })
    if (existing) {
      return res.status(400).json({
        message: 'Vendor already exists'
      })
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    const vendor = await Vendor.create({
      businessName,
      ownerName,
      email,
      phone,
      password: hashedPassword,
      address,
      documents: req.body.documents || [],
      isVerified: false, // default pending
      isActive: true // default active
    })

    res.status(201).json({
      success: true,
      message: 'Vendor registered successfully. Awaiting admin approval.',
      vendor
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

// =============================
// Vendor Login
// =============================
exports.loginVendor = async (req, res) => {
  try {
    const { email, password } = req.body

    const vendor = await Vendor.findOne({ email })

    if (!vendor) {
      return res
        .status(400)
        .json({ message: 'Vendor account not found. Please register first.' })
    }

    if (!vendor.isVerified) {
      return res.status(403).json({ message: 'Vendor not verified by admin' })
    }

    if (!vendor.isActive) {
      return res.status(403).json({ message: 'Vendor account is inactive' })
    }

    const isMatch = await bcrypt.compare(password, vendor.password)

    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' })
    }

    const accessToken = jwt.sign(
      {
        id: vendor._id,
        role: 'vendor'
      },
      process.env.ACCESS_SECRET,
      { expiresIn: '7d' }
    )

    res.json({
      message: 'Login successful',
      accessToken,
      vendor: {
        id: vendor._id,
        businessName: vendor.businessName,
        email: vendor.email
      }
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

// =============================
// 2. Get Vendor Profile
// =============================
exports.getVendorProfile = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id).select('-password')

    if (!vendor) {
      return res.status(404).json({ message: 'Vendor not found' })
    }

    res.json(vendor)
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

// =============================
// 3. Update Vendor Profile
// =============================
exports.updateVendorProfile = async (req, res) => {
  try {
    let vendorId = req.body.id
    const vendor = await Vendor.findByIdAndUpdate(vendorId, req.body, {
      new: true
    })

    res.json({
      message: 'Vendor profile updated',
      vendor
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

// =============================
// 4. Get All Drivers of Vendor
// =============================
exports.getVendorDrivers = async (req, res) => {
  try {
    const drivers = await Driver.find({ vendorId: req.params.id })

    res.json({
      total: drivers.length,
      drivers
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

// =============================
// 5. Assign Existing Driver to Vendor
// =============================
exports.assignDriverToVendor = async (req, res) => {
  try {
    const { driverId, vendorId } = req.body

    const driver = await Driver.findById(driverId)
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' })
    }

    driver.vendorId = vendorId
    await driver.save()

    await Vendor.findByIdAndUpdate(vendorId, {
      $inc: { totalDrivers: 1 }
    })

    res.json({
      message: 'Driver assigned to vendor successfully',
      driver
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

// =============================
// 6. Remove Driver from Vendor
// =============================
exports.removeDriverFromVendor = async (req, res) => {
  try {
    const { driverId, vendorId } = req.params

    const driver = await Driver.findOne({
      _id: driverId,
      vendorId: vendorId
    })

    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' })
    }

    driver.vendorId = null
    await driver.save()

    await Vendor.findByIdAndUpdate(vendorId, {
      $inc: { totalDrivers: -1 }
    })

    res.json({
      message: 'Driver removed from vendor'
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

// =============================
// 7. Verify Vendor Driver
// =============================
exports.verifyDriver = async (req, res) => {
  try {
    const { driverId, vendorId } = req.body

    if (!driverId) {
      return res.status(400).json({
        message: 'driverId is required'
      })
    }

    const driver = await Driver.findOne({
      _id: driverId,
      vendorId: vendorId
    })

    if (!driver) {
      return res.status(404).json({
        message: 'Driver not found or not under your vendor account'
      })
    }

    driver.isVerified = true
    driver.rejectionReason = null

    await driver.save()

    res.json({
      success: true,
      message: 'Driver verified successfully',
      driver
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

// =============================
// 8. Reject Vendor Driver
// =============================
exports.rejectDriver = async (req, res) => {
  try {
    const { driverId, reason } = req.body

    if (!driverId) {
      return res.status(400).json({
        message: 'driverId is required'
      })
    }

    if (!reason) {
      return res.status(400).json({
        message: 'Rejection reason is required'
      })
    }

    const driver = await Driver.findOne({
      _id: driverId,
      vendorId: req.user.id
    })

    if (!driver) {
      return res.status(404).json({
        message: 'Driver not found or not under your vendor account'
      })
    }

    driver.isVerified = false
    driver.rejectionReason = reason

    await driver.save()

    res.json({
      success: true,
      message: 'Driver rejected successfully',
      driver
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

// =============================
// 9. Vendor Dashboard Stats
// =============================
exports.getDashboardStats = async (req, res) => {
  try {
    const { vendorId } = req.params

    if (!vendorId) {
      return res.status(400).json({
        message: 'vendorId is required'
      })
    }

    // fetch vendor meta data
    const vendor = await Vendor.findById(vendorId)
      .select('businessName walletBalance totalEarnings totalDrivers')
      .lean()

    if (!vendor) {
      return res
        .status(404)
        .json({ success: false, message: 'Vendor not found' })
    }

    // fetch drivers belonging to this vendor
    const drivers = await Driver.find({ vendorId })
      .select('name phone isOnline isActive isVerified totalEarnings')
      .lean()

    const totalDrivers = drivers.length
    const onlineDrivers = drivers.filter(d => d.isOnline).length
    const activeDrivers = drivers.filter(d => d.isActive).length
    const verifiedDrivers = drivers.filter(d => d.isVerified).length
    const totalDriverEarnings = drivers.reduce(
      (sum, d) => sum + (d.totalEarnings || 0),
      0
    )

    res.json({
      success: true,
      vendor: {
        id: vendor._id,
        businessName: vendor.businessName,
        walletBalance: vendor.walletBalance || 0,
        totalEarnings: vendor.totalEarnings || 0,
        totalDrivers: vendor.totalDrivers || 0
      },
      metrics: {
        totalDrivers,
        onlineDrivers,
        activeDrivers,
        verifiedDrivers,
        totalDriverEarnings: Math.round(totalDriverEarnings * 100) / 100
      },
      drivers
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

//Documents Uploads

// Add Driver To Vendor
exports.addDriver = async (req, res) => {
  try {
    const vendorId = req.body.vendorId
    const { name, email, phone, password, location } = req.body

    if (!vendorId) {
      return res.status(400).json({ message: 'vendorId is required' })
    }

    if (!name || !phone || !password) {
      return res
        .status(400)
        .json({ message: 'name, phone and password are required' })
    }

    // prevent duplicate phone
    const existing = await Driver.findOne({ phone })
    if (existing) {
      return res
        .status(400)
        .json({ message: 'Driver with this phone already exists' })
    }

    const hashedPassword = await bcrypt.hash(password, 10)

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
    })

    // increment vendor's driver count
    await Vendor.findByIdAndUpdate(vendorId, { $inc: { totalDrivers: 1 } })

    res
      .status(201)
      .json({ success: true, message: 'Driver created under vendor', driver })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// Block/Unblock Driver
exports.blockDriver = async (req, res) => {
  try {
    const { driverId } = req.body
    const vendorId = req.body.vendorId

    if (!driverId) {
      return res.status(400).json({ message: 'driverId is required' })
    }

    const driver = await Driver.findOne({ _id: driverId, vendorId })
    if (!driver) {
      return res
        .status(404)
        .json({ message: 'Driver not found or not under your vendor account' })
    }

    driver.isActive = false
    await driver.save()

    res.json({ success: true, message: 'Driver blocked successfully', driver })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

exports.unblockDriver = async (req, res) => {
  try {
    const { driverId } = req.body
    const vendorId = req.body.vendorId

    if (!driverId) {
      return res.status(400).json({ message: 'driverId is required' })
    }

    const driver = await Driver.findOne({ _id: driverId, vendorId })
    if (!driver) {
      return res
        .status(404)
        .json({ message: 'Driver not found or not under your vendor account' })
    }

    driver.isActive = true
    await driver.save()

    res.json({
      success: true,
      message: 'Driver unblocked successfully',
      driver
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// Vendor Drivers Locations
// Get Single Driver Location (Vendor Only)
exports.getDriverLocationById = async (req, res) => {
  try {
    const vendorId = req.body.vendorId 
    const { driverId } = req.params

    if (!vendorId) {
      return res.status(400).json({
        success: false,
        message: 'Vendor ID is required'
      })
    }

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: 'Driver ID is required'
      })
    }

    // Check driver belongs to this vendor
    const driver = await Driver.findOne({
      _id: driverId,
      vendorId: vendorId
    }).select('name phone isOnline location')

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found under this vendor'
      })
    }

    return res.status(200).json({
      success: true,
      message: 'Driver location fetched successfully',
      data: {
        driverId: driver._id,
        name: driver.name,
        phone: driver.phone,
        isOnline: driver.isOnline,
        latitude: driver.location?.coordinates?.[1] || null,
        longitude: driver.location?.coordinates?.[0] || null
      }
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

// Get driver documents (vendor only)
exports.getDriverDocuments = async (req, res) => {
  try {
    const vendorId = req.body.vendorId 
    const { driverId } = req.params

    if (!vendorId) {
      return res
        .status(400)
        .json({ success: false, message: 'Vendor ID is required' })
    }

    if (!driverId) {
      return res
        .status(400)
        .json({ success: false, message: 'Driver ID is required' })
    }

    const driver = await Driver.findOne({ _id: driverId, vendorId }).select(
      'documents'
    )
    if (!driver) {
      return res
        .status(404)
        .json({ success: false, message: 'Driver not found under this vendor' })
    }

    return res
      .status(200)
      .json({ success: true, documents: driver.documents || [] })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

// Add Vendor Bank Account Details
exports.addVendorBankAccount = async (req, res) => {
  try {
    const { vendorId } = req.params
    const {
      accountNumber,
      ifscCode,
      accountHolderName,
      bankName,
      accountType
    } = req.body

    if (!vendorId) {
      return res
        .status(400)
        .json({ success: false, message: 'vendorId is required' })
    }

    if (!accountNumber || !ifscCode || !accountHolderName || !bankName) {
      return res.status(400).json({
        success: false,
        message:
          'All bank account fields (accountNumber, ifscCode, accountHolderName, bankName) are required'
      })
    }

    const vendor = await Vendor.findById(vendorId)
    if (!vendor) {
      return res
        .status(404)
        .json({ success: false, message: 'Vendor not found' })
    }

    vendor.bankAccount = {
      accountNumber,
      ifscCode,
      accountHolderName,
      bankName,
      accountType: accountType || vendor.bankAccount?.accountType || 'CURRENT'
    }

    await vendor.save()

    return res.status(201).json({
      success: true,
      message: 'Bank account added successfully',
      data: { bankAccount: vendor.bankAccount }
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

// Get Vendor Bank Account Details
exports.getVendorBankAccount = async (req, res) => {
  try {
    const { vendorId } = req.params

    if (!vendorId) {
      return res
        .status(400)
        .json({ success: false, message: 'vendorId is required' })
    }

    const vendor = await Vendor.findById(vendorId).select('bankAccount')
    if (!vendor) {
      return res
        .status(404)
        .json({ success: false, message: 'Vendor not found' })
    }

    return res.status(200).json({
      success: true,
      data: { bankAccount: vendor.bankAccount || null }
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

// Update Vendor Bank Account Details
exports.updateVendorBankAccount = async (req, res) => {
  try {
    const { vendorId } = req.params
    const update = req.body

    if (!vendorId) {
      return res
        .status(400)
        .json({ success: false, message: 'vendorId is required' })
    }

    const vendor = await Vendor.findById(vendorId)
    if (!vendor) {
      return res
        .status(404)
        .json({ success: false, message: 'Vendor not found' })
    }

    vendor.bankAccount = {
      ...vendor.bankAccount,
      ...update
    }

    await vendor.save()

    return res.status(200).json({
      success: true,
      message: 'Bank account updated successfully',
      data: { bankAccount: vendor.bankAccount }
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

// Delete Vendor Bank Account Details
exports.deleteVendorBankAccount = async (req, res) => {
  try {
    const { vendorId } = req.params

    if (!vendorId) {
      return res
        .status(400)
        .json({ success: false, message: 'vendorId is required' })
    }

    const vendor = await Vendor.findById(vendorId)
    if (!vendor) {
      return res
        .status(404)
        .json({ success: false, message: 'Vendor not found' })
    }

    vendor.bankAccount = {}
    await vendor.save()

    return res.status(200).json({
      success: true,
      message: 'Bank account deleted successfully'
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

//Vendor Heatmap to show most active rides
