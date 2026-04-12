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
const { queueExternalAlertEmail } = require('../../utils/alerting.service')
const {
  notifyAdminsRegistrationEvent,
  notifyAdminsVendorPayoutRequested
} = require('../../utils/adminRegistrationNotify')
const { syncComplianceStatuses } = require('../../utils/compliance.service')
const {
  getFleetOnlineHoursSummary,
  stopDriverOnlineSession
} = require('../../utils/driverSession.service')
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
const {
  normalizeEmail,
  normalizeMobileDigits
} = require('../../utils/contactValidation')
const VendorPayout = mongoose.model('VendorPayout')

const roundCurrency = value => Math.round((Number(value) || 0) * 100) / 100

const DOCUMENT_TYPE_LABELS = {
  AADHAAR_CARD: 'Aadhaar Card',
  PAN_CARD: 'PAN Card',
  DRIVING_LICENSE: 'Driving License',
  GST_CERTIFICATE: 'GST Certificate',
  BUSINESS_LICENSE: 'Business License',
  PASSPORT: 'Passport',
  VOTER_ID: 'Voter ID',
  DOCUMENT: 'Document'
}

const normalizeDocumentTypeKey = value => String(value || '')
  .trim()
  .replace(/[^a-zA-Z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .toUpperCase()

const inferDocumentTypeFromName = value => {
  const normalized = String(value || '').toLowerCase()
  if (normalized.includes('aadhaar') || normalized.includes('aadhar')) return 'AADHAAR_CARD'
  if (normalized.includes('pan')) return 'PAN_CARD'
  if (normalized.includes('license') || normalized.includes('licence') || normalized.includes('dl')) return 'DRIVING_LICENSE'
  if (normalized.includes('gst')) return 'GST_CERTIFICATE'
  if (normalized.includes('business')) return 'BUSINESS_LICENSE'
  if (normalized.includes('passport')) return 'PASSPORT'
  if (normalized.includes('voter')) return 'VOTER_ID'
  return null
}

const getDocumentDisplayName = (documentType, url, fallbackIndex = 0) => {
  const normalizedType = normalizeDocumentTypeKey(documentType)
  if (normalizedType && DOCUMENT_TYPE_LABELS[normalizedType]) {
    return DOCUMENT_TYPE_LABELS[normalizedType]
  }

  const inferredType = inferDocumentTypeFromName(documentType || url)
  if (inferredType && DOCUMENT_TYPE_LABELS[inferredType]) {
    return DOCUMENT_TYPE_LABELS[inferredType]
  }

  return `Document ${fallbackIndex + 1}`
}

const buildUploadedDocumentEntry = (req, file, explicitType = null) => ({
  documentType: normalizeDocumentTypeKey(
    explicitType || inferDocumentTypeFromName(file?.originalname) || 'DOCUMENT'
  ),
  documentUrl: `${req.protocol}://${req.get('host')}/uploads/vendorDocuments/${file.filename}`
})

const normalizeStoredDocumentEntry = (req, document, index = 0) => {
  const rawDocument = typeof document === 'string'
    ? { documentType: inferDocumentTypeFromName(document), documentUrl: document }
    : document || {}
  const rawUrl = String(rawDocument.documentUrl || rawDocument.url || '').trim()
  const baseUrl = `${req.protocol}://${req.get('host')}`
  let documentUrl = rawUrl

  if (rawUrl && !/^https?:\/\//i.test(rawUrl)) {
    const path = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`
    documentUrl = `${baseUrl}${path}`
  }

  const documentType = normalizeDocumentTypeKey(
    rawDocument.documentType || inferDocumentTypeFromName(rawUrl)
  )

  return {
    documentType: documentType || null,
    documentName: getDocumentDisplayName(documentType, rawUrl, index),
    documentUrl
  }
}

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

const buildVehicleSummaryKey = snapshot => {
  if (!snapshot) return 'UNKNOWN_VEHICLE'
  if (snapshot.licensePlate) return `LICENSE:${String(snapshot.licensePlate).toUpperCase()}`
  const fallbackKeyParts = [
    snapshot.make || 'UNKNOWN',
    snapshot.model || 'UNKNOWN',
    snapshot.year || 'NA',
    snapshot.vehicleType || 'UNKNOWN'
  ]
  return `VEHICLE:${fallbackKeyParts.join('|').toUpperCase()}`
}

const buildVehicleSnapshotFallback = driver => {
  const activeVehicle = getActiveDriverVehicleRecord(driver)
  if (activeVehicle) {
    return {
      licensePlate: activeVehicle.licensePlate || null,
      make: activeVehicle.make || null,
      model: activeVehicle.model || null,
      year: activeVehicle.year || null,
      color: activeVehicle.color || null,
      vehicleType: activeVehicle.vehicleType || null,
      source: 'SELF_OWNED'
    }
  }

  const approvedVehicle = driver?.vehicleInfo || null
  if (approvedVehicle) {
    return {
      licensePlate: approvedVehicle.licensePlate || null,
      make: approvedVehicle.make || null,
      model: approvedVehicle.model || null,
      year: approvedVehicle.year || null,
      color: approvedVehicle.color || null,
      vehicleType: approvedVehicle.vehicleType || null,
      source: driver?.assignedFleetVehicleId ? 'FLEET_ASSIGNED' : 'SELF_OWNED'
    }
  }

  const assignedFleetVehicle = driver?.assignedFleetVehicleId
  if (assignedFleetVehicle && typeof assignedFleetVehicle === 'object') {
    return {
      licensePlate: assignedFleetVehicle.licensePlate || null,
      make: assignedFleetVehicle.make || null,
      model: assignedFleetVehicle.model || null,
      year: assignedFleetVehicle.year || null,
      color: assignedFleetVehicle.color || null,
      vehicleType: assignedFleetVehicle.vehicleType || null,
      source: 'FLEET_ASSIGNED'
    }
  }

  return {
    licensePlate: null,
    make: null,
    model: null,
    year: null,
    color: null,
    vehicleType: null,
    source: 'UNKNOWN'
  }
}

const {
  clampRideLimit,
  clampRidePage,
  parseRideSort,
  sortRideWiseRows,
  paginateRideRows,
  normalizeLicensePlateFilter,
  dateRangeWarning,
  buildEarningsCsv,
  MAX_CSV_RIDE_ROWS
} = require('../../utils/vendorEarningsReport.util')

const resolveVehicleContextForEarning = (entry, driverDoc) => {
  const hasStoredSnapshot =
    entry.vehicleSnapshot &&
    (entry.vehicleSnapshot.licensePlate ||
      entry.vehicleSnapshot.make ||
      entry.vehicleSnapshot.model)
  const snapshot = hasStoredSnapshot
    ? { ...entry.vehicleSnapshot }
    : buildVehicleSnapshotFallback(driverDoc || {})
  const vehicleKey = buildVehicleSummaryKey(snapshot)
  return {
    vehicleKey,
    snapshot,
    vehicle: {
      vehicleKey,
      licensePlate: snapshot.licensePlate || null,
      make: snapshot.make || null,
      model: snapshot.model || null,
      year: snapshot.year ?? null,
      color: snapshot.color || null,
      vehicleType: snapshot.vehicleType || null,
      vehicleSource: snapshot.source || 'UNKNOWN'
    }
  }
}

const buildVendorDriverRevenueMetrics = ({ driver, earnings = [], vendor }) => {
  const vehicleMap = new Map()

  for (const earning of earnings) {
    const snapshot = earning.vehicleSnapshot?.licensePlate ||
      earning.vehicleSnapshot?.make ||
      earning.vehicleSnapshot?.model
      ? earning.vehicleSnapshot
      : buildVehicleSnapshotFallback(driver)

    const key = buildVehicleSummaryKey(snapshot)
    if (!vehicleMap.has(key)) {
      vehicleMap.set(key, {
        vehicleKey: key,
        licensePlate: snapshot.licensePlate || null,
        make: snapshot.make || null,
        model: snapshot.model || null,
        year: snapshot.year || null,
        color: snapshot.color || null,
        vehicleType: snapshot.vehicleType || null,
        vehicleSource: snapshot.source || 'UNKNOWN',
        rideCount: 0,
        grossRevenue: 0,
        driverEarning: 0,
        vehicleProfit: 0
      })
    }

    const current = vehicleMap.get(key)
    const driverEarning = Number(earning.driverEarning) || 0
    current.rideCount += 1
    current.grossRevenue += Number(earning.grossFare) || 0
    current.driverEarning += driverEarning
    const fine = Number(earning.vendorFineCredit) || 0
    current.vehicleProfit +=
      calculateVendorCommission(vendor, driverEarning) + fine
  }

  const totalDriverEarnings = earnings.reduce(
    (sum, earning) => sum + (Number(earning.driverEarning) || 0),
    0
  )
  const totalVehicleProfit = earnings.reduce(
    (sum, earning) =>
      sum +
      calculateVendorCommission(vendor, earning.driverEarning) +
      (Number(earning.vendorFineCredit) || 0),
    0
  )

  return {
    earningsSummary: {
      totalDriverEarnings: roundCurrency(totalDriverEarnings),
      totalVehicleProfit: roundCurrency(totalVehicleProfit),
      totalRides: earnings.length
    },
    vehicleProfitBreakdown: Array.from(vehicleMap.values()).map(item => ({
      ...item,
      grossRevenue: roundCurrency(item.grossRevenue),
      driverEarning: roundCurrency(item.driverEarning),
      vehicleProfit: roundCurrency(item.vehicleProfit)
    }))
  }
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

const getVendorEarningsReportData = async ({
  vendorId,
  startDate,
  endDate,
  filterDriverId = null,
  filterVehicleKey = null,
  filterLicensePlate = null,
  ridePage: ridePageRaw,
  rideLimit: rideLimitRaw,
  rideSort: rideSortRaw,
  rideOrder: rideOrderRaw
}) => {
  const { vendor, driverIds: baseDriverIds } = await getVendorBaseContext(vendorId)

  const ridePage = clampRidePage(ridePageRaw)
  const rideLimit = clampRideLimit(rideLimitRaw)
  const { rideSort, rideOrder } = parseRideSort(rideSortRaw, rideOrderRaw)

  const empty = {
    vendor,
    summary: {
      totalGrossRevenue: 0,
      totalDriverEarnings: 0,
      totalVendorCommission: 0,
      totalCancellationFines: 0,
      totalVendorProfit: 0,
      totalPlatformFee: 0,
      rideCount: 0
    },
    driverWiseEarnings: [],
    vehicleWiseEarnings: [],
    rideWiseRevenue: [],
    rideWiseTotalCount: 0,
    ridePagination: {
      page: ridePage,
      limit: rideLimit,
      totalPages: 0,
      sort: rideSort,
      order: rideOrder
    },
    meta: {
      dateRangeWarning: dateRangeWarning(startDate, endDate),
      csvTruncated: false,
      csvRowCount: 0
    }
  }

  if (!vendor || baseDriverIds.length === 0) {
    return { ...empty, _allRidesSorted: [] }
  }

  let driverIds = baseDriverIds
  if (filterDriverId) {
    const fid = String(filterDriverId)
    if (!mongoose.isValidObjectId(fid)) {
      return {
        ...empty,
        _allRidesSorted: [],
        meta: { ...empty.meta, invalidDriverFilter: true }
      }
    }
    const allowed = baseDriverIds.some(id => String(id) === fid)
    if (!allowed) {
      return {
        ...empty,
        _allRidesSorted: [],
        meta: { ...empty.meta, invalidDriverFilter: true }
      }
    }
    driverIds = [new mongoose.Types.ObjectId(fid)]
  }

  const mongoFilter = buildVendorEarningsFilter({
    driverIds,
    startDate,
    endDate
  })

  const earnings = await AdminEarnings.find(mongoFilter)
    .populate('rideId', 'pickupAddress dropoffAddress fare createdAt paymentMethod')
    .populate({
      path: 'driverId',
      select:
        'name phone email vehicles vehicleInfo assignedFleetVehicleId pendingVehicleInfo',
      populate: {
        path: 'assignedFleetVehicleId',
        select: 'licensePlate make model year color vehicleType approvalStatus'
      }
    })
    .sort({ rideDate: -1 })
    .lean()

  const normPlate = normalizeLicensePlateFilter(filterLicensePlate)
  const vKey =
    typeof filterVehicleKey === 'string' && filterVehicleKey.trim()
      ? filterVehicleKey.trim()
      : null

  const rideWiseFull = []

  for (const entry of earnings) {
    const driverDoc = entry.driverId
    const { vehicleKey, vehicle } = resolveVehicleContextForEarning(entry, driverDoc)

    if (vKey && vehicleKey !== vKey) continue
    if (normPlate) {
      const p = String(vehicle.licensePlate || '')
        .replace(/\s+/g, '')
        .toUpperCase()
      if (p !== normPlate) continue
    }

    const vendorCommission = calculateVendorCommission(vendor, entry.driverEarning)
    const cancellationFineCredit = roundCurrency(entry.vendorFineCredit || 0)
    const vendorProfit = roundCurrency(vendorCommission + cancellationFineCredit)

    rideWiseFull.push({
      earningId: entry._id,
      rideId: entry.rideId?._id || null,
      rideDate: entry.rideDate,
      driver: driverDoc
        ? {
            id: driverDoc._id,
            name: driverDoc.name,
            phone: driverDoc.phone,
            email: driverDoc.email || null
          }
        : null,
      vehicle,
      pickupAddress: entry.rideId?.pickupAddress || null,
      dropoffAddress: entry.rideId?.dropoffAddress || null,
      grossRevenue: roundCurrency(entry.grossFare),
      platformFee: roundCurrency(entry.platformFee),
      driverEarning: roundCurrency(entry.driverEarning),
      vendorCommission,
      cancellationFineCredit,
      vendorProfit,
      settlementType: entry.settlementType || 'completed',
      paymentStatus: entry.paymentStatus,
      paymentMethod: entry.rideId?.paymentMethod || null
    })
  }

  const driverWiseMap = new Map()
  for (const row of rideWiseFull) {
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
    current.vendorCommission += row.vendorProfit || row.vendorCommission || 0
  }

  const driverWiseEarnings = Array.from(driverWiseMap.values()).map(item => ({
    ...item,
    grossRevenue: roundCurrency(item.grossRevenue),
    driverEarning: roundCurrency(item.driverEarning),
    vendorCommission: roundCurrency(item.vendorCommission)
  }))

  const vehicleWiseMap = new Map()
  for (const row of rideWiseFull) {
    const vk = row.vehicle?.vehicleKey || 'UNKNOWN_VEHICLE'
    if (!vehicleWiseMap.has(vk)) {
      vehicleWiseMap.set(vk, {
        vehicleKey: vk,
        licensePlate: row.vehicle?.licensePlate || null,
        make: row.vehicle?.make || null,
        model: row.vehicle?.model || null,
        year: row.vehicle?.year ?? null,
        vehicleType: row.vehicle?.vehicleType || null,
        vehicleSource: row.vehicle?.vehicleSource || 'UNKNOWN',
        rideCount: 0,
        grossRevenue: 0,
        driverEarning: 0,
        baseVendorCommission: 0,
        cancellationFines: 0,
        vendorProfit: 0
      })
    }
    const v = vehicleWiseMap.get(vk)
    v.rideCount += 1
    v.grossRevenue += row.grossRevenue || 0
    v.driverEarning += row.driverEarning || 0
    v.baseVendorCommission += row.vendorCommission || 0
    v.cancellationFines += row.cancellationFineCredit || 0
    v.vendorProfit += row.vendorProfit || 0
  }

  const vehicleWiseEarnings = Array.from(vehicleWiseMap.values()).map(item => ({
    vehicleKey: item.vehicleKey,
    licensePlate: item.licensePlate,
    make: item.make,
    model: item.model,
    year: item.year,
    vehicleType: item.vehicleType,
    vehicleSource: item.vehicleSource,
    rideCount: item.rideCount,
    grossRevenue: roundCurrency(item.grossRevenue),
    driverEarning: roundCurrency(item.driverEarning),
    vendorCommission: roundCurrency(item.baseVendorCommission),
    cancellationFines: roundCurrency(item.cancellationFines),
    vendorProfit: roundCurrency(item.vendorProfit)
  }))

  const summary = rideWiseFull.reduce(
    (acc, row) => {
      acc.totalGrossRevenue += row.grossRevenue || 0
      acc.totalDriverEarnings += row.driverEarning || 0
      acc.totalVendorCommission += row.vendorCommission || 0
      acc.totalCancellationFines += row.cancellationFineCredit || 0
      acc.totalVendorProfit += row.vendorProfit || 0
      acc.totalPlatformFee += row.platformFee || 0
      acc.rideCount += 1
      return acc
    },
    {
      totalGrossRevenue: 0,
      totalDriverEarnings: 0,
      totalVendorCommission: 0,
      totalCancellationFines: 0,
      totalVendorProfit: 0,
      totalPlatformFee: 0,
      rideCount: 0
    }
  )

  const sortedRides = sortRideWiseRows(rideWiseFull, rideSort, rideOrder)
  const { slice, total } = paginateRideRows(sortedRides, ridePage, rideLimit)
  const totalPages = total === 0 ? 0 : Math.ceil(total / rideLimit)

  return {
    vendor,
    summary: {
      totalGrossRevenue: roundCurrency(summary.totalGrossRevenue),
      totalDriverEarnings: roundCurrency(summary.totalDriverEarnings),
      totalVendorCommission: roundCurrency(summary.totalVendorCommission),
      totalCancellationFines: roundCurrency(summary.totalCancellationFines),
      totalVendorProfit: roundCurrency(summary.totalVendorProfit),
      totalPlatformFee: roundCurrency(summary.totalPlatformFee),
      rideCount: summary.rideCount
    },
    driverWiseEarnings,
    vehicleWiseEarnings,
    rideWiseRevenue: slice,
    rideWiseTotalCount: total,
    ridePagination: {
      page: ridePage,
      limit: rideLimit,
      totalPages,
      sort: rideSort,
      order: rideOrder
    },
    meta: {
      dateRangeWarning: dateRangeWarning(startDate, endDate),
      csvTruncated: false,
      csvRowCount: 0
    },
    _allRidesSorted: sortedRides
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
      .select(
        'driverId rideId driverEarning grossFare platformFee rideDate vendorFineCredit settlementType'
      )
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

  const completedCommissionRows = completedEarnings.map(earning => {
    const vendorCommission = calculateVendorCommission(
      vendor,
      earning.driverEarning
    )
    const vendorFineCredit = roundCurrency(earning.vendorFineCredit || 0)
    return {
      earningId: earning._id?.toString(),
      rideId: earning.rideId || null,
      driverId: earning.driverId || null,
      driverEarning: roundCurrency(earning.driverEarning),
      vendorCommission,
      vendorFineCredit,
      totalVendorCredit: roundCurrency(vendorCommission + vendorFineCredit),
      rideDate: earning.rideDate
    }
  })

  const eligibleCommissionRows = completedCommissionRows.filter(
    row => row.earningId && !reservedEarningIds.has(row.earningId)
  )

  const totalCompletedCommission = roundCurrency(
    completedCommissionRows.reduce(
      (sum, row) => sum + (row.totalVendorCredit || 0),
      0
    )
  )
  const availableBalance = roundCurrency(
    eligibleCommissionRows.reduce(
      (sum, row) => sum + (row.totalVendorCredit || 0),
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

exports.syncVendorFinancialFields = syncVendorFinancialFields

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

const toPlainDriverVehicleRecord = vehicle =>
  vehicle?.toObject ? vehicle.toObject() : vehicle

const getDriverVehicleRecords = driver =>
  Array.isArray(driver?.vehicles) ? driver.vehicles : []

const getLatestDriverVehicleRecord = (driver, predicate) => {
  const vehicles = getDriverVehicleRecords(driver)
  for (let index = vehicles.length - 1; index >= 0; index -= 1) {
    if (predicate(vehicles[index])) {
      return vehicles[index]
    }
  }
  return null
}

const getPendingDriverVehicleRecord = driver => {
  const sourceVehicleId = driver?.pendingVehicleInfo?.sourceVehicleId
    ? String(driver.pendingVehicleInfo.sourceVehicleId)
    : null

  if (sourceVehicleId) {
    const matchingVehicle = getDriverVehicleRecords(driver).find(
      vehicle => String(vehicle._id) === sourceVehicleId
    )
    if (matchingVehicle) {
      return matchingVehicle
    }
  }

  return getLatestDriverVehicleRecord(
    driver,
    vehicle => vehicle.approvalStatus === 'UNDER_APPROVAL' || vehicle.approvalStatus === 'REJECTED'
  )
}

const getActiveDriverVehicleRecord = driver => {
  const activeVehicle = getLatestDriverVehicleRecord(
    driver,
    vehicle => vehicle.approvalStatus === 'APPROVED' && vehicle.isActive
  )

  if (activeVehicle) {
    return activeVehicle
  }

  return getLatestDriverVehicleRecord(
    driver,
    vehicle => vehicle.approvalStatus === 'APPROVED'
  )
}

const buildLegacyVehicleInfoFromRecord = vehicle => {
  if (!vehicle) return null

  return {
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    color: vehicle.color,
    licensePlate: vehicle.licensePlate,
    vehicleType: vehicle.vehicleType
  }
}

const buildLegacyPendingVehicleFromRecord = vehicle => {
  if (!vehicle) return null

  return {
    ...toPlainDriverVehicleRecord(vehicle),
    sourceVehicleId: vehicle._id
  }
}

const syncDriverLegacyVehicleState = driver => {
  const activeVehicle = getActiveDriverVehicleRecord(driver)
  const pendingVehicle = getPendingDriverVehicleRecord(driver)

  if (!driver.assignedFleetVehicleId) {
    driver.vehicleInfo = buildLegacyVehicleInfoFromRecord(activeVehicle)
  }
  driver.pendingVehicleInfo = buildLegacyPendingVehicleFromRecord(pendingVehicle)

  return driver
}

const serializeVehicleState = (driver) => ({
  approvedVehicle: driver.vehicleInfo || driver.assignedFleetVehicleId || null,
  pendingVehicle: driver.pendingVehicleInfo || null,
  vehicleStatus: resolveDriverVehicleStatus(driver),
  vehicles: getDriverVehicleRecords(driver).map(vehicle => toPlainDriverVehicleRecord(vehicle))
})

const hasDriverVehicleState = driver =>
  Boolean(
    driver?.vehicleInfo ||
    driver?.pendingVehicleInfo ||
    driver?.assignedFleetVehicleId ||
    (Array.isArray(driver?.vehicles) && driver.vehicles.length > 0)
  )

const toObjectIdString = value => (value ? String(value) : null)

const clearDriverVehicleState = driver => {
  const vehicles = getDriverVehicleRecords(driver)
  const pendingVehicle = getPendingDriverVehicleRecord(driver)
  const activeVehicle = getActiveDriverVehicleRecord(driver)
  const targetVehicle = pendingVehicle || activeVehicle
  const removed = {
    approvedVehicle: Boolean(activeVehicle || driver.vehicleInfo),
    pendingVehicle: Boolean(pendingVehicle || driver.pendingVehicleInfo),
    assignedFleetVehicle: Boolean(driver.assignedFleetVehicleId)
  }

  if (targetVehicle) {
    driver.vehicles = vehicles.filter(
      vehicle => String(vehicle._id) !== String(targetVehicle._id)
    )
  }

  const fallbackApprovedVehicle = getLatestDriverVehicleRecord(
    driver,
    vehicle => vehicle.approvalStatus === 'APPROVED'
  )
  getDriverVehicleRecords(driver).forEach(vehicle => {
    vehicle.isActive =
      Boolean(fallbackApprovedVehicle) &&
      String(vehicle._id) === String(fallbackApprovedVehicle._id)
  })

  syncDriverLegacyVehicleState(driver)
  driver.assignedFleetVehicleId = null

  return removed
}

/**
 * Clears vendor fleet car assignment from driver so the FleetVehicle can be reused.
 * Only affects fleet assigned by this vendor (matches assignDriverFleetVehicle null-branch).
 */
const detachVendorFleetFromDriver = async (driver, vendorId) => {
  if (!driver?.assignedFleetVehicleId) return
  const fv = await FleetVehicle.findById(driver.assignedFleetVehicleId).lean()
  if (!fv || String(fv.vendorId) !== String(vendorId)) return

  const currentlyAssignedFleetVehicle = await FleetVehicle.findOne({
    _id: driver.assignedFleetVehicleId,
    vendorId
  }).lean()

  if (matchesVehicleSnapshot(driver.vehicleInfo, currentlyAssignedFleetVehicle)) {
    driver.vehicleInfo = null
  }

  driver.assignedFleetVehicleId = null
  const fallbackApprovedVehicle = getLatestDriverVehicleRecord(
    driver,
    vehicle => vehicle.approvalStatus === 'APPROVED'
  )
  getDriverVehicleRecords(driver).forEach(vehicle => {
    vehicle.isActive =
      Boolean(fallbackApprovedVehicle) &&
      String(vehicle._id) === String(fallbackApprovedVehicle._id)
  })
  syncDriverLegacyVehicleState(driver)
}

const getDriverVehicleOwnershipContext = async driver => {
  const driverVendorId = toObjectIdString(driver?.vendorId)
  let fleetVehicleVendorId = null

  if (driver?.assignedFleetVehicleId) {
    const assignedFleetVehicle = await FleetVehicle.findById(driver.assignedFleetVehicleId)
      .select('vendorId')
      .lean()
    fleetVehicleVendorId = toObjectIdString(assignedFleetVehicle?.vendorId)
  }

  return {
    driverVendorId,
    fleetVehicleVendorId,
    owningVendorId: fleetVehicleVendorId || driverVendorId,
    hasVehicleState: hasDriverVehicleState(driver)
  }
}

const buildVehicleRemovalRequiredMessage = ({
  hasVehicleState,
  owningVendorId,
  requestingVendorId
}) => {
  if (!hasVehicleState) return null

  if (!owningVendorId) {
    return 'Please ask the driver to remove their self-registered vehicle first.'
  }

  if (owningVendorId !== requestingVendorId) {
    return 'Please remove your vehicle from the previous vendor first.'
  }

  return "Please remove the driver's existing vehicle first."
}

/** Standalone driver (no vendor) who may be linked without clearing personal vehicles. */
const isEligibleStandaloneDriverForVendorLink = driver => {
  if (!driver) return false
  const vid = driver.vendorId
  if (vid != null && String(vid).trim() !== '') return false
  if (driver.isVerified !== true) return false
  if (getMissingDriverApprovalDocuments(driver).length > 0) return false
  if (driver.assignedFleetVehicleId) return false
  return true
}

async function assertNoActiveRideForVendorLink (driverId) {
  const activeRide = await Ride.findOne({
    driver: driverId,
    status: { $in: ['requested', 'accepted', 'arrived', 'in_progress'] }
  })
    .select('_id')
    .lean()
  if (activeRide) {
    const err = new Error(
      'Driver has an active ride. Finish or cancel the ride before linking to a vendor.'
    )
    err.statusCode = 409
    throw err
  }
}

/**
 * Force offline if needed; re-fetch driver. Throws on active ride.
 */
async function prepareDriverForVendorLinkSession (driverId) {
  let driver = await Driver.findById(driverId)
  if (!driver) {
    const err = new Error('Driver not found')
    err.statusCode = 404
    throw err
  }
  await assertNoActiveRideForVendorLink(driver._id)
  if (driver.isOnline) {
    await stopDriverOnlineSession(driver._id, 'vendor_link')
    driver = await Driver.findById(driverId)
    if (!driver) {
      const err = new Error('Driver not found')
      err.statusCode = 404
      throw err
    }
  }
  return driver
}

async function queueAdminNotifyDriverLinkedVendor (driver, vendorId) {
  try {
    const v = await Vendor.findById(vendorId).select('businessName').lean()
    const businessName = v?.businessName || 'Vendor'
    setImmediate(() => {
      notifyAdminsRegistrationEvent({
        type: 'admin_driver_linked_vendor',
        title: 'Driver linked to vendor',
        message: `${driver.name} (${driver.phone}) linked to ${businessName}.`,
        entityKind: 'driver',
        entityId: driver._id,
        data: {
          driverName: driver.name,
          phone: driver.phone,
          vendorId: String(vendorId),
          businessName
        }
      }).catch(e =>
        logger.error('admin notify driver linked vendor:', e)
      )
    })
  } catch (e) {
    logger.error('queueAdminNotifyDriverLinkedVendor:', e)
  }
}

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
    vehicles: getDriverVehicleRecords(driver).map(vehicle =>
      normalizeVehicleDocuments(toPlainDriverVehicleRecord(vehicle), req)
    ),
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
/** Min time between OTP emails for the same vendor when current OTP is still valid */
const VENDOR_RESET_COOLDOWN_MS = 90 * 1000
/** Wrong OTP attempts before invalidating the reset session */
const VENDOR_RESET_MAX_OTP_ATTEMPTS = 5

const generateVendorResetOtp = () =>
  crypto.randomInt(100000, 1000000).toString()

const hashResetOtp = otp =>
  crypto.createHash('sha256').update(String(otp)).digest('hex')

// =============================
// 1. Register Vendor
// =============================
exports.registerVendor = async (req, res) => {
  try {
    const { businessName, ownerName, password, address } =
      req.body
    const normalizedEmail = normalizeEmail(req.body.email)
    if (normalizedEmail.error) {
      return res.status(400).json({ message: normalizedEmail.error })
    }
    const normalizedPhone = normalizeMobileDigits(req.body.phone)
    if (normalizedPhone.error || !normalizedPhone.value) {
      return res.status(400).json({ message: normalizedPhone.error || 'Phone number is required' })
    }
    const email = normalizedEmail.value
    const phone = normalizedPhone.value

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
      isActive: false, // becomes active only after admin approval
      vendorReviewStatus: 'PENDING'
    })

    setImmediate(() => {
      notifyAdminsRegistrationEvent({
        type: 'admin_new_vendor',
        title: 'New vendor registered',
        message: `${businessName} (${email}) registered and awaits admin approval.`,
        entityKind: 'vendor',
        entityId: vendor._id,
        data: { businessName, ownerName, email },
      }).catch((e) => logger.error('admin registration notify (vendor register):', e))
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
    const { password } = req.body
    const normalizedEmail = normalizeEmail(req.body.email)
    if (normalizedEmail.error || !normalizedEmail.value) {
      return res.status(400).json({ message: normalizedEmail.error || 'Email is required' })
    }
    const email = normalizedEmail.value

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

    if (!vendor.isActive) {
      return res.status(403).json({
        message: 'Vendor account is inactive',
        code: 'VENDOR_INACTIVE'
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
    const emailResult = normalizeEmail(req.body.email)
    if (emailResult.error) {
      return res.status(400).json({ message: emailResult.error })
    }
    const email = String(emailResult.value || '')

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

    const now = Date.now()
    const requestedAt = vendor.passwordResetRequestedAt
      ? new Date(vendor.passwordResetRequestedAt).getTime()
      : 0
    const expiresAt = vendor.passwordResetExpiresAt
      ? new Date(vendor.passwordResetExpiresAt).getTime()
      : 0
    const hasValidOtp =
      Boolean(vendor.passwordResetOtpHash) && expiresAt > now
    if (
      hasValidOtp &&
      requestedAt > 0 &&
      now - requestedAt < VENDOR_RESET_COOLDOWN_MS
    ) {
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

    try {
      await queueExternalAlertEmail({
        channel: 'email',
        to: vendor.email,
        subject: 'Vendor password reset OTP',
        message: `Your vendor password reset OTP is ${otp}. It expires in ${VENDOR_RESET_OTP_EXPIRY_MINUTES} minutes.`,
        metadata: {
          vendorId: vendor._id.toString(),
          purpose: 'vendor_password_reset'
        }
      })
    } catch (sendErr) {
      logger.error(
        `Vendor password reset email queue error for ${vendor.email}: ${sendErr.message}`
      )
    }

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
    const emailResult = normalizeEmail(req.body.email)
    if (emailResult.error) {
      return res.status(400).json({ message: emailResult.error })
    }
    const email = String(emailResult.value || '')
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

    if ((vendor.passwordResetAttempts || 0) >= VENDOR_RESET_MAX_OTP_ATTEMPTS) {
      vendor.passwordResetOtpHash = null
      vendor.passwordResetExpiresAt = null
      await vendor.save()
      return res.status(400).json({
        message: 'OTP is invalid or expired'
      })
    }

    const isOtpValid =
      vendor.passwordResetOtpHash === hashResetOtp(otp)

    if (!isOtpValid) {
      vendor.passwordResetAttempts = (vendor.passwordResetAttempts || 0) + 1
      if (vendor.passwordResetAttempts >= VENDOR_RESET_MAX_OTP_ATTEMPTS) {
        vendor.passwordResetOtpHash = null
        vendor.passwordResetExpiresAt = null
      }
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
  vehicleStatus,
  vendorDriverCategory
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
    baseQuery.vendorId = authenticatedVendorId
  }

  if (vendorDriverCategory && ['OWN', 'OTHER', 'SELF'].includes(vendorDriverCategory)) {
    baseQuery.vendorDriverCategory = vendorDriverCategory
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
    const { vehiclePending, vehicleStatus, vendorName, selfRegistered, vendorDriverCategory } = req.query
    const authenticatedVendorId = req.user?.id
    const normalizedVendorName =
      typeof vendorName === 'string' ? vendorName.trim() : ''
    const vs = typeof vehicleStatus === 'string' ? vehicleStatus.toUpperCase() : ''
    const vehiclePendingTrue = parseBooleanQuery(vehiclePending) === true
    const selfRegisteredOnly = parseBooleanQuery(selfRegistered) === true
    const categoryFilter =
      typeof vendorDriverCategory === 'string'
        ? vendorDriverCategory.toUpperCase()
        : ''
    const validCategory =
      categoryFilter && ['OWN', 'OTHER', 'SELF'].includes(categoryFilter)
        ? categoryFilter
        : undefined
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
      vehicleStatus: vs,
      vendorDriverCategory: validCategory
    })

    const drivers = await Driver.find(mongoQuery).populate(
      'assignedFleetVehicleId',
      'licensePlate make model year approvalStatus'
    ).populate('vendorId', 'businessName')

    const vendor = authenticatedVendorId
      ? await Vendor.findById(authenticatedVendorId)
          .select('commissionType commissionValue')
          .lean()
      : null

    const driverIds = drivers.map(driver => driver._id)
    const earnings = driverIds.length
      ? await AdminEarnings.find({
          driverId: { $in: driverIds },
          paymentStatus: 'completed'
        })
          .select('driverId grossFare driverEarning vehicleSnapshot vendorFineCredit')
          .lean()
      : []

    const earningsByDriverId = earnings.reduce((acc, earning) => {
      const key = String(earning.driverId)
      if (!acc[key]) acc[key] = []
      acc[key].push(earning)
      return acc
    }, {})

    res.json({
      total: drivers.length,
      drivers: drivers.map(driver => ({
        ...serializeDriverForResponse(driver, req),
        ...buildVendorDriverRevenueMetrics({
          driver,
          earnings: earningsByDriverId[String(driver._id)] || [],
          vendor
        })
      }))
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

// =============================
// Get single driver (scoped to authenticated vendor)
// =============================
exports.getVendorDriverById = async (req, res) => {
  try {
    const { driverId } = req.params
    const authVendorId = req.user.id

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

    const driverVendorRef = driver.vendorId?._id || driver.vendorId
    if (String(driverVendorRef) !== String(authVendorId)) {
      return res.status(403).json({ message: 'You can only view drivers registered under your vendor account' })
    }

    const vendor = driver.vendorId?._id
      ? await Vendor.findById(driver.vendorId._id)
          .select('commissionType commissionValue')
          .lean()
      : null
    const earnings = await AdminEarnings.find({
      driverId: driver._id,
      paymentStatus: 'completed'
    })
      .select('driverId grossFare driverEarning vehicleSnapshot vendorFineCredit')
      .lean()

    res.json({
      ...serializeDriverForResponse(driver, req),
      ...buildVendorDriverRevenueMetrics({
        driver,
        earnings,
        vendor
      })
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
    const { driverId, vendorId: requestedVendorId } = req.body
    const vendorId = req.user.id

    if (requestedVendorId && String(requestedVendorId) !== String(vendorId)) {
      return res.status(403).json({ message: 'You can assign drivers only to your own vendor account' })
    }

    let driver = await Driver.findById(driverId)
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' })
    }

    const wasStandalone = !toObjectIdString(driver.vendorId)
    const driverVendorIdBefore = toObjectIdString(driver.vendorId)

    try {
      driver = await prepareDriverForVendorLinkSession(driverId)
    } catch (prepErr) {
      const code = prepErr.statusCode || 500
      return res.status(code).json({ message: prepErr.message })
    }

    const ctx = await getDriverVehicleOwnershipContext(driver)
    let vehicleRemovalMessage = null
    if (!isEligibleStandaloneDriverForVendorLink(driver)) {
      vehicleRemovalMessage = buildVehicleRemovalRequiredMessage({
        hasVehicleState: ctx.hasVehicleState,
        owningVendorId: ctx.owningVendorId,
        requestingVendorId: String(vendorId)
      })
    }

    if (vehicleRemovalMessage) {
      return res.status(400).json({ message: vehicleRemovalMessage })
    }

    const cat = String(req.body.vendorDriverCategory || '').toUpperCase()
    if (!['OWN', 'OTHER'].includes(cat)) {
      return res.status(400).json({
        message: 'vendorDriverCategory is required and must be OWN or OTHER'
      })
    }
    driver.vendorDriverCategory = cat

    driver.vendorId = vendorId
    if (!driver.isVerified) {
      setDriverPendingApproval(driver)
    }
    await driver.save()

    if (driverVendorIdBefore && driverVendorIdBefore !== String(vendorId)) {
      await Vendor.findByIdAndUpdate(driverVendorIdBefore, {
        $inc: { totalDrivers: -1 }
      })
    }

    if (driverVendorIdBefore !== String(vendorId)) {
      await Vendor.findByIdAndUpdate(vendorId, {
        $inc: { totalDrivers: 1 }
      })
    }

    if (wasStandalone) {
      await queueAdminNotifyDriverLinkedVendor(driver, vendorId)
    }

    res.json({
      message: 'Driver assigned to vendor successfully',
      driver: serializeDriverForResponse(driver, req)
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

    await detachVendorFleetFromDriver(driver, vendorId)

    if (hasDriverVehicleState(driver)) {
      return res.status(400).json({
        message: 'Please remove the driver vehicle first before removing this driver from the vendor'
      })
    }

    driver.vendorId = null
    driver.vendorDriverCategory = 'SELF'
    if (!driver.isVerified) {
      setDriverPendingApproval(driver)
    }
    await driver.save()

    await Vendor.findByIdAndUpdate(vendorId, {
      $inc: { totalDrivers: -1 }
    })

    res.json({
      message: 'Driver removed from vendor',
      driver: serializeDriverForResponse(driver, req)
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

// Driver JWT: leave current vendor (fleet unassigned; personal garage may remain)
exports.leaveVendorAsDriver = async (req, res) => {
  try {
    let driver = await Driver.findById(req.driverId)
    if (!driver) {
      return res.status(404).json({ message: 'Driver not found' })
    }
    if (!driver.vendorId) {
      return res.status(400).json({ message: 'You are not assigned to a vendor' })
    }
    const vendorId = String(driver.vendorId)

    const activeRide = await Ride.findOne({
      driver: driver._id,
      status: { $in: ['requested', 'accepted', 'arrived', 'in_progress'] }
    })
      .select('_id status')
      .lean()

    if (activeRide) {
      return res.status(409).json({
        success: false,
        message:
          'Finish or cancel your active ride before leaving your vendor.'
      })
    }

    if (driver.isOnline) {
      await stopDriverOnlineSession(driver._id, 'leave_vendor')
      driver = await Driver.findById(req.driverId)
      if (!driver) {
        return res.status(404).json({ message: 'Driver not found' })
      }
    }

    await detachVendorFleetFromDriver(driver, vendorId)

    driver.vendorId = null
    driver.vendorDriverCategory = 'SELF'
    if (!driver.isVerified) {
      setDriverPendingApproval(driver)
    }
    await driver.save()

    await Vendor.findByIdAndUpdate(vendorId, {
      $inc: { totalDrivers: -1 }
    })

    return res.json({
      success: true,
      message: 'You have left the vendor',
      driver: serializeDriverForResponse(driver, req)
    })
  } catch (error) {
    return res.status(500).json({ message: error.message })
  }
}

exports.lookupDriverByPhoneForVendor = async (req, res) => {
  try {
    const vendorId = req.user.id
    let phone = null
    let email = null

    if (
      req.body.phone !== undefined &&
      req.body.phone !== null &&
      String(req.body.phone).trim() !== ''
    ) {
      const normalizedPhone = normalizeMobileDigits(req.body.phone)
      if (normalizedPhone.error || !normalizedPhone.value) {
        return res.status(400).json({
          message: normalizedPhone.error || 'Invalid phone number'
        })
      }
      phone = normalizedPhone.value
    }

    if (
      req.body.email !== undefined &&
      req.body.email !== null &&
      String(req.body.email).trim() !== ''
    ) {
      const normalizedEmail = normalizeEmail(req.body.email)
      if (normalizedEmail.error) {
        return res.status(400).json({ message: normalizedEmail.error })
      }
      email = normalizedEmail.value
    }

    if (!phone && !email) {
      return res.status(400).json({
        message: 'phone or email is required'
      })
    }

    const query =
      phone && email
        ? { $or: [{ phone }, { email }] }
        : phone
          ? { phone }
          : { email }

    const driver = await Driver.findOne(query)
      .select(
        'name phone email vendorId isVerified approvalWorkflow assignedFleetVehicleId vehicleInfo pendingVehicleInfo vehicles complianceDocuments isOnline'
      )
      .populate('vendorId', 'businessName')

    if (!driver) {
      return res.json({ exists: false })
    }

    const p = driver.phone || phone || ''
    const summary = {
      name: driver.name,
      phoneMasked:
        p.length > 4
          ? `${p.slice(0, 2)}****${p.slice(-2)}`
          : '****',
      approvalStatus: getDriverApprovalSummary(driver).status
    }

    const otherVendorId = driver.vendorId?._id || driver.vendorId
    if (otherVendorId && String(otherVendorId) === String(vendorId)) {
      return res.json({
        exists: true,
        canAssign: false,
        reason: 'ALREADY_ON_VENDOR',
        message: 'This driver is already linked to your vendor account.',
        summary
      })
    }

    if (otherVendorId && String(otherVendorId) !== String(vendorId)) {
      return res.json({
        exists: true,
        canAssign: false,
        reason: 'ASSIGNED_ELSEWHERE',
        message: 'Driver is assigned to another vendor',
        summary: {
          ...summary,
          vendorName: driver.vendorId?.businessName || 'Another vendor'
        }
      })
    }

    if (!isEligibleStandaloneDriverForVendorLink(driver)) {
      const ctx = await getDriverVehicleOwnershipContext(driver)
      const msg = buildVehicleRemovalRequiredMessage({
        hasVehicleState: ctx.hasVehicleState,
        owningVendorId: ctx.owningVendorId,
        requestingVendorId: String(vendorId)
      })
      if (msg) {
        return res.json({
          exists: true,
          canAssign: false,
          reason: 'VEHICLE_BLOCK',
          message: msg,
          summary
        })
      }
    }

    return res.json({
      exists: true,
      canAssign: true,
      driverId: driver._id,
      summary
    })
  } catch (error) {
    return res.status(500).json({ message: error.message })
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

    const pendingVehicle = getPendingDriverVehicleRecord(driver)
    if (pendingVehicle) {
      pendingVehicle.approvalRoutedTo = 'ADMIN'
      pendingVehicle.approvalStatus = 'UNDER_APPROVAL'
      pendingVehicle.vendorPreApprovedAt = new Date()
    }

    driver.pendingVehicleInfo = {
      ...driver.pendingVehicleInfo.toObject(),
      approvalRoutedTo: 'ADMIN',
      approvalStatus: 'UNDER_APPROVAL',
      vendorPreApprovedAt: new Date()
    }
    syncDriverLegacyVehicleState(driver)
    await driver.save()

    setImmediate(async () => {
      try {
        const vendor = await Vendor.findById(req.user.id).select('businessName ownerName email')
        await queueExternalAlertEmail({
          channel: 'email',
          to: vendor?.email,
          subject: 'Driver vehicle approved',
          message: `Hi ${vendor?.businessName || vendor?.ownerName || 'Vendor'}, you approved ${driver.name || 'the driver'}'s vehicle and forwarded it to Cerca admin for final approval.`,
          metadata: {
            purpose: 'vendor_driver_vehicle_approved',
            vendorId: req.user.id,
            driverId: driver._id
          }
        })
      } catch (emailErr) {
        logger.error(
          `Vendor driver vehicle approval email queue error for vendor ${req.user.id}: ${emailErr.message}`
        )
      }
    })

    logger.info('Vendor forwarded driver vehicle to admin', {
      vendorId: req.user.id,
      driverId: driver._id.toString()
    })

    const pendingPlate =
      driver.pendingVehicleInfo?.licensePlate ||
      pendingVehicle?.licensePlate ||
      ''
    setImmediate(() => {
      notifyAdminsRegistrationEvent({
        type: 'admin_vehicle_pending',
        title: 'Vehicle forwarded for admin approval',
        message: `Driver ${driver.name || driver._id}: vehicle ${pendingPlate || '(pending)'} forwarded by vendor.`,
        entityKind: 'vehicle',
        entityId: driver._id,
        path: '/folder/drivers',
        data: {
          licensePlate: pendingPlate,
          driverId: String(driver._id),
          vendorId: String(req.user.id),
          source: 'driver_vehicle_vendor_forwarded',
        },
      }).catch((e) =>
        logger.error('admin registration notify (vendor forward vehicle):', e)
      )
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

    const driver = await Driver.findById(driverId)

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      })
    }

    if (!driver.isVerified) {
      return res.status(400).json({
        success: false,
        message: 'Driver must be approved by admin before assigning a fleet vehicle'
      })
    }

    const previousVendorId = toObjectIdString(driver.vendorId)
    const {
      owningVendorId,
      hasVehicleState
    } = await getDriverVehicleOwnershipContext(driver)

    if (rawId === null || rawId === undefined || rawId === '') {
      if (owningVendorId !== String(vendorId)) {
        return res.status(403).json({
          success: false,
          message: 'Only the original vendor can remove this vehicle assignment'
        })
      }

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
      const fallbackApprovedVehicle = getLatestDriverVehicleRecord(
        driver,
        vehicle => vehicle.approvalStatus === 'APPROVED'
      )
      getDriverVehicleRecords(driver).forEach(vehicle => {
        vehicle.isActive =
          Boolean(fallbackApprovedVehicle) &&
          String(vehicle._id) === String(fallbackApprovedVehicle._id)
      })
      syncDriverLegacyVehicleState(driver)
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

    const vehicleRemovalMessage = buildVehicleRemovalRequiredMessage({
      hasVehicleState,
      owningVendorId,
      requestingVendorId: String(vendorId)
    })

    if (vehicleRemovalMessage) {
      return res.status(400).json({
        success: false,
        message: vehicleRemovalMessage
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

    if (previousVendorId && previousVendorId !== String(vendorId)) {
      await Vendor.findByIdAndUpdate(previousVendorId, {
        $inc: { totalDrivers: -1 }
      })
    }

    if (previousVendorId !== String(vendorId)) {
      await Vendor.findByIdAndUpdate(vendorId, {
        $inc: { totalDrivers: 1 }
      })
    }

    driver.vendorId = vendorId
    driver.assignedFleetVehicleId = fv._id
    getDriverVehicleRecords(driver).forEach(vehicle => {
      vehicle.isActive = false
    })
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

exports.deleteVendorDriverVehicle = async (req, res) => {
  try {
    const vendorId = String(req.user.id)
    const { driverId } = req.params

    const driver = await Driver.findById(driverId)

    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      })
    }

    const {
      owningVendorId,
      hasVehicleState
    } = await getDriverVehicleOwnershipContext(driver)

    if (!hasVehicleState) {
      return res.status(400).json({
        success: false,
        message: 'No vehicle found for this driver'
      })
    }

    if (!owningVendorId) {
      return res.status(403).json({
        success: false,
        message: 'Self-registered drivers must remove their own vehicle'
      })
    }

    if (owningVendorId !== vendorId) {
      return res.status(403).json({
        success: false,
        message: 'Only the original vendor can remove this vehicle'
      })
    }

    const removed = clearDriverVehicleState(driver)
    await driver.save()

    logger.info('Vendor removed driver vehicle', {
      vendorId,
      driverId: driver._id.toString(),
      removed
    })

    return res.status(200).json({
      success: true,
      message: 'Driver vehicle removed successfully',
      removed,
      driver: {
        driverId: driver._id,
        vendorId: driver.vendorId,
        ...serializeVehicleState(driver)
      }
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    })
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

    const pendingVehicle = getPendingDriverVehicleRecord(driver)
    if (pendingVehicle) {
      pendingVehicle.approvalStatus = 'REJECTED'
      pendingVehicle.rejectedAt = new Date()
      pendingVehicle.approvedAt = null
      pendingVehicle.rejectionReason = reason.trim()
      pendingVehicle.isActive = false
    }

    driver.pendingVehicleInfo = {
      ...driver.pendingVehicleInfo.toObject(),
      approvalStatus: 'REJECTED',
      rejectedAt: new Date(),
      approvedAt: null,
      rejectionReason: reason.trim()
    }
    syncDriverLegacyVehicleState(driver)
    await driver.save()

    setImmediate(async () => {
      try {
        await queueExternalAlertEmail({
          channel: 'email',
          to: driver.email,
          subject: 'Driver vehicle rejected',
          message: `Hi ${driver.name || 'Driver'}, your vehicle has been rejected by ${req.user.businessName || req.user.ownerName || 'your vendor'}. Reason: ${reason.trim()}. Please update the vehicle information and resubmit for approval.`,
          metadata: {
            purpose: 'vendor_driver_vehicle_rejected',
            driverId: driver._id,
            vendorId: req.user.id,
            rejectedBy: 'VENDOR'
          }
        })
      } catch (emailErr) {
        logger.error(`Vendor driver vehicle rejection email queue error for ${driver.email}: ${emailErr.message}`)
      }
    })

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

    const allDriverList = drivers
    const onlineDriverList = drivers.filter(driver => driver.isOnline)
    const activeDriverList = drivers.filter(driver => driver.isActive)
    const verifiedDriverList = drivers.filter(driver => driver.isVerified)

    const totalDrivers = allDriverList.length
    const onlineDrivers = onlineDriverList.length
    const activeDrivers = activeDriverList.length
    const verifiedDrivers = verifiedDriverList.length
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
      drivers: allDriverList,
      driverLists: {
        all: allDriverList,
        active: activeDriverList,
        online: onlineDriverList,
        verified: verifiedDriverList
      }
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
  const started = Date.now()
  try {
    const vendorId = req.user.id
    const {
      startDate,
      endDate,
      driverId: filterDriverId,
      vehicleKey,
      licensePlate,
      ridePage,
      rideLimit,
      rideSort,
      rideOrder
    } = req.query

    const report = await getVendorEarningsReportData({
      vendorId,
      startDate,
      endDate,
      filterDriverId: filterDriverId || null,
      filterVehicleKey: vehicleKey || null,
      filterLicensePlate: licensePlate || null,
      ridePage,
      rideLimit,
      rideSort,
      rideOrder
    })

    if (report.meta?.invalidDriverFilter) {
      return res.status(403).json({
        success: false,
        message: 'Driver not found or not registered under your vendor account'
      })
    }

    const { _allRidesSorted, ...publicReport } = report

    logger.info('vendor_earnings_report', {
      vendorId: String(vendorId),
      durationMs: Date.now() - started,
      rideTotal: report.rideWiseTotalCount,
      driverRows: report.driverWiseEarnings?.length ?? 0,
      vehicleRows: report.vehicleWiseEarnings?.length ?? 0
    })

    res.status(200).json({
      success: true,
      data: {
        vendor: {
          id: publicReport.vendor?._id,
          businessName: publicReport.vendor?.businessName || null,
          commissionType: publicReport.vendor?.commissionType || null,
          commissionValue: publicReport.vendor?.commissionValue || 0
        },
        filters: {
          startDate: startDate || null,
          endDate: endDate || null,
          driverId: filterDriverId || null,
          vehicleKey: vehicleKey || null,
          licensePlate: licensePlate || null,
          paymentStatus: 'completed'
        },
        meta: publicReport.meta,
        summary: publicReport.summary,
        driverWiseEarnings: publicReport.driverWiseEarnings,
        vehicleWiseEarnings: publicReport.vehicleWiseEarnings,
        rideWiseRevenue: publicReport.rideWiseRevenue,
        rideWiseTotalCount: publicReport.rideWiseTotalCount,
        ridePagination: publicReport.ridePagination
      }
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    })
  }
}

exports.getVendorEarningsExport = async (req, res) => {
  const started = Date.now()
  try {
    const vendorId = req.user.id
    const {
      startDate,
      endDate,
      driverId: filterDriverId,
      vehicleKey,
      licensePlate,
      rideSort,
      rideOrder
    } = req.query

    const report = await getVendorEarningsReportData({
      vendorId,
      startDate,
      endDate,
      filterDriverId: filterDriverId || null,
      filterVehicleKey: vehicleKey || null,
      filterLicensePlate: licensePlate || null,
      ridePage: 1,
      rideLimit: MAX_CSV_RIDE_ROWS,
      rideSort: rideSort || 'rideDate',
      rideOrder: rideOrder || 'desc'
    })

    if (report.meta?.invalidDriverFilter) {
      return res.status(403).json({
        success: false,
        message: 'Driver not found or not registered under your vendor account'
      })
    }

    const allSorted = report._allRidesSorted || []
    const truncated = allSorted.length > MAX_CSV_RIDE_ROWS
    const csvRows = truncated ? allSorted.slice(0, MAX_CSV_RIDE_ROWS) : allSorted
    const csv = buildEarningsCsv(csvRows)

    logger.info('vendor_earnings_export', {
      vendorId: String(vendorId),
      durationMs: Date.now() - started,
      rowCount: csvRows.length,
      truncated
    })

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="vendor-earnings-rides.csv"')
    if (truncated) {
      res.setHeader('X-Export-Truncated', 'true')
      res.setHeader('X-Export-Total-Rides', String(allSorted.length))
    }
    res.status(200).send(`\ufeff${csv}`)
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
          totalCancellationFines: report.summary.totalCancellationFines,
          totalVendorProfit: report.summary.totalVendorProfit,
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

    try {
      await notifyAdminsVendorPayoutRequested({
        vendorId,
        businessName: vendor.businessName,
        amount: requestedAmount,
        payoutId: payout._id.toString()
      })
    } catch (notifyErr) {
      logger.warn('notifyAdminsVendorPayoutRequested failed:', notifyErr.message)
    }

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
    const { name, password, location } = req.body

    if (!vendorId) {
      return res.status(400).json({ message: 'vendorId is required' })
    }
    if (String(vendorId) !== String(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: 'vendorId must match your authenticated vendor account'
      })
    }

    const normalizedPhone = normalizeMobileDigits(req.body.phone)
    if (normalizedPhone.error || !normalizedPhone.value) {
      return res.status(400).json({
        message: normalizedPhone.error || 'Phone number is required'
      })
    }
    const phone = normalizedPhone.value

    const explicitEmailInput =
      req.body.email !== undefined &&
      req.body.email !== null &&
      String(req.body.email).trim() !== ''

    const emailResult = explicitEmailInput
      ? normalizeEmail(req.body.email)
      : { value: `${phone}@vendor.local`, error: null }
    if (emailResult.error) {
      return res.status(400).json({ message: emailResult.error })
    }
    const email = emailResult.value

    const existingQuery = explicitEmailInput
      ? { $or: [{ phone }, { email }] }
      : { phone }

    const existing = await Driver.findOne(existingQuery)
    if (existing) {
      const ev = existing.vendorId ? String(existing.vendorId) : null
      if (ev && ev !== String(vendorId)) {
        return res.status(409).json({
          success: false,
          code: 'DRIVER_EXISTS',
          message:
            'Driver with this phone or email is already linked to another vendor',
          driverId: existing._id
        })
      }
      if (ev === String(vendorId)) {
        return res.status(400).json({
          success: false,
          code: 'ALREADY_ON_VENDOR',
          message: 'This driver is already linked to your vendor account.'
        })
      }

      let driver = existing
      try {
        driver = await prepareDriverForVendorLinkSession(existing._id)
      } catch (prepErr) {
        const code = prepErr.statusCode || 500
        return res.status(code).json({
          success: false,
          message: prepErr.message
        })
      }

      if (!isEligibleStandaloneDriverForVendorLink(driver)) {
        const missing = getMissingDriverApprovalDocuments(driver)
        const reasons = []
        if (driver.isVerified !== true) {
          reasons.push('driver is not verified by admin')
        }
        if (missing.length) {
          reasons.push(`missing compliance: ${missing.join(', ')}`)
        }
        if (driver.assignedFleetVehicleId) {
          reasons.push(
            'fleet vehicle still assigned; driver must clear vendor fleet assignment first'
          )
        }
        return res.status(400).json({
          success: false,
          code: 'DRIVER_NOT_ELIGIBLE_FOR_LINK',
          message: `Cannot link this driver: ${reasons.join('; ')}`,
          driverId: driver._id
        })
      }

      if (!name || !String(name).trim()) {
        return res.status(400).json({
          success: false,
          message: 'name is required'
        })
      }

      const cat = String(req.body.vendorDriverCategory || 'OWN').toUpperCase()
      if (!['OWN', 'OTHER'].includes(cat)) {
        return res.status(400).json({
          message: 'vendorDriverCategory must be OWN or OTHER'
        })
      }

      driver.name = String(name).trim()
      driver.vendorId = vendorId
      driver.vendorDriverCategory = cat
      if (!driver.isVerified) {
        setDriverPendingApproval(driver)
      }
      await driver.save()

      await Vendor.findByIdAndUpdate(vendorId, {
        $inc: { totalDrivers: 1 }
      })

      await queueAdminNotifyDriverLinkedVendor(driver, vendorId)

      return res.status(200).json({
        success: true,
        linkedExisting: true,
        message: 'Existing driver linked to your vendor',
        driver: serializeDriverForResponse(driver, req)
      })
    }

    if (!name || !password) {
      return res
        .status(400)
        .json({ message: 'name, phone and password are required' })
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
      vendorDriverCategory: 'OWN',
      isVerified: false,
      isActive: false,
      approvalWorkflow: buildInitialApprovalWorkflow(vendorId)
    })

    await Vendor.findByIdAndUpdate(vendorId, { $inc: { totalDrivers: 1 } })

    setImmediate(() => {
      notifyAdminsRegistrationEvent({
        type: 'admin_new_driver',
        title: 'New vendor driver',
        message: `${name} (${phone}) was added under a vendor and is in the approval flow.`,
        entityKind: 'driver',
        entityId: driver._id,
        data: { driverName: name, phone, vendorId: String(vendorId) },
      }).catch((e) => logger.error('admin registration notify (vendor addDriver):', e))
    })

    res.status(201).json({
      success: true,
      message: 'Driver created under vendor',
      driver: serializeDriverForResponse(driver, req)
    })
  } catch (error) {
    res.status(500).json({ success: false, message: error.message })
  }
}

