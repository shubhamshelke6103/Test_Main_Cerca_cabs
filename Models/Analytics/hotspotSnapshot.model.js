const mongoose = require('mongoose')

const hotspotSnapshotSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true
    },
    status: {
      type: String,
      default: 'completed'
    },
    gridSize: {
      type: Number,
      default: 0.02
    },
    rangeStart: {
      type: Date,
      required: true
    },
    rangeEnd: {
      type: Date,
      required: true
    },
    zones: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    },
    summary: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    generatedAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
)

hotspotSnapshotSchema.index({ key: 1, generatedAt: -1 })

module.exports = mongoose.model('HotspotSnapshot', hotspotSnapshotSchema)
