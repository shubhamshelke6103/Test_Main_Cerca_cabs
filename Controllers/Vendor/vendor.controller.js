const Vendor = require('../../Models/vendor/vendor.models')
const Driver = require('../../Models/Driver/driver.model')
const FleetVehicle = require('../../Models/Vendor/fleetVehicle.model')
const Ride = require('../../Models/Driver/ride.model')
const AdminEarnings = require('../../Models/Admin/adminEarnings.model')
const Settings = require('../../Models/Admin/settings.modal')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const mongoose = require('mongoose')
const logger = require('../../utils/logger')
const { dispatchExternalAlert } = require('../../utils/alerting.service')
const { syncComplianceStatuses } = require('../../utils/compliance.service')
const { getFleetOnlineHoursSummary } = require('../../utils/driverSession.service')
const {
  REQUIRED_DRIVER_APPROVAL_DOCUMENT_TYPES,
  getMissingDriverApprovalDocuments,
  buildInitialApprovalWorkflow,
  setDriverPendingApproval,
  vendorApproveDriver,
  rejectDriverApproval,
  getDriverApprovalSummary,
  DRIVER_APPROVAL_ACTOR
} = require('../../utils/driverApproval.service')
const {
  validateBankFields,
  pickBankUpdate,
  assertVendorIdMatchesUser
} = require('../../utils/vendorBank.util')
const VendorPayout = mongoose.model('VendorPayout')

const roundCurrency = value => Math.round((Number(value) || 0) * 100) / 100

const calculateVendorCommission = (vendor, driverEarning) => {
  const normalizedDriverEarning = Number(driverEarning) || 0
  if (!vendor || normalizedDriverEarning <= 0) return 0

  if (vendor.commissionType === 'FIXED') {
    return roundCurrency(
      Math.min(Number(vendor.commissionValue) || 0, normalizedDriverEarning)
    )
  }

  return roundCurrency(
    normalizedDriverEarning * ((Number(vendor.commissionValue) || 0) / 100)
  )
}

const buildVendorEarningsFilter = ({ driverIds, startDate, endDate }) => {
  const filter = {
    driverId: { $in: driverIds },
    paymentStatus: 'completed'
  }

  if (startDate || endDate) {
    filter.rideDate = {}
    if (startDate) filter.rideDate.$gte = new Date(startDate)
    if (endDate) filter.rideDate.$lte = new Date(endDate)
  }

  return filter
}

const getVendorBaseContext = async vendorId => {
  const vendor = await Vendor.findById(vendorId)
    .select(
      'businessName commissionType commissionValue walletBalance totalEarnings totalRides totalDrivers bankAccount'
    )
    .lean()

  if (!vendor) {
    return { vendor: null, drivers: [], driverIds: [] }
  }

  const drivers = await Driver.find({ vendorId })
    .select('name phone email isOnline isActive isVerified totalEarnings rideRejectionCount')
    .lean()

  return {
    vendor,
    drivers,
    driverIds: drivers.map(driver => driver._id)
  }
}

