const FleetVehicle = require('../../Models/Vendor/fleetVehicle.model')
const logger = require('../../utils/logger')

const normalizeStoredDocumentUrl = (req, url) => {
  const rawUrl = String(url || '').trim()
  if (!rawUrl) return rawUrl

  if (/^https?:\/\//i.test(rawUrl)) {
    return rawUrl
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`
  const normalizedPath = rawUrl.replace(/\\/g, '/')
  const uploadsIndex = normalizedPath.lastIndexOf('/uploads/')

  if (uploadsIndex >= 0) {
    return `${baseUrl}${normalizedPath.slice(uploadsIndex)}`
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
      .populate('vendorId', 'businessName email phone')
      .sort({ updatedAt: -1 })
      .lean()

    return res.json({
      success: true,
      fleetVehicles: list.map(vehicle => serialize(req, vehicle))
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
      .populate('vendorId', 'businessName email phone ownerName')
      .lean()

    if (!fv) {
      return res.status(404).json({ success: false, message: 'Fleet vehicle not found' })
    }

    return res.json({ success: true, fleetVehicle: serialize(req, fv) })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}
