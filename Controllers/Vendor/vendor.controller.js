const Vendor = require('../../Models/vendor/vendor.models')
const Driver = require('../../Models/Driver/driver.model')
const Ride = require('../../Models/Driver/ride.model')
const AdminEarnings = require('../../Models/Admin/adminEarnings.model')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { syncComplianceStatuses } = require('../../utils/compliance.service')
const { getFleetOnlineHoursSummary } = require('../../utils/driverSession.service')

const buildDateRange = (period, startDate, endDate) => {
  const now = new Date()
  if (startDate || endDate) {
    return {
      start: startDate ? new Date(startDate) : new Date(now.getFullYear(), now.getMonth(), 1),
      end: endDate ? new Date(endDate) : now,
      groupBy: period || 'daily'
    }
  }
  if (period === 'monthly') {
    return {
      start: new Date(now.getFullYear(), 0, 1),
      end: now,
      groupBy: 'monthly'
    }
  }
  if (period === 'weekly') {
    return {
      start: new Date(now.getTime() - 84 * 24 * 60 * 60 * 1000),
      end: now,
      groupBy: 'weekly'
    }
  }
  return {
    start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    end: now,
    groupBy: 'daily'
  }
}

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
// Get single driver (vendor-scoped; for detail view)
// =============================
exports.getVendorDriverById = async (req, res) => {
  try {
    const vendorId = req.user.id
    const { driverId } = req.params

    const driver = await Driver.findOne({ _id: driverId, vendorId }).select('-password')
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found or not under your vendor account' })
    }

    res.json(driver)
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
      .select('name phone isOnline isActive isVerified totalEarnings rideRejectionCount')
      .lean()

    const totalDrivers = drivers.length
    const onlineDrivers = drivers.filter(d => d.isOnline).length
    const activeDrivers = drivers.filter(d => d.isActive).length
    const verifiedDrivers = drivers.filter(d => d.isVerified).length
    const totalDriverEarnings = drivers.reduce(
      (sum, d) => sum + (d.totalEarnings || 0), 0)

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
        totalDriverEarnings: Math.round(totalDriverEarnings * 100) / 100,
        totalRideRejections: drivers.reduce((sum, driver) => sum + (driver.rideRejectionCount || 0), 0)
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

exports.getVendorEarningsReport = async (req, res) => {
  try {
    const vendorId = req.user.id
    const { startDate, endDate } = req.query

    const drivers = await Driver.find({ vendorId }).select('name phone email').lean()
    const driverIds = drivers.map(driver => driver._id)

    if (driverIds.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          summary: {
            totalGrossRevenue: 0,
            totalDriverEarnings: 0,
            totalVendorCommission: 0,
            totalPlatformFee: 0,
            rideCount: 0
          },
          driverWiseEarnings: [],
          rideWiseRevenue: []
        }
      })
    }

    const earningsFilter = { driverId: { $in: driverIds } }
    if (startDate || endDate) {
      earningsFilter.rideDate = {}
      if (startDate) earningsFilter.rideDate.$gte = new Date(startDate)
      if (endDate) earningsFilter.rideDate.$lte = new Date(endDate)
    }

    const vendor = await Vendor.findById(vendorId).select('commissionType commissionValue businessName').lean()
    const earnings = await AdminEarnings.find(earningsFilter)
      .populate('rideId', 'pickupAddress dropoffAddress fare createdAt paymentMethod')
      .populate('driverId', 'name phone email')
      .sort({ rideDate: -1 })
      .lean()

    const commissionFromDriverEarning = driverEarning => {
      if (!vendor) return 0
      if (vendor.commissionType === 'FIXED') {
        return Math.min(vendor.commissionValue || 0, driverEarning || 0)
      }
      return Math.round(((driverEarning || 0) * ((vendor.commissionValue || 0) / 100)) * 100) / 100
    }

    const rideWiseRevenue = earnings.map(entry => {
      const vendorCommission = commissionFromDriverEarning(entry.driverEarning)
      return {
        earningId: entry._id,
        rideId: entry.rideId?._id || null,
        rideDate: entry.rideDate,
        driver: entry.driverId ? {
          id: entry.driverId._id,
          name: entry.driverId.name,
          phone: entry.driverId.phone
        } : null,
        pickupAddress: entry.rideId?.pickupAddress || null,
        dropoffAddress: entry.rideId?.dropoffAddress || null,
        grossRevenue: Math.round((entry.grossFare || 0) * 100) / 100,
        platformFee: Math.round((entry.platformFee || 0) * 100) / 100,
        driverEarning: Math.round((entry.driverEarning || 0) * 100) / 100,
        vendorCommission: Math.round(vendorCommission * 100) / 100,
        vendorProfit: Math.round(vendorCommission * 100) / 100,
        paymentStatus: entry.paymentStatus
      }
    })

    const driverWiseMap = new Map()
    for (const row of rideWiseRevenue) {
      if (!row.driver?.id) continue
      const key = row.driver.id.toString()
      if (!driverWiseMap.has(key)) {
        driverWiseMap.set(key, {
          driverId: row.driver.id,
          name: row.driver.name,
          phone: row.driver.phone,
          rideCount: 0,
          grossRevenue: 0,
          driverEarning: 0,
          vendorCommission: 0
        })
      }

      const current = driverWiseMap.get(key)
      current.rideCount += 1
      current.grossRevenue += row.grossRevenue || 0
      current.driverEarning += row.driverEarning || 0
      current.vendorCommission += row.vendorCommission || 0
    }

    const driverWiseEarnings = Array.from(driverWiseMap.values()).map(item => ({
      ...item,
      grossRevenue: Math.round(item.grossRevenue * 100) / 100,
      driverEarning: Math.round(item.driverEarning * 100) / 100,
      vendorCommission: Math.round(item.vendorCommission * 100) / 100
    }))

    const summary = rideWiseRevenue.reduce((acc, row) => {
      acc.totalGrossRevenue += row.grossRevenue || 0
      acc.totalDriverEarnings += row.driverEarning || 0
      acc.totalVendorCommission += row.vendorCommission || 0
      acc.totalPlatformFee += row.platformFee || 0
      acc.rideCount += 1
      return acc
    }, {
      totalGrossRevenue: 0,
      totalDriverEarnings: 0,
      totalVendorCommission: 0,
      totalPlatformFee: 0,
      rideCount: 0
    })

    res.status(200).json({
      success: true,
      data: {
        vendor: {
          id: vendor?._id,
          businessName: vendor?.businessName || null,
          commissionType: vendor?.commissionType || null,
          commissionValue: vendor?.commissionValue || 0
        },
        summary: {
          totalGrossRevenue: Math.round(summary.totalGrossRevenue * 100) / 100,
          totalDriverEarnings: Math.round(summary.totalDriverEarnings * 100) / 100,
          totalVendorCommission: Math.round(summary.totalVendorCommission * 100) / 100,
          totalPlatformFee: Math.round(summary.totalPlatformFee * 100) / 100,
          rideCount: summary.rideCount
        },
        driverWiseEarnings,
        rideWiseRevenue
      }
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

exports.getVendorOnlineHoursReport = async (req, res) => {
  try {
    const vendorId = req.user.id
    const { period, startDate, endDate } = req.query
    const range = buildDateRange(period, startDate, endDate)

    const drivers = await Driver.find({ vendorId }).select('_id name').lean()
    const driverIds = drivers.map(d => d._id)
    if (driverIds.length === 0) {
      return res.status(200).json({
        success: true,
        summary: [],
        totalMinutes: 0,
        totalSessions: 0,
        drivers: []
      })
    }

    const report = await getFleetOnlineHoursSummary({
      driverIds,
      startDate: range.start,
      endDate: range.end,
      groupBy: range.groupBy
    })

    const driversWithHours = drivers.map(driver => {
      const driverReport = report.driverBreakdown[String(driver._id)] || {
        totalMinutes: 0,
        sessionCount: 0
      }
      return {
        id: driver._id,
        name: driver.name,
        totalMinutes: driverReport.totalMinutes || 0,
        sessionCount: driverReport.sessionCount || 0
      }
    })

    return res.status(200).json({
      success: true,
      period: range.groupBy,
      startDate: range.start,
      endDate: range.end,
      summary: report.summary,
      totalMinutes: report.totalMinutes,
      totalSessions: report.totalSessions,
      drivers: driversWithHours
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    })
  }
}



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
      email: email || `${phone}@vendor.local`,
      phone,
      password: hashedPassword,
      location: location && location.coordinates ? location : { type: 'Point', coordinates: [0, 0] },
      documents: [],
      vendorId: vendorId,
      isVerified: false,
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

// Update driver (vendor-scoped: only allowed fields, driver must belong to vendor)
exports.updateVendorDriver = async (req, res) => {
  try {
    const vendorId = req.user.id
    const { driverId } = req.params
    const { name, email, phone, password } = req.body

    if (!driverId) {
      return res.status(400).json({ message: 'driverId is required' })
    }

    const driver = await Driver.findOne({ _id: driverId, vendorId })
    if (!driver) {
      return res
        .status(404)
        .json({ message: 'Driver not found or not under your vendor account' })
    }

    if (name !== undefined) driver.name = name
    if (email !== undefined) driver.email = email
    if (phone !== undefined) {
      const existing = await Driver.findOne({ phone, _id: { $ne: driverId } })
      if (existing) {
        return res.status(400).json({ message: 'Another driver already has this phone number' })
      }
      driver.phone = phone
    }
    if (password && password.length >= 4) {
      driver.password = await bcrypt.hash(password, 10)
    }

    await driver.save()

    res.json({ success: true, message: 'Driver updated', driver })
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
    const vendorId = req.user?.id || req.body.vendorId
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
    const vendorId = req.user?.id || req.body.vendorId
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

exports.updateVendorComplianceDocuments = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.user.id)
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' })
    }

    vendor.complianceDocuments = syncComplianceStatuses(
      Array.isArray(req.body.complianceDocuments) ? req.body.complianceDocuments : []
    )
    await vendor.save()

    return res.status(200).json({
      success: true,
      message: 'Vendor compliance documents updated successfully',
      data: vendor.complianceDocuments
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

exports.updateVendorDriverComplianceDocuments = async (req, res) => {
  try {
    const driver = await Driver.findOne({
      _id: req.params.driverId,
      vendorId: req.user.id
    })

    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found under this vendor' })
    }

    driver.complianceDocuments = syncComplianceStatuses(
      Array.isArray(req.body.complianceDocuments) ? req.body.complianceDocuments : []
    )
    await driver.save()

    return res.status(200).json({
      success: true,
      message: 'Driver compliance documents updated successfully',
      data: driver.complianceDocuments
    })
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

// =============================
// Upload vendor document (Aadhaar) – post-registration (public)
// Only allowed when vendor has no documents yet.
// =============================
exports.uploadVendorDocumentPostRegister = async (req, res) => {
  try {
    const vendorId = req.body.vendorId
    if (!vendorId) {
      return res.status(400).json({ success: false, message: 'vendorId is required' })
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No document file uploaded' })
    }

    const vendor = await Vendor.findById(vendorId)
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' })
    }
    if (vendor.documents && vendor.documents.length > 0) {
      return res.status(400).json({ success: false, message: 'Vendor already has documents uploaded' })
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`
    const documentUrl = `${baseUrl}/uploads/vendorDocuments/${req.file.filename}`
    vendor.documents = vendor.documents || []
    vendor.documents.push(documentUrl)
    await vendor.save()

    return res.status(200).json({
      success: true,
      message: 'Document submitted for verification.',
      documents: vendor.documents
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

// =============================
// Upload vendor document (protected – logged-in vendor)
// =============================
exports.uploadVendorDocument = async (req, res) => {
  try {
    const vendorId = req.user.id
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No document file uploaded' })
    }

    const vendor = await Vendor.findById(vendorId)
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' })
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`
    const documentUrl = `${baseUrl}/uploads/vendorDocuments/${req.file.filename}`
    vendor.documents = vendor.documents || []
    vendor.documents.push(documentUrl)
    await vendor.save()

    return res.status(200).json({
      success: true,
      message: 'Document uploaded successfully.',
      documents: vendor.documents
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

//Vendor Heatmap to show most active rides