// Update driver (vendor-scoped: only allowed fields, driver must belong to vendor)
exports.updateVendorDriver = async (req, res) => {
  try {
    const vendorId = req.user.id
    const { driverId } = req.params
    const { name, password } = req.body

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
    if (req.body.email !== undefined) {
      const emailResult = normalizeEmail(req.body.email)
      if (emailResult.error) {
        return res.status(400).json({ message: emailResult.error })
      }
      driver.email = emailResult.value
    }
    if (req.body.phone !== undefined) {
      const phoneResult = normalizeMobileDigits(req.body.phone)
      if (phoneResult.error || !phoneResult.value) {
        return res.status(400).json({ message: phoneResult.error || 'Phone number is required' })
      }
      const phone = phoneResult.value
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

    if (!driver.isVerified) {
      return res.status(403).json({
        success: false,
        code: 'DRIVER_NOT_VERIFIED',
        message:
          'Driver must be verified by the platform before you can block or unblock.',
      })
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

    if (!driver.isVerified) {
      return res.status(403).json({
        success: false,
        code: 'DRIVER_NOT_VERIFIED',
        message:
          'Driver must be verified by the platform before you can block or unblock.',
      })
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
      .json({
        success: true,
        documents: (driver.documents || []).map((document, index) =>
          normalizeStoredDocumentEntry(req, document, index)
        )
      })
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

    const documentEntry = buildUploadedDocumentEntry(
      req,
      req.file,
      req.body?.documentType
    )

    if (canResubmit) {
      vendor.documents = [documentEntry]
      vendor.isVerified = false
      vendor.isActive = false
      vendor.rejectionReason = null
      vendor.allowDocumentResubmit = false
      vendor.vendorReviewStatus = 'PENDING'
    } else {
      vendor.documents = vendor.documents || []
      vendor.documents.push(documentEntry)
    }
    await vendor.save()

    return res.status(200).json({
      success: true,
      message: canResubmit
        ? 'Document resubmitted for verification.'
        : 'Document submitted for verification.',
      documents: (vendor.documents || []).map((document, index) =>
        normalizeStoredDocumentEntry(req, document, index)
      )
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

    const documentEntry = buildUploadedDocumentEntry(
      req,
      req.file,
      req.body?.documentType
    )
    vendor.documents = vendor.documents || []
    vendor.documents.push(documentEntry)
    await vendor.save()

    return res.status(200).json({
      success: true,
      message: 'Document uploaded successfully.',
      documents: (vendor.documents || []).map((document, index) =>
        normalizeStoredDocumentEntry(req, document, index)
      )
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

//Vendor Heatmap to show most active rides
