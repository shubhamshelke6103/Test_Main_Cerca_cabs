const FleetVehicle = require('../../Models/Vendor/fleetVehicle.model')
const Driver = require('../../Models/Driver/driver.model')
const logger = require('../../utils/logger')

const DRIVER_SUMMARY_SELECT =
  'name email phone isVerified isActive isOnline vendorId assignedFleetVehicleId vehicleInfo pendingVehicleInfo updatedAt createdAt'

const VENDOR_SUMMARY_SELECT = 'businessName ownerName email phone isVerified isActive address'

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

const serialize = (req, v) => {
  const record = v && v.toObject ? v.toObject() : v
  if (!record) return record

  if (Array.isArray(record.documents)) {
    record.documents = record.documents.map(doc => ({
      ...doc,
      documentUrl: normalizeStoredDocumentUrl(req, doc.documentUrl)
    }))
  }

  return record
}

const buildDriverSummary = driver => {
  if (!driver) return null

  return {
    _id: driver._id,
    name: driver.name,
    email: driver.email || null,
    phone: driver.phone || null,
    isVerified: Boolean(driver.isVerified),
    isActive: Boolean(driver.isActive),
    isOnline: Boolean(driver.isOnline),
    vendorId: driver.vendorId || null
  }
}

const buildVendorSummary = vendor => {
  if (!vendor) return null

  return {
    _id: vendor._id,
    businessName: vendor.businessName,
    ownerName: vendor.ownerName || null,
    email: vendor.email || null,
    phone: vendor.phone || null,
    address: vendor.address || null,
    isVerified: Boolean(vendor.isVerified),
    isActive: Boolean(vendor.isActive)
  }
}

const buildStandaloneVehicleRecord = (req, driver) => {
  const activeVehicle = driver.vehicleInfo || null
  const pendingVehicle = driver.pendingVehicleInfo || null
  const vehicleSource = pendingVehicle || activeVehicle || {}

  return {
  _id: `driver-vehicle-${driver._id}`,
  vehicleRecordType: 'DRIVER_PERSONAL',
  driverId: driver._id,
  fleetVehicleId: null,
  make: vehicleSource.make || null,
  model: vehicleSource.model || null,
  year: vehicleSource.year || null,
  color: vehicleSource.color || null,
  licensePlate: vehicleSource.licensePlate || null,
  vehicleType: vehicleSource.vehicleType || null,
  documents: Array.isArray(vehicleSource.documents)
    ? vehicleSource.documents.map(doc => ({
        ...doc,
        documentUrl: normalizeStoredDocumentUrl(req, doc.documentUrl)
      }))
    : [],
  approvalStatus: pendingVehicle?.approvalStatus || 'APPROVED',
  submittedAt: pendingVehicle?.submittedAt || null,
  approvedAt: pendingVehicle?.approvedAt || null,
  rejectedAt: pendingVehicle?.rejectedAt || null,
  rejectionReason: pendingVehicle?.rejectionReason || null,
  allowDocumentResubmit: Boolean(pendingVehicle?.allowDocumentResubmit),
  approvalRoutedTo: pendingVehicle?.approvalRoutedTo || 'ADMIN',
  vendor: null,
  assignedDriver: buildDriverSummary(driver),
  assignedDriverCount: 1,
  createdAt: driver.createdAt || null,
  updatedAt: driver.updatedAt || null
  }
}

const attachAssignedDriversToFleetVehicles = async fleetVehicles => {
  const fleetVehicleIds = fleetVehicles.map(vehicle => vehicle._id)
  if (fleetVehicleIds.length === 0) {
    return new Map()
  }

  const assignedDrivers = await Driver.find({
    assignedFleetVehicleId: { $in: fleetVehicleIds }
  })
    .select(DRIVER_SUMMARY_SELECT)
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean()

  const assignedDriverMap = new Map()

  for (const driver of assignedDrivers) {
    const key = String(driver.assignedFleetVehicleId)
    const current = assignedDriverMap.get(key)
    if (!current) {
      assignedDriverMap.set(key, {
        assignedDriver: buildDriverSummary(driver),
        assignedDriverCount: 1
      })
      continue
    }

    current.assignedDriverCount += 1
  }

  return assignedDriverMap
}

