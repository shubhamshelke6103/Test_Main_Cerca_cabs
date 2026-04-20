const mongoose = require('mongoose')

const fleetVehicleDocumentSchema = new mongoose.Schema(
  {
    documentType: {
      type: String,
      enum: ['RC', 'INSURANCE', 'PERMIT', 'PUC'],
      required: true
    },
    documentUrl: {
      type: String,
      required: true
    }
  },
  { _id: false }
)

const fleetVehicleSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
      index: true
    },
    make: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    year: { type: Number, required: true },
    color: { type: String, required: true, trim: true },
    licensePlate: { type: String, required: true, trim: true },
    vehicleType: {
      type: String,
      enum: ['cercaGlide', 'cercaTitan', 'cercaZip', 'auto'],
      default: 'cercaGlide'
    },
    documents: {
      type: [fleetVehicleDocumentSchema],
      default: []
    },
    approvalStatus: {
      type: String,
      enum: ['UNDER_APPROVAL', 'APPROVED', 'REJECTED'],
      default: 'UNDER_APPROVAL'
    },
    submittedAt: {
      type: Date,
      default: Date.now
    },
    approvedAt: {
      type: Date,
      default: null
    },
    rejectedAt: {
      type: Date,
      default: null
    },
    rejectionReason: {
      type: String,
      default: null
    },
    allowDocumentResubmit: {
      type: Boolean,
      default: false
    },
    adminReviewNotes: {
      type: String,
      trim: true,
      default: null
    }
  },
  { timestamps: true }
)

fleetVehicleSchema.index({ vendorId: 1, approvalStatus: 1 })
fleetVehicleSchema.index({ vendorId: 1, licensePlate: 1 }, { unique: true })

fleetVehicleSchema.pre('save', function normalizePlate(next) {
  if (this.licensePlate) {
    this.licensePlate = String(this.licensePlate).trim().toUpperCase()
  }
  next()
})

const FleetVehicle = mongoose.model('FleetVehicle', fleetVehicleSchema)

module.exports = FleetVehicle
