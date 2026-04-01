const FleetVehicle = require('../../Models/Vendor/fleetVehicle.model')

const VEHICLE_DOCUMENT_FIELDS = [
  { field: 'vehicleRc', type: 'RC' },
  { field: 'vehicleInsurance', type: 'INSURANCE' },
  { field: 'vehiclePermit', type: 'PERMIT' },
  { field: 'vehiclePuc', type: 'PUC' }
]

const buildUploadedFileUrl = (req, file) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`
  const normalizedPath = String(file.path || '').replace(/\\/g, '/')
  return `${baseUrl}/${normalizedPath}`
}

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

const collectVehicleDocumentsFromReq = req => {
  const uploadedFields = req.files || {}
  const missingFields = VEHICLE_DOCUMENT_FIELDS.filter(
    ({ field }) => !uploadedFields[field] || !uploadedFields[field][0]
  ).map(({ field }) => field)

  if (missingFields.length > 0) {
    return { missingFields, documents: [] }
  }

  const documents = VEHICLE_DOCUMENT_FIELDS.map(({ field, type }) => ({
    documentType: type,
    documentUrl: buildUploadedFileUrl(req, uploadedFields[field][0])
  }))

  return { missingFields: [], documents }
}

const serializeFleetVehicle = (req, v) => {
  if (!v) return null
  const o = v.toObject ? v.toObject() : v
  if (Array.isArray(o.documents)) {
    o.documents = o.documents.map(doc => ({
      ...doc,
      documentUrl: normalizeStoredDocumentUrl(req, doc.documentUrl)
    }))
  }
  return o
}

exports.createFleetVehicle = async (req, res) => {
  try {
    const vendorId = req.user.id
    const { make, model, year, color, licensePlate, vehicleType } = req.body

    if (!make || !model || !year || !color || !licensePlate) {
      return res.status(400).json({
        success: false,
        message: 'make, model, year, color, and licensePlate are required'
      })
    }

    const { missingFields, documents } = collectVehicleDocumentsFromReq(req)
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Vehicle RC, Insurance, Permit, and PUC documents are required',
        missingFields
      })
    }

    const fv = await FleetVehicle.create({
      vendorId,
      make: String(make).trim(),
      model: String(model).trim(),
      year: Number(year),
      color: String(color).trim(),
      licensePlate: String(licensePlate).trim(),
      vehicleType: vehicleType || 'sedan',
      documents,
      approvalStatus: 'UNDER_APPROVAL',
      submittedAt: new Date(),
      approvedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      allowDocumentResubmit: false
    })

    return res.status(201).json({
      success: true,
      message: 'Fleet vehicle submitted for admin approval',
      fleetVehicle: serializeFleetVehicle(req, fv)
    })
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'A vehicle with this license plate already exists in your fleet'
      })
    }
    return res.status(500).json({ success: false, message: error.message })
  }
}

exports.listFleetVehicles = async (req, res) => {
  try {
    const vendorId = req.user.id
    const list = await FleetVehicle.find({ vendorId }).sort({ updatedAt: -1 }).lean()
    return res.json({
      success: true,
      fleetVehicles: list.map(vehicle => serializeFleetVehicle(req, vehicle))
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

exports.getFleetVehicle = async (req, res) => {
  try {
    const vendorId = req.user.id
    const fv = await FleetVehicle.findOne({
      _id: req.params.id,
      vendorId
    }).lean()

    if (!fv) {
      return res.status(404).json({ success: false, message: 'Fleet vehicle not found' })
    }

    return res.json({ success: true, fleetVehicle: serializeFleetVehicle(req, fv) })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

exports.resubmitFleetVehicle = async (req, res) => {
  try {
    const vendorId = req.user.id
    const fv = await FleetVehicle.findOne({
      _id: req.params.id,
      vendorId
    })

    if (!fv) {
      return res.status(404).json({ success: false, message: 'Fleet vehicle not found' })
    }

    if (fv.approvalStatus !== 'REJECTED' || !fv.allowDocumentResubmit) {
      return res.status(400).json({
        success: false,
        message: 'Resubmit is only allowed for rejected vehicles with re-upload enabled by admin'
      })
    }

    const { missingFields, documents } = collectVehicleDocumentsFromReq(req)
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Vehicle RC, Insurance, Permit, and PUC documents are required',
        missingFields
      })
    }

    fv.documents = documents
    fv.approvalStatus = 'UNDER_APPROVAL'
    fv.submittedAt = new Date()
    fv.approvedAt = null
    fv.rejectedAt = null
    fv.rejectionReason = null
    fv.allowDocumentResubmit = false
    await fv.save()

    return res.json({
      success: true,
      message: 'Fleet vehicle resubmitted for admin approval',
      fleetVehicle: serializeFleetVehicle(req, fv)
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}