const buildFleetVehicleResponse = (req, fleetVehicle, assignedDriverInfo) => {
  const serializedVehicle = serialize(req, fleetVehicle)

  return {
    ...serializedVehicle,
    vehicleRecordType: 'VENDOR_FLEET',
    fleetVehicleId: serializedVehicle._id,
    vendor: buildVendorSummary(serializedVehicle.vendorId),
    assignedDriver: assignedDriverInfo?.assignedDriver || null,
    assignedDriverCount: assignedDriverInfo?.assignedDriverCount || 0
  }
}

exports.listFleetVehicles = async (req, res) => {
  try {
    const { status, vendorId } = req.query
    const filter = {}
    if (status) {
      filter.approvalStatus = status
    }
    if (vendorId) {
      filter.vendorId = vendorId
    }

    const list = await FleetVehicle.find(filter)
      .populate('vendorId', VENDOR_SUMMARY_SELECT)
      .sort({ updatedAt: -1 })
      .lean()

    const assignedDriverMap = await attachAssignedDriversToFleetVehicles(list)

    return res.json({
      success: true,
      fleetVehicles: list.map(vehicle =>
        buildFleetVehicleResponse(
          req,
          vehicle,
          assignedDriverMap.get(String(vehicle._id))
        )
      )
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

exports.approveFleetVehicle = async (req, res) => {
  try {
    const fv = await FleetVehicle.findById(req.params.id)
    if (!fv) {
      return res.status(404).json({ success: false, message: 'Fleet vehicle not found' })
    }
    if (fv.approvalStatus !== 'UNDER_APPROVAL') {
      return res.status(400).json({
        success: false,
        message: 'Only vehicles pending approval can be approved'
      })
    }

    fv.approvalStatus = 'APPROVED'
    fv.approvedAt = new Date()
    fv.rejectedAt = null
    fv.rejectionReason = null
    fv.allowDocumentResubmit = false
    await fv.save()

    logger.info('Fleet vehicle approved by admin', {
      fleetVehicleId: fv._id.toString(),
      vendorId: fv.vendorId?.toString?.(),
      adminId: req.adminId?.toString?.()
    })

    return res.json({
      success: true,
      message: 'Fleet vehicle approved',
      fleetVehicle: serialize(req, fv)
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

exports.rejectFleetVehicle = async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim()
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required'
      })
    }

    const allowDocumentResubmit = Boolean(req.body?.allowDocumentResubmit)

    const fv = await FleetVehicle.findById(req.params.id)
    if (!fv) {
      return res.status(404).json({ success: false, message: 'Fleet vehicle not found' })
    }
    if (fv.approvalStatus !== 'UNDER_APPROVAL') {
      return res.status(400).json({
        success: false,
        message: 'Only vehicles pending approval can be rejected'
      })
    }

    fv.approvalStatus = 'REJECTED'
    fv.rejectedAt = new Date()
    fv.approvedAt = null
    fv.rejectionReason = reason
    fv.allowDocumentResubmit = allowDocumentResubmit
    await fv.save()

    logger.info('Fleet vehicle rejected by admin', {
      fleetVehicleId: fv._id.toString(),
      vendorId: fv.vendorId?.toString?.(),
      allowDocumentResubmit,
      adminId: req.adminId?.toString?.()
    })

    return res.json({
      success: true,
      message: 'Fleet vehicle rejected',
      fleetVehicle: serialize(req, fv)
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

exports.getFleetVehicleAdmin = async (req, res) => {
  try {
    const fv = await FleetVehicle.findById(req.params.id)
      .populate('vendorId', VENDOR_SUMMARY_SELECT)
      .lean()

    if (!fv) {
      return res.status(404).json({ success: false, message: 'Fleet vehicle not found' })
    }

    const assignedDriverMap = await attachAssignedDriversToFleetVehicles([fv])

    return res.json({
      success: true,
      fleetVehicle: buildFleetVehicleResponse(
        req,
        fv,
        assignedDriverMap.get(String(fv._id))
      )
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

exports.listVehicleInventory = async (req, res) => {
  try {
    const { status, vendorId, search, ownershipType } = req.query
    const normalizedOwnershipType = String(ownershipType || '')
      .trim()
      .toUpperCase()

    const fleetVehicleFilter = {}
    if (status) {
      fleetVehicleFilter.approvalStatus = status
    }
    if (vendorId) {
      fleetVehicleFilter.vendorId = vendorId
    }
    if (search) {
      const regex = new RegExp(search, 'i')
      fleetVehicleFilter.$or = [
        { make: regex },
        { model: regex },
        { color: regex },
        { licensePlate: regex },
        { vehicleType: regex }
      ]
    }

    const normalizedStatus = String(status || '').trim().toUpperCase()
    const standaloneDriverFilter = {
      vendorId: null,
      $or: [
        { vehicleInfo: { $exists: true, $ne: null } },
        { pendingVehicleInfo: { $exists: true, $ne: null } }
      ],
      $and: [
        {
          $or: [
            { assignedFleetVehicleId: null },
            { assignedFleetVehicleId: { $exists: false } }
          ]
        }
      ]
    }

    if (normalizedStatus === 'APPROVED') {
      standaloneDriverFilter.$and.push({
        vehicleInfo: { $exists: true, $ne: null }
      })
    } else if (normalizedStatus === 'UNDER_APPROVAL' || normalizedStatus === 'REJECTED') {
      standaloneDriverFilter.$and.push({
        'pendingVehicleInfo.approvalStatus': normalizedStatus
      })
    } else if (normalizedStatus) {
      standaloneDriverFilter._id = { $in: [] }
    }
    if (search) {
      const regex = new RegExp(search, 'i')
      standaloneDriverFilter.$and.push({
        $or: [
          { 'vehicleInfo.make': regex },
          { 'vehicleInfo.model': regex },
          { 'vehicleInfo.color': regex },
          { 'vehicleInfo.licensePlate': regex },
          { 'vehicleInfo.vehicleType': regex },
          { 'pendingVehicleInfo.make': regex },
          { 'pendingVehicleInfo.model': regex },
          { 'pendingVehicleInfo.color': regex },
          { 'pendingVehicleInfo.licensePlate': regex },
          { 'pendingVehicleInfo.vehicleType': regex },
          { name: regex },
          { email: regex },
          { phone: regex }
        ]
      })
    }

    const shouldIncludeFleetVehicles =
      !normalizedOwnershipType || normalizedOwnershipType === 'VENDOR_FLEET'
    const shouldIncludeStandaloneVehicles =
      !normalizedOwnershipType || normalizedOwnershipType === 'DRIVER_PERSONAL'

    const [fleetVehicles, standaloneDrivers] = await Promise.all([
      shouldIncludeFleetVehicles
        ? FleetVehicle.find(fleetVehicleFilter)
            .populate('vendorId', VENDOR_SUMMARY_SELECT)
            .sort({ updatedAt: -1 })
            .lean()
        : Promise.resolve([]),
      shouldIncludeStandaloneVehicles
        ? Driver.find(standaloneDriverFilter)
            .select(DRIVER_SUMMARY_SELECT)
            .sort({ updatedAt: -1 })
            .lean()
        : Promise.resolve([])
    ])

    const assignedDriverMap = await attachAssignedDriversToFleetVehicles(fleetVehicles)

    const fleetVehicleRecords = fleetVehicles.map(vehicle =>
      buildFleetVehicleResponse(
        req,
        vehicle,
        assignedDriverMap.get(String(vehicle._id))
      )
    )

    const standaloneVehicleRecords = standaloneDrivers.map(driver =>
      buildStandaloneVehicleRecord(req, driver)
    )

    const vehicles = [...fleetVehicleRecords, ...standaloneVehicleRecords].sort((a, b) => {
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
    })

    return res.json({
      success: true,
      totalVehicles: vehicles.length,
      fleetVehicleCount: fleetVehicleRecords.length,
      standaloneVehicleCount: standaloneVehicleRecords.length,
      vehicles
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}