const getVendorEarningsReportData = async ({ vendorId, startDate, endDate }) => {
  const { vendor, driverIds } = await getVendorBaseContext(vendorId)

  if (!vendor || driverIds.length === 0) {
    return {
      vendor,
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
  }

  const earnings = await AdminEarnings.find(
    buildVendorEarningsFilter({ driverIds, startDate, endDate })
  )
    .populate('rideId', 'pickupAddress dropoffAddress fare createdAt paymentMethod')
    .populate('driverId', 'name phone email')
    .sort({ rideDate: -1 })
    .lean()

  const rideWiseRevenue = earnings.map(entry => {
    const vendorCommission = calculateVendorCommission(vendor, entry.driverEarning)
    return {
      earningId: entry._id,
      rideId: entry.rideId?._id || null,
      rideDate: entry.rideDate,
      driver: entry.driverId
        ? {
            id: entry.driverId._id,
            name: entry.driverId.name,
            phone: entry.driverId.phone,
            email: entry.driverId.email || null
          }
        : null,
      pickupAddress: entry.rideId?.pickupAddress || null,
      dropoffAddress: entry.rideId?.dropoffAddress || null,
      grossRevenue: roundCurrency(entry.grossFare),
      platformFee: roundCurrency(entry.platformFee),
      driverEarning: roundCurrency(entry.driverEarning),
      vendorCommission,
      vendorProfit: vendorCommission,
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
        email: row.driver.email || null,
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
    grossRevenue: roundCurrency(item.grossRevenue),
    driverEarning: roundCurrency(item.driverEarning),
    vendorCommission: roundCurrency(item.vendorCommission)
  }))

  const summary = rideWiseRevenue.reduce(
    (acc, row) => {
      acc.totalGrossRevenue += row.grossRevenue || 0
      acc.totalDriverEarnings += row.driverEarning || 0
      acc.totalVendorCommission += row.vendorCommission || 0
      acc.totalPlatformFee += row.platformFee || 0
      acc.rideCount += 1
      return acc
    },
    {
      totalGrossRevenue: 0,
      totalDriverEarnings: 0,
      totalVendorCommission: 0,
      totalPlatformFee: 0,
      rideCount: 0
    }
  )

  return {
    vendor,
    summary: {
      totalGrossRevenue: roundCurrency(summary.totalGrossRevenue),
      totalDriverEarnings: roundCurrency(summary.totalDriverEarnings),
      totalVendorCommission: roundCurrency(summary.totalVendorCommission),
      totalPlatformFee: roundCurrency(summary.totalPlatformFee),
      rideCount: summary.rideCount
    },
    driverWiseEarnings,
    rideWiseRevenue
  }
}

const getVendorFinancialSnapshot = async vendorId => {
  const { vendor, driverIds } = await getVendorBaseContext(vendorId)

  if (!vendor || driverIds.length === 0) {
    return {
      vendor,
      driverIds,
      totalCompletedCommission: 0,
      totalCompletedRides: 0,
      availableBalance: 0,
      pendingPayoutAmount: 0,
      processingPayoutAmount: 0,
      paidOutAmount: 0,
      reservedCommissionAmount: 0,
      completedEarningsCount: 0,
      eligibleEarningsCount: 0,
      eligibleCommissionRows: []
    }
  }

  const [completedEarnings, payouts] = await Promise.all([
    AdminEarnings.find({
      driverId: { $in: driverIds },
      paymentStatus: 'completed'
    })
      .select('driverId rideId driverEarning grossFare platformFee rideDate')
      .lean(),
    VendorPayout.find({
      vendor: vendorId,
      status: { $in: ['PENDING', 'PROCESSING', 'COMPLETED'] }
    })
      .select('status amount relatedEarnings')
      .lean()
  ])

  const reservedEarningIds = new Set()
  payouts.forEach(payout => {
    if (!Array.isArray(payout.relatedEarnings)) return
    payout.relatedEarnings.forEach(earningId => {
      if (earningId) reservedEarningIds.add(earningId.toString())
    })
  })

  const completedCommissionRows = completedEarnings.map(earning => ({
    earningId: earning._id?.toString(),
    rideId: earning.rideId || null,
    driverId: earning.driverId || null,
    driverEarning: roundCurrency(earning.driverEarning),
    vendorCommission: calculateVendorCommission(vendor, earning.driverEarning),
    rideDate: earning.rideDate
  }))

  const eligibleCommissionRows = completedCommissionRows.filter(
    row => row.earningId && !reservedEarningIds.has(row.earningId)
  )

  const totalCompletedCommission = roundCurrency(
    completedCommissionRows.reduce(
      (sum, row) => sum + (row.vendorCommission || 0),
      0
    )
  )
  const availableBalance = roundCurrency(
    eligibleCommissionRows.reduce(
      (sum, row) => sum + (row.vendorCommission || 0),
      0
    )
  )
  const pendingPayoutAmount = roundCurrency(
    payouts
      .filter(payout => payout.status === 'PENDING')
      .reduce((sum, payout) => sum + (payout.amount || 0), 0)
  )
  const processingPayoutAmount = roundCurrency(
    payouts
      .filter(payout => payout.status === 'PROCESSING')
      .reduce((sum, payout) => sum + (payout.amount || 0), 0)
  )
  const paidOutAmount = roundCurrency(
    payouts
      .filter(payout => payout.status === 'COMPLETED')
      .reduce((sum, payout) => sum + (payout.amount || 0), 0)
  )

  return {
    vendor,
    driverIds,
    totalCompletedCommission,
    totalCompletedRides: completedEarnings.length,
    availableBalance,
    pendingPayoutAmount,
    processingPayoutAmount,
    paidOutAmount,
    reservedCommissionAmount: roundCurrency(
      totalCompletedCommission - availableBalance
    ),
    completedEarningsCount: completedCommissionRows.length,
    eligibleEarningsCount: eligibleCommissionRows.length,
    eligibleCommissionRows
  }
}

const syncVendorFinancialFields = async vendorId => {
  const snapshot = await getVendorFinancialSnapshot(vendorId)

  if (!snapshot.vendor) return snapshot

  await Vendor.findByIdAndUpdate(vendorId, {
    $set: {
      walletBalance: snapshot.availableBalance,
      totalEarnings: snapshot.totalCompletedCommission,
      totalRides: snapshot.totalCompletedRides
    }
  })

  return snapshot
}

const normalizeStoredDocumentUrl = (req, url) => {
  const rawUrl = String(url || '').trim()
  if (!rawUrl) return rawUrl

  const baseUrl = `${req.protocol}://${req.get('host')}`
  const normalizedPath = rawUrl.replace(/\\/g, '/')
  const uploadsIndex = normalizedPath.lastIndexOf('/uploads/')

  if (uploadsIndex >= 0) {
    return `${baseUrl}${normalizedPath.slice(uploadsIndex)}`
  }

  if (/^https?:\/\//i.test(rawUrl)) {
    return rawUrl
  }

  if (normalizedPath.startsWith('uploads/')) {
    return `${baseUrl}/${normalizedPath}`
  }

  if (normalizedPath.startsWith('/uploads/')) {
    return `${baseUrl}${normalizedPath}`
  }

  return normalizedPath
}

const normalizeVehicleDocuments = (vehicleInfo, req) => {
  if (!vehicleInfo || !Array.isArray(vehicleInfo.documents)) {
    return vehicleInfo || null
  }

  return {
    ...vehicleInfo,
    documents: vehicleInfo.documents.map(doc => ({
      ...doc,
      documentUrl: normalizeStoredDocumentUrl(req, doc.documentUrl)
    }))
  }
}

const resolveDriverVehicleStatus = driver => (
  driver.pendingVehicleInfo?.approvalStatus ||
  (driver.vehicleInfo || driver.assignedFleetVehicleId ? 'APPROVED' : 'NOT_ADDED')
)

const serializeVehicleState = (driver) => ({
  approvedVehicle: driver.vehicleInfo || driver.assignedFleetVehicleId || null,
  pendingVehicle: driver.pendingVehicleInfo || null,
  vehicleStatus: resolveDriverVehicleStatus(driver)
})

const buildDriverVehicleInfoFromFleetVehicle = fleetVehicle => {
  if (!fleetVehicle) return null

  return {
    make: fleetVehicle.make,
    model: fleetVehicle.model,
    year: fleetVehicle.year,
    color: fleetVehicle.color,
    licensePlate: fleetVehicle.licensePlate,
    vehicleType: fleetVehicle.vehicleType
  }
}

const matchesVehicleSnapshot = (vehicleInfo, fleetVehicle) => {
  if (!vehicleInfo || !fleetVehicle) return false

  return (
    vehicleInfo.make === fleetVehicle.make &&
    vehicleInfo.model === fleetVehicle.model &&
    Number(vehicleInfo.year) === Number(fleetVehicle.year) &&
    vehicleInfo.color === fleetVehicle.color &&
    vehicleInfo.licensePlate === fleetVehicle.licensePlate &&
    vehicleInfo.vehicleType === fleetVehicle.vehicleType
  )
}

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const getDriverVendorSummary = driver => {
  const vendor = driver?.vendorId
  if (!vendor || typeof vendor !== 'object') {
    return null
  }

  return {
    id: vendor._id || null,
    businessName: vendor.businessName || null
  }
}

const serializeDriverForResponse = (driver, req) => {
  const serializedDriver = driver.toObject()
  const vendorSummary = getDriverVendorSummary(serializedDriver)

  return {
    ...serializedDriver,
    vendor: vendorSummary,
    registrationType: serializedDriver.vendorId ? 'VENDOR_ASSIGNED' : 'SELF_REGISTERED',
    pendingVehicleInfo: normalizeVehicleDocuments(serializedDriver.pendingVehicleInfo, req),
    vehicleStatus: resolveDriverVehicleStatus(driver),
    approvalStatus: getDriverApprovalSummary(driver).status,
    approvalWorkflow: getDriverApprovalSummary(driver),
    missingDocuments: getMissingDriverApprovalDocuments(driver)
  }
}

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

const VENDOR_RESET_OTP_EXPIRY_MINUTES = 10

const generateVendorResetOtp = () =>
  crypto.randomInt(100000, 1000000).toString()

const hashResetOtp = otp =>
  crypto.createHash('sha256').update(String(otp)).digest('hex')

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
      isActive: true, // default active
      vendorReviewStatus: 'PENDING'
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

    const isMatch = await bcrypt.compare(password, vendor.password)

    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' })
    }

    if (!vendor.isActive) {
      return res.status(403).json({
        message: 'Vendor account is inactive',
        code: 'VENDOR_INACTIVE'
      })
    }

    if (!vendor.isVerified) {
      const reason = (vendor.rejectionReason || '').toString().trim()
      const isRejected =
        vendor.vendorReviewStatus === 'REJECTED' || reason.length > 0
      const code = isRejected
        ? 'VENDOR_REJECTED'
        : 'VENDOR_PENDING_VERIFICATION'
      const message = isRejected
        ? 'Vendor application was not approved'
        : 'Vendor not verified by admin'
      return res.status(403).json({
        message,
        code,
        rejectionReason: isRejected ? vendor.rejectionReason : null,
        vendorId: vendor._id.toString(),
        allowDocumentResubmit: Boolean(vendor.allowDocumentResubmit)
      })
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
// Vendor Forgot Password
// =============================
exports.forgotVendorPassword = async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()

    if (!email) {
      return res.status(400).json({ message: 'Email is required' })
    }

    const vendor = await Vendor.findOne({ email })

    if (!vendor || !vendor.isActive) {
      return res.status(200).json({
        message:
          'If a vendor account exists with this email, an OTP has been sent.'
      })
    }

    const otp = generateVendorResetOtp()
    vendor.passwordResetOtpHash = hashResetOtp(otp)
    vendor.passwordResetExpiresAt = new Date(
      Date.now() + VENDOR_RESET_OTP_EXPIRY_MINUTES * 60 * 1000
    )
    vendor.passwordResetRequestedAt = new Date()
    vendor.passwordResetAttempts = 0
    await vendor.save()

    await dispatchExternalAlert({
      channel: 'email',
      to: vendor.email,
      subject: 'Vendor password reset OTP',
      message: `Your vendor password reset OTP is ${otp}. It expires in ${VENDOR_RESET_OTP_EXPIRY_MINUTES} minutes.`,
      metadata: {
        vendorId: vendor._id.toString(),
        purpose: 'vendor_password_reset'
      }
    })

    return res.status(200).json({
      message:
        'If a vendor account exists with this email, an OTP has been sent.'
    })
  } catch (error) {
    return res.status(500).json({ message: error.message })
  }
}

