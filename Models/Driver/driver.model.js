const mongoose = require('mongoose')

const vehicleDetailsSchema = new mongoose.Schema(
  {
    make: String,
    model: String,
    year: Number,
    color: String,
    licensePlate: String,
    vehicleType: {
      type: String,
      enum: ['cercaGlide', 'cercaTitan', 'cercaZip', 'auto'],
      default: 'cercaGlide'
    }
  },
  { _id: false }
)

const vehicleDocumentSchema = new mongoose.Schema(
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

const pendingVehicleSchema = new mongoose.Schema(
  {
    ...vehicleDetailsSchema.obj,
    sourceVehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    documents: {
      type: [vehicleDocumentSchema],
      default: []
    },
    approvalStatus: {
      type: String,
      enum: ['UNDER_APPROVAL', 'APPROVED', 'REJECTED'],
      default: 'UNDER_APPROVAL'
    },
    approvalRoutedTo: {
      type: String,
      enum: ['ADMIN', 'VENDOR'],
      required: true
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
    vendorPreApprovedAt: {
      type: Date,
      default: null
    }
  },
  { _id: false }
)

const uploadedDocumentSchema = new mongoose.Schema(
  {
    documentType: {
      type: String,
      trim: true,
      default: null
    },
    documentUrl: {
      type: String,
      required: true
    }
  },
  { _id: false }
)

const driverVehicleSchema = new mongoose.Schema(
  {
    ...vehicleDetailsSchema.obj,
    documents: {
      type: [vehicleDocumentSchema],
      default: []
    },
    approvalStatus: {
      type: String,
      enum: ['UNDER_APPROVAL', 'APPROVED', 'REJECTED'],
      default: 'UNDER_APPROVAL'
    },
    approvalRoutedTo: {
      type: String,
      enum: ['ADMIN', 'VENDOR', null],
      default: null
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
    vendorPreApprovedAt: {
      type: Date,
      default: null
    },
    approvedBy: {
      type: String,
      enum: ['ADMIN', 'VENDOR', null],
      default: null
    },
    isActive: {
      type: Boolean,
      default: false
    }
  },
  { _id: true }
)

const driverApprovalWorkflowSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['PENDING_VENDOR', 'PENDING_ADMIN', 'APPROVED', 'REJECTED'],
      default: 'PENDING_ADMIN'
    },
    routedTo: {
      type: String,
      enum: ['VENDOR', 'ADMIN', null],
      default: 'ADMIN'
    },
    submittedAt: {
      type: Date,
      default: Date.now
    },
    vendorApprovedAt: {
      type: Date,
      default: null
    },
    adminApprovedAt: {
      type: Date,
      default: null
    },
    rejectedAt: {
      type: Date,
      default: null
    },
    rejectedBy: {
      type: String,
      enum: ['VENDOR', 'ADMIN', null],
      default: null
    },
    rejectionReason: {
      type: String,
      default: null
    }
  },
  { _id: false }
)

const driverSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    // unique: true,
    lowercase: true,
    trim: true,
    maxlength: [254, 'Email address must be at most 254 characters'],
    match: [/.+@.+\..+/, 'Please enter a valid email address']
  },
  socketId: {
    type: String
  },
  phone: {
    type: String,
    required: true,
    trim: true,
    match: [/^\d+$/, 'Phone number must contain digits only']
  },
  /** Full URL to profile photo (uploads/driverProfilePics) */
  profilePic: {
    type: String,
    default: null,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: true
    }
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: false
  },
  rejectionReason: {
    type: String,
    default: null
  },
  isBusy: {
    type: Boolean,
    default: false
  },
  intercityEnabled: {
    type: Boolean,
    default: false
  },
  currentRideType: {
    type: String,
    enum: ['normal', 'intercity', 'whole_day', 'custom', null],
    default: null
  },
  currentRideId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ride',
    default: null
  },
  intercityRideCount: {
    type: Number,
    default: 0
  },
  completedStandardRideCount: {
    type: Number,
    default: 0
  },
  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5
  },
  totalRatings: {
    type: Number,
    default: 0
  },
  totalEarnings: {
    type: Number,
    default: 0
  },
  rideRejectionCount: {
    type: Number,
    default: 0
  },
  rideRejectionThreshold: {
    type: Number,
    default: 5
  },
  rideRejectionLastNotifiedAt: {
    type: Date,
    default: null
  },
  currentOnlineSessionStartedAt: {
    type: Date,
    default: null
  },
  totalOnlineMinutes: {
    type: Number,
    default: 0
  },
  bankAccount: {
    accountNumber: String,
    ifscCode: String,
    accountHolderName: String,
    bankName: String,
    accountType: {
      type: String,
      enum: ['SAVINGS', 'CURRENT'],
      default: 'SAVINGS'
    }
  },
  vehicleInfo: {
    type: vehicleDetailsSchema,
    default: null
  },
  rideAccess: {
    allowZip: {
      type: Boolean,
      default: false
    },
    allowGlide: {
      type: Boolean,
      default: false
    },
    updatedAt: {
      type: Date,
      default: null
    }
  },
  pendingVehicleInfo: {
    type: pendingVehicleSchema,
    default: null
  },
  vehicles: {
    type: [driverVehicleSchema],
    default: []
  },
  approvalWorkflow: {
    type: driverApprovalWorkflowSchema,
    default: null
  },
  goTo: {
    isEnabled: {
      type: Boolean,
      default: false
    },
    status: {
      type: String,
      enum: ['OFF', 'ACTIVE', 'STALE'],
      default: 'OFF'
    },
    staleReason: {
      type: String,
      default: null
    },
    homeAddress: {
      type: String,
      trim: true,
      default: ''
    },
    homeLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number],
        default: undefined
      }
    },
    routeOrigin: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number],
        default: undefined
      }
    },
    routePolyline: {
      type: String,
      default: null
    },
    routePoints: {
      type: [[Number]],
      default: []
    },
    routeBounds: {
      north: {
        type: Number,
        default: null
      },
      south: {
        type: Number,
        default: null
      },
      east: {
        type: Number,
        default: null
      },
      west: {
        type: Number,
        default: null
      }
    },
    routeDistanceMeters: {
      type: Number,
      default: null
    },
    routeDurationSeconds: {
      type: Number,
      default: null
    },
    corridorRadiusMeters: {
      type: Number,
      default: 500
    },
    activatedAt: {
      type: Date,
      default: null
    },
    lastRouteRefreshAt: {
      type: Date,
      default: null
    }
  },
  isOnline: {
    type: Boolean,
    default: false
  },
  lastSeen: Date,
  documents: {
    type: [uploadedDocumentSchema],
    default: [],
    required: true
  },
  complianceDocuments: [
    {
      documentType: {
        type: String,
        trim: true,
        required: true
      },
      documentNumber: {
        type: String,
        trim: true,
        default: null
      },
      expiryDate: {
        type: Date,
        required: true
      },
      verifiedAt: {
        type: Date,
        default: null
      },
      status: {
        type: String,
        enum: ['valid', 'expiring_soon', 'expired'],
        default: 'valid'
      },
      alertSentBeforeExpiryAt: {
        type: Date,
        default: null
      },
      alertSentAfterExpiryAt: {
        type: Date,
        default: null
      },
      reverificationDueAt: {
        type: Date,
        default: null
      },
      alertSentBeforeReverificationAt: {
        type: Date,
        default: null
      },
      alertSentAfterReverificationAt: {
        type: Date,
        default: null
      },
      notes: {
        type: String,
        trim: true,
        default: null
      }
    }
  ],
  trustedContacts: {
    type: [
      {
        name: {
          type: String,
          trim: true,
          required: true
        },
        relation: {
          type: String,
          trim: true,
          default: null
        },
        phone: {
          type: String,
          trim: true,
          match: [/^\d+$/, 'Phone number must contain digits only'],
          default: null
        },
        email: {
          type: String,
          trim: true,
          lowercase: true,
          maxlength: [254, 'Email address must be at most 254 characters'],
          match: [/.+@.+\..+/, 'Please enter a valid email address'],
          default: null
        }
      }
    ],
    validate: {
      validator: function (contacts) {
        return !Array.isArray(contacts) || contacts.length <= 5
      },
      message: 'Driver can add up to 5 emergency contacts only'
    },
    default: []
  },

  isPriorityDriver: {
    type: Boolean,
    default: false
  },

  priorityDocument: {
    type: String,
    default: null
  },

  priorityApprovedAt: {
    type: Date,
    default: null
  },

  vendorId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "Vendor",
  default: null
},

  /** OWN = created by vendor; OTHER = linked existing driver; SELF = self-registered / no vendor */
  vendorDriverCategory: {
    type: String,
    enum: ['OWN', 'OTHER', 'SELF'],
    default: null
  },

  assignedFleetVehicleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FleetVehicle',
    default: null
  },

  rides: [
    {
      rideId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Ride'
      },
      status: {
        type: String,
        enum: ['accepted', 'rejected', 'completed', 'cancelled'],
        default: 'pending'
      }
    }
  ],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
})

// Update the `updatedAt` field before saving
driverSchema.pre('save', function (next) {
  this.updatedAt = Date.now()
  next()
})
// Add 2dsphere index for geospatial queries
driverSchema.index({ location: '2dsphere' })
driverSchema.index({ vendorId: 1, vendorDriverCategory: 1 })
const Driver = mongoose.model('Driver', driverSchema)

module.exports = Driver