// =============================
// Vendor Reset Password
// =============================
exports.resetVendorPassword = async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase()
    const otp = String(req.body.otp || '').trim()
    const newPassword = String(req.body.newPassword || '')
    const confirmNewPassword = String(req.body.confirmNewPassword || '')

    if (!email || !otp || !newPassword || !confirmNewPassword) {
      return res.status(400).json({
        message:
          'email, otp, newPassword and confirmNewPassword are required'
      })
    }

    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({
        message: 'New password and confirm new password do not match'
      })
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        message: 'New password must be at least 8 characters long'
      })
    }

    const vendor = await Vendor.findOne({ email })

    if (!vendor) {
      return res.status(404).json({ message: 'Vendor not found' })
    }

    if (
      !vendor.passwordResetOtpHash ||
      !vendor.passwordResetExpiresAt ||
      vendor.passwordResetExpiresAt < new Date()
    ) {
      return res.status(400).json({
        message: 'OTP is invalid or expired'
      })
    }

    const isOtpValid =
      vendor.passwordResetOtpHash === hashResetOtp(otp)

    if (!isOtpValid) {
      vendor.passwordResetAttempts = (vendor.passwordResetAttempts || 0) + 1
      await vendor.save()
      return res.status(400).json({
        message: 'OTP is invalid or expired'
      })
    }

    const isSamePassword = await bcrypt.compare(newPassword, vendor.password)
    if (isSamePassword) {
      return res.status(400).json({
        message: 'New password must be different from current password'
      })
    }

    vendor.password = await bcrypt.hash(newPassword, 10)
    vendor.passwordResetOtpHash = null
    vendor.passwordResetExpiresAt = null
    vendor.passwordResetRequestedAt = null
    vendor.passwordResetAttempts = 0
    await vendor.save()

    return res.status(200).json({
      message: 'Password reset successful'
    })
  } catch (error) {
    return res.status(500).json({ message: error.message })
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
const VENDOR_VEHICLE_STATUS_VALUES = ['UNDER_APPROVAL', 'REJECTED', 'APPROVED', 'NOT_ADDED']

const parseBooleanQuery = (value) => {
  if (value === undefined) return undefined
  if (value === 'true' || value === true) return true
  if (value === 'false' || value === false) return false
  return undefined
}

const buildVendorDriverQuery = (vendorId, { vehiclePending, vehicleStatus }) => {
  const query = {}
  if (vendorId) {
    query.vendorId = vendorId
  }
  const pendingFlag = vehiclePending === true
  const status = typeof vehicleStatus === 'string' ? vehicleStatus.toUpperCase() : ''

  if (pendingFlag || status === 'UNDER_APPROVAL') {
    query['pendingVehicleInfo.approvalStatus'] = 'UNDER_APPROVAL'
    return query
  }
  if (status === 'REJECTED') {
    query['pendingVehicleInfo.approvalStatus'] = 'REJECTED'
    return query
  }
  if (status === 'APPROVED') {
    query.$or = [
      { vehicleInfo: { $exists: true, $ne: null } },
      { assignedFleetVehicleId: { $exists: true, $ne: null } }
    ]
    return query
  }
  if (status === 'NOT_ADDED') {
    query.$and = [
      { $or: [{ vehicleInfo: null }, { vehicleInfo: { $exists: false } }] },
      {
        $or: [
          { pendingVehicleInfo: null },
          { pendingVehicleInfo: { $exists: false } },
        ],
      },
    ]
  }
  return query
}

const buildAccessibleVendorDriverQuery = ({
  authenticatedVendorId,
  selfRegisteredOnly,
  targetVendorIds,
  vehiclePending,
  vehicleStatus
}) => {
  let baseQuery = {}

  if (selfRegisteredOnly) {
    baseQuery.vendorId = null
  } else if (Array.isArray(targetVendorIds)) {
    if (targetVendorIds.length === 0) {
      baseQuery._id = null
    } else {
      baseQuery.vendorId = { $in: targetVendorIds }
    }
  } else {
    baseQuery.$or = [{ vendorId: authenticatedVendorId }, { vendorId: null }]
  }

  const hasVehicleFilter =
    vehiclePending === true ||
    (vehicleStatus && VENDOR_VEHICLE_STATUS_VALUES.includes(vehicleStatus))

  if (!hasVehicleFilter) {
    return baseQuery
  }

  const vehicleQuery = buildVendorDriverQuery(null, {
    vehiclePending,
    vehicleStatus
  })

  if (Object.keys(baseQuery).length === 0) {
    return vehicleQuery
  }

  if (Object.keys(vehicleQuery).length === 0) {
    return baseQuery
  }

  return {
    $and: [baseQuery, vehicleQuery]
  }
}

exports.getVendorDrivers = async (req, res) => {
  try {
    const { vehiclePending, vehicleStatus, vendorName, selfRegistered } = req.query
    const authenticatedVendorId = req.user?.id
    const normalizedVendorName =
      typeof vendorName === 'string' ? vendorName.trim() : ''
    const vs = typeof vehicleStatus === 'string' ? vehicleStatus.toUpperCase() : ''
    const vehiclePendingTrue = parseBooleanQuery(vehiclePending) === true
    const selfRegisteredOnly = parseBooleanQuery(selfRegistered) === true
    let targetVendorIds

    if (normalizedVendorName && !selfRegisteredOnly) {
      const matchingVendors = await Vendor.find({
        businessName: { $regex: escapeRegex(normalizedVendorName), $options: 'i' }
      })
        .select('_id')
        .lean()

      targetVendorIds = matchingVendors.map(vendor => vendor._id)
    }

    const mongoQuery = buildAccessibleVendorDriverQuery({
      authenticatedVendorId,
      selfRegisteredOnly,
      targetVendorIds,
      vehiclePending: vehiclePendingTrue,
      vehicleStatus: vs
    })

    const drivers = await Driver.find(mongoQuery).populate(
      'assignedFleetVehicleId',
      'licensePlate make model year approvalStatus'
    ).populate('vendorId', 'businessName')

    res.json({
      total: drivers.length,
      drivers: drivers.map(driver => serializeDriverForResponse(driver, req))
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

// =============================
// Get single driver (vendor can view any driver)
// =============================
exports.getVendorDriverById = async (req, res) => {
  try {
    const { driverId } = req.params

    const driver = await Driver.findById(driverId)
      .select('-password')
      .populate('vendorId', 'businessName')
      .populate(
        'assignedFleetVehicleId',
        'make model year color licensePlate vehicleType approvalStatus rejectionReason allowDocumentResubmit'
      )
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' })
    }

    res.json(serializeDriverForResponse(driver, req))
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
    if (!driver.isVerified) {
      setDriverPendingApproval(driver)
    }
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
    if (!driver.isVerified) {
      setDriverPendingApproval(driver)
    }
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
    const { driverId } = req.body

    if (!driverId) {
      return res.status(400).json({
        message: 'driverId is required'
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

    const missingDocuments = getMissingDriverApprovalDocuments(driver)
    if (missingDocuments.length > 0) {
      return res.status(400).json({
        message: `Driver approval requires ${REQUIRED_DRIVER_APPROVAL_DOCUMENT_TYPES.join(', ')} compliance documents`,
        missingDocuments
      })
    }

    vendorApproveDriver(driver)

    await driver.save()

    res.json({
      success: true,
      message: 'Driver verified by vendor and forwarded to admin for final approval',
      driver: serializeDriverForResponse(driver, req)
    })
  } catch (error) {
    const statusCode = error.message.includes('pending vendor approval') ? 400 : 500
    res.status(statusCode).json({
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

    rejectDriverApproval(driver, DRIVER_APPROVAL_ACTOR.VENDOR, reason)

    await driver.save()

    res.json({
      success: true,
      message: 'Driver rejected successfully',
      driver: serializeDriverForResponse(driver, req)
    })
  } catch (error) {
    const statusCode = error.message.includes('pending vendor approval') ? 400 : 500
    res.status(statusCode).json({
      success: false,
      message: error.message
    })
  }
}

exports.approveDriverVehicle = async (req, res) => {
  try {
    const driver = await Driver.findOne({
      _id: req.params.driverId,
      vendorId: req.user.id
    })

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found or not under your vendor account'
      })
    }

    if (!driver.pendingVehicleInfo) {
      return res.status(400).json({
        success: false,
        message: 'No pending vehicle approval found'
      })
    }

    if (driver.pendingVehicleInfo.approvalRoutedTo !== 'VENDOR') {
      return res.status(403).json({
        success: false,
        message: 'This vehicle approval is routed to admin'
      })
    }

    driver.pendingVehicleInfo = {
      ...driver.pendingVehicleInfo.toObject(),
      approvalRoutedTo: 'ADMIN',
      approvalStatus: 'UNDER_APPROVAL',
      vendorPreApprovedAt: new Date()
    }
    await driver.save()

    logger.info('Vendor forwarded driver vehicle to admin', {
      vendorId: req.user.id,
      driverId: driver._id.toString()
    })

    return res.status(200).json({
      success: true,
      message: 'Vehicle forwarded to Cerca admin for final approval',
      ...serializeVehicleState(driver)
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

exports.assignDriverFleetVehicle = async (req, res) => {
  try {
    const vendorId = req.user.id
    const { driverId } = req.params
    const rawId = req.body?.fleetVehicleId

    const driver = await Driver.findOne({
      _id: driverId,
      vendorId
    })

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found or not under your vendor account'
      })
    }

    if (!driver.isVerified) {
      return res.status(400).json({
        success: false,
        message: 'Driver must be approved by admin before assigning a fleet vehicle'
      })
    }

    if (rawId === null || rawId === undefined || rawId === '') {
      let currentlyAssignedFleetVehicle = null
      if (driver.assignedFleetVehicleId) {
        currentlyAssignedFleetVehicle = await FleetVehicle.findOne({
          _id: driver.assignedFleetVehicleId,
          vendorId
        }).lean()
      }

      if (matchesVehicleSnapshot(driver.vehicleInfo, currentlyAssignedFleetVehicle)) {
        driver.vehicleInfo = null
      }

      driver.assignedFleetVehicleId = null
      await driver.save()
      logger.info('Fleet vehicle unassigned from driver', {
        vendorId,
        driverId: driver._id.toString()
      })
      return res.json({
        success: true,
        message: 'Fleet vehicle unassigned',
        driver: serializeDriverForResponse(driver, req)
      })
    }

    const fv = await FleetVehicle.findOne({
      _id: rawId,
      vendorId
    })

    if (!fv || fv.approvalStatus !== 'APPROVED') {
      return res.status(400).json({
        success: false,
        message: 'Fleet vehicle not found or not approved'
      })
    }

    driver.assignedFleetVehicleId = fv._id
    driver.vehicleInfo = buildDriverVehicleInfoFromFleetVehicle(fv)
    await driver.save()

    logger.info('Fleet vehicle assigned to driver', {
      vendorId,
      driverId: driver._id.toString(),
      fleetVehicleId: fv._id.toString()
    })

    return res.json({
      success: true,
      message: 'Fleet vehicle assigned to driver',
      driver: serializeDriverForResponse(driver, req)
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

exports.rejectDriverVehicle = async (req, res) => {
  try {
    const { reason } = req.body

    if (typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required'
      })
    }

    const driver = await Driver.findOne({
      _id: req.params.driverId,
      vendorId: req.user.id
    })

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found or not under your vendor account'
      })
    }

    if (!driver.pendingVehicleInfo) {
      return res.status(400).json({
        success: false,
        message: 'No pending vehicle approval found'
      })
    }

    if (driver.pendingVehicleInfo.approvalRoutedTo !== 'VENDOR') {
      return res.status(403).json({
        success: false,
        message: 'This vehicle approval is routed to admin'
      })
    }

    driver.pendingVehicleInfo = {
      ...driver.pendingVehicleInfo.toObject(),
      approvalStatus: 'REJECTED',
      rejectedAt: new Date(),
      approvedAt: null,
      rejectionReason: reason.trim()
    }
    await driver.save()

    return res.status(200).json({
      success: true,
      message: 'Driver vehicle rejected successfully',
      ...serializeVehicleState(driver)
    })
  } catch (error) {
    return res.status(500).json({
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

    const snapshot = await syncVendorFinancialFields(vendorId)
    const vendor = await Vendor.findById(vendorId)
      .select('businessName walletBalance totalEarnings totalDrivers totalRides')
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
        walletBalance: roundCurrency(vendor.walletBalance || 0),
        totalEarnings: roundCurrency(vendor.totalEarnings || 0),
        totalDrivers: vendor.totalDrivers || 0,
        totalRides: vendor.totalRides || 0
      },
      metrics: {
        totalDrivers,
        onlineDrivers,
        activeDrivers,
        verifiedDrivers,
        totalDriverEarnings: Math.round(totalDriverEarnings * 100) / 100,
        totalRideRejections: drivers.reduce((sum, driver) => sum + (driver.rideRejectionCount || 0), 0),
        availableBalance: snapshot.availableBalance || 0,
        paidOutAmount: snapshot.paidOutAmount || 0,
        pendingPayoutAmount: snapshot.pendingPayoutAmount || 0,
        processingPayoutAmount: snapshot.processingPayoutAmount || 0,
        eligibleEarningsCount: snapshot.eligibleEarningsCount || 0
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

exports.getVendorTotalRides = async (req, res) => {
  try {
    const vendorId = req.user.id

    await syncVendorFinancialFields(vendorId)

    const vendor = await Vendor.findById(vendorId)
      .select('businessName totalRides')
      .lean()

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor not found'
      })
    }

    return res.status(200).json({
      success: true,
      data: {
        vendorId: vendor._id,
        businessName: vendor.businessName || null,
        totalRides: vendor.totalRides || 0
      }
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

exports.getVendorEarningsReport = async (req, res) => {
  try {
    const vendorId = req.user.id
    const { startDate, endDate } = req.query

    const report = await getVendorEarningsReportData({
      vendorId,
      startDate,
      endDate
    })

    res.status(200).json({
      success: true,
      data: {
        vendor: {
          id: report.vendor?._id,
          businessName: report.vendor?.businessName || null,
          commissionType: report.vendor?.commissionType || null,
          commissionValue: report.vendor?.commissionValue || 0
        },
        filters: {
          startDate: startDate || null,
          endDate: endDate || null,
          paymentStatus: 'completed'
        },
        summary: report.summary,
        driverWiseEarnings: report.driverWiseEarnings,
        rideWiseRevenue: report.rideWiseRevenue
      }
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

exports.getVendorDriverWiseEarnings = async (req, res) => {
  try {
    const vendorId = req.user.id
    const { startDate, endDate } = req.query

    const report = await getVendorEarningsReportData({
      vendorId,
      startDate,
      endDate
    })

    return res.status(200).json({
      success: true,
      data: {
        vendor: {
          id: report.vendor?._id || null,
          businessName: report.vendor?.businessName || null
        },
        filters: {
          startDate: startDate || null,
          endDate: endDate || null,
          paymentStatus: 'completed'
        },
        summary: {
          totalDriverEarnings: report.summary.totalDriverEarnings,
          totalVendorCommission: report.summary.totalVendorCommission,
          rideCount: report.summary.rideCount
        },
        driverWiseEarnings: report.driverWiseEarnings
      }
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

exports.getVendorAvailableBalance = async (req, res) => {
  try {
    const vendorId = req.user.id
    const settings = await Settings.findOne().select('payoutConfigurations').lean()
    const snapshot = await syncVendorFinancialFields(vendorId)

    if (!snapshot.vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor not found'
      })
    }

    const minPayoutThreshold =
      settings?.payoutConfigurations?.minPayoutThreshold || 500

    return res.status(200).json({
      success: true,
      data: {
        availableBalance: snapshot.availableBalance,
        totalLifetimeEarnings: snapshot.totalCompletedCommission,
        paidOutAmount: snapshot.paidOutAmount,
        pendingPayoutAmount: snapshot.pendingPayoutAmount,
        processingPayoutAmount: snapshot.processingPayoutAmount,
        minPayoutThreshold,
        canRequestPayout: snapshot.availableBalance >= minPayoutThreshold,
        eligibleEarningsCount: snapshot.eligibleEarningsCount,
        completedEarningsCount: snapshot.completedEarningsCount
      }
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

exports.requestVendorPayout = async (req, res) => {
  try {
    const vendorId = req.user.id
    const { amount, notes } = req.body

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payout amount'
      })
    }

    const vendor = await Vendor.findById(vendorId).select('businessName bankAccount')
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor not found'
      })
    }

    if (
      !vendor.bankAccount?.accountNumber ||
      !vendor.bankAccount?.ifscCode ||
      !vendor.bankAccount?.accountHolderName ||
      !vendor.bankAccount?.bankName
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Vendor bank account details are required before requesting payout'
      })
    }

    const settings = await Settings.findOne().select('payoutConfigurations').lean()
    const minPayoutThreshold =
      settings?.payoutConfigurations?.minPayoutThreshold || 500

    const snapshot = await syncVendorFinancialFields(vendorId)
    const requestedAmount = roundCurrency(amount)

    if (requestedAmount > snapshot.availableBalance) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance for payout',
        data: {
          requested: requestedAmount,
          available: snapshot.availableBalance
        }
      })
    }

    if (requestedAmount < minPayoutThreshold) {
      return res.status(400).json({
        success: false,
        message: `Minimum payout amount is ₹${minPayoutThreshold}`
      })
    }

    const existingPayout = await VendorPayout.findOne({
      vendor: vendorId,
      status: { $in: ['PENDING', 'PROCESSING'] }
    })
    if (existingPayout) {
      return res.status(400).json({
        success: false,
        message:
          'You already have a pending payout request. Please wait for it to be processed.'
      })
    }

    let remainingAmount = requestedAmount
    const selectedEarnings = []
    const selectedEarningsDetails = []

    for (const row of snapshot.eligibleCommissionRows) {
      if (remainingAmount <= 0) break

      selectedEarnings.push(row.earningId)
      selectedEarningsDetails.push({
        earningId: row.earningId,
        rideId: row.rideId || null,
        driverId: row.driverId || null,
        driverEarning: row.driverEarning,
        vendorCommission: row.vendorCommission,
        rideDate: row.rideDate
      })
      remainingAmount = roundCurrency(remainingAmount - row.vendorCommission)
    }

    const selectedTotal = roundCurrency(
      selectedEarningsDetails.reduce(
        (sum, row) => sum + (row.vendorCommission || 0),
        0
      )
    )

    if (selectedTotal < requestedAmount) {
      return res.status(400).json({
        success: false,
        message: 'Selected earnings do not cover the requested payout amount',
        data: {
          requested: requestedAmount,
          selectedTotal
        }
      })
    }

    const payout = await VendorPayout.create({
      vendor: vendorId,
      amount: requestedAmount,
      bankAccount: vendor.bankAccount,
      status: 'PENDING',
      relatedEarnings: selectedEarnings,
      transactionReference: `VENDOR-PAYOUT-${Date.now()}-${vendorId
        .toString()
        .slice(-6)}`,
      notes,
      metadata: {
        vendorName: vendor.businessName || null,
        selectedEarnings: selectedEarningsDetails,
        requestedAgainstAvailableBalance: snapshot.availableBalance
      }
    })

    await syncVendorFinancialFields(vendorId)

    return res.status(200).json({
      success: true,
      message:
        'Vendor payout request submitted successfully. It will be processed within 1-3 business days.',
      data: {
        payout: {
          id: payout._id,
          amount: payout.amount,
          status: payout.status,
          transactionReference: payout.transactionReference,
          requestedAt: payout.requestedAt
        },
        earningsBreakdown: {
          selectedEarnings: selectedEarningsDetails,
          totalSelected: selectedTotal
        }
      }
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

exports.getVendorPayoutHistory = async (req, res) => {
  try {
    const vendorId = req.user.id
    const { page = 1, limit = 20, status } = req.query
    const query = { vendor: vendorId }
    if (status) query.status = status

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10)

    const [payouts, totalPayouts, allPayouts] = await Promise.all([
      VendorPayout.find(query)
        .populate('processedBy', 'fullName email')
        .sort({ requestedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      VendorPayout.countDocuments(query),
      VendorPayout.find({ vendor: vendorId }).lean()
    ])

    const totalPayoutAmount = roundCurrency(
      allPayouts
        .filter(payout => payout.status === 'COMPLETED')
        .reduce((sum, payout) => sum + (payout.amount || 0), 0)
    )
    const pendingPayouts = allPayouts.filter(
      payout => payout.status === 'PENDING' || payout.status === 'PROCESSING'
    )
    const pendingAmount = roundCurrency(
      pendingPayouts.reduce((sum, payout) => sum + (payout.amount || 0), 0)
    )

    return res.status(200).json({
      success: true,
      data: {
        payouts,
        pagination: {
          currentPage: parseInt(page, 10),
          totalPages: Math.ceil(totalPayouts / parseInt(limit, 10)),
          totalPayouts,
          limit: parseInt(limit, 10)
        },
        statistics: {
          totalPayoutAmount,
          totalPayouts: allPayouts.filter(payout => payout.status === 'COMPLETED')
            .length,
          pendingAmount,
          pendingCount: pendingPayouts.length
        }
      }
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

exports.getVendorPayoutById = async (req, res) => {
  try {
    const vendorId = req.user.id
    const { payoutId } = req.params

    const payout = await VendorPayout.findOne({
      _id: payoutId,
      vendor: vendorId
    })
      .populate('processedBy', 'fullName email')
      .populate('relatedEarnings')

    if (!payout) {
      return res.status(404).json({
        success: false,
        message: 'Vendor payout not found'
      })
    }

    return res.status(200).json({
      success: true,
      data: { payout }
    })
  } catch (error) {
    return res.status(500).json({
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
      isActive: false,
      approvalWorkflow: buildInitialApprovalWorkflow(vendorId)
    })

    // increment vendor's driver count
    await Vendor.findByIdAndUpdate(vendorId, { $inc: { totalDrivers: 1 } })

    res
      .status(201)
      .json({ success: true, message: 'Driver created under vendor', driver: serializeDriverForResponse(driver, req) })
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
// Get Single Driver Location (vendor can view any driver)
exports.getDriverLocationById = async (req, res) => {
  try {
    const { driverId } = req.params

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: 'Driver ID is required'
      })
    }

    const driver = await Driver.findById(driverId).select(
      'name phone isOnline location'
    )

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
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

// Get driver documents (vendor can view any driver)
exports.getDriverDocuments = async (req, res) => {
  try {
    const { driverId } = req.params

    if (!driverId) {
      return res
        .status(400)
        .json({ success: false, message: 'Driver ID is required' })
    }

    const driver = await Driver.findById(driverId).select('documents')
    if (!driver) {
      return res
        .status(404)
        .json({ success: false, message: 'Driver not found' })
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

function resolveBankVendorId(req) {
  if (req._bankSelfRoute) return String(req.user.id)
  const { vendorId } = req.params
  if (!assertVendorIdMatchesUser(vendorId, req.user.id)) {
    return null
  }
  return String(vendorId)
}

// JWT-scoped bank routes (preferred): /vendor/bank-account
exports.getVendorBankAccountSelf = async (req, res) => {
  req._bankSelfRoute = true
  return exports.getVendorBankAccount(req, res)
}
exports.addVendorBankAccountSelf = async (req, res) => {
  req._bankSelfRoute = true
  return exports.addVendorBankAccount(req, res)
}
exports.updateVendorBankAccountSelf = async (req, res) => {
  req._bankSelfRoute = true
  return exports.updateVendorBankAccount(req, res)
}
exports.deleteVendorBankAccountSelf = async (req, res) => {
  req._bankSelfRoute = true
  return exports.deleteVendorBankAccount(req, res)
}

// Add Vendor Bank Account Details
exports.addVendorBankAccount = async (req, res) => {
  try {
    const vendorId = resolveBankVendorId(req)
    if (vendorId == null) {
      return res.status(403).json({ success: false, message: 'Forbidden' })
    }

    const validated = validateBankFields({
      accountNumber: req.body.accountNumber,
      ifscCode: req.body.ifscCode,
      accountHolderName: req.body.accountHolderName,
      bankName: req.body.bankName,
      accountType: req.body.accountType
    })
    if (!validated.ok) {
      return res.status(400).json({ success: false, message: validated.message })
    }

    const vendor = await Vendor.findById(vendorId)
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' })
    }

    vendor.bankAccount = validated.value
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
    const vendorId = resolveBankVendorId(req)
    if (vendorId == null) {
      return res.status(403).json({ success: false, message: 'Forbidden' })
    }

    const vendor = await Vendor.findById(vendorId).select('bankAccount')
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' })
    }

    const ba = vendor.bankAccount
    const hasBank =
      ba &&
      ba.accountNumber &&
      ba.ifscCode &&
      ba.accountHolderName &&
      ba.bankName

    return res.status(200).json({
      success: true,
      data: { bankAccount: hasBank ? ba : null }
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

// Update Vendor Bank Account Details
exports.updateVendorBankAccount = async (req, res) => {
  try {
    const vendorId = resolveBankVendorId(req)
    if (vendorId == null) {
      return res.status(403).json({ success: false, message: 'Forbidden' })
    }

    const vendor = await Vendor.findById(vendorId)
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' })
    }

    const partial = pickBankUpdate(req.body)
    const merged = {
      accountNumber: partial.accountNumber ?? vendor.bankAccount?.accountNumber,
      ifscCode: partial.ifscCode ?? vendor.bankAccount?.ifscCode,
      accountHolderName: partial.accountHolderName ?? vendor.bankAccount?.accountHolderName,
      bankName: partial.bankName ?? vendor.bankAccount?.bankName,
      accountType: partial.accountType ?? vendor.bankAccount?.accountType ?? 'CURRENT'
    }

    const validated = validateBankFields(merged)
    if (!validated.ok) {
      return res.status(400).json({ success: false, message: validated.message })
    }

    vendor.bankAccount = validated.value
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
    const vendorId = resolveBankVendorId(req)
    if (vendorId == null) {
      return res.status(403).json({ success: false, message: 'Forbidden' })
    }

    const vendor = await Vendor.findById(vendorId)
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' })
    }

    vendor.set('bankAccount', undefined)
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
// First upload when no documents; re-upload when allowDocumentResubmit and not verified.
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
    if (vendor.isVerified) {
      return res.status(400).json({
        success: false,
        message: 'Vendor is already verified. Log in to manage documents.'
      })
    }

    const hasDocs = Array.isArray(vendor.documents) && vendor.documents.length > 0
    const canFirstUpload = !hasDocs
    const canResubmit = hasDocs && vendor.allowDocumentResubmit === true

    if (!canFirstUpload && !canResubmit) {
      return res.status(400).json({
        success: false,
        message: hasDocs
          ? 'Document re-upload is not enabled for this account. Contact Cerca if you were asked to resubmit.'
          : 'Vendor already has documents uploaded'
      })
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`
    const documentUrl = `${baseUrl}/uploads/vendorDocuments/${req.file.filename}`

    if (canResubmit) {
      vendor.documents = [documentUrl]
      vendor.rejectionReason = null
      vendor.allowDocumentResubmit = false
      vendor.vendorReviewStatus = 'PENDING'
    } else {
      vendor.documents = vendor.documents || []
      vendor.documents.push(documentUrl)
    }
    await vendor.save()

    return res.status(200).json({
      success: true,
      message: canResubmit
        ? 'Document resubmitted for verification.'
        : 'Document submitted for verification.',
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
