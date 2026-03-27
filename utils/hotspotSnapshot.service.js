const HotspotSnapshot = require('../Models/Analytics/hotspotSnapshot.model')
const { aggregateHeatmapDocs, buildTieredZones, clampGridSize } = require('./heatmap.service')
const logger = require('./logger')

const HOTSPOT_SNAPSHOT_KEY = 'global'
const HOTSPOT_INTERVAL_MINUTES = Number(process.env.HOTSPOT_SNAPSHOT_INTERVAL_MINUTES || 20)
const HOTSPOT_LOOKBACK_DAYS = Number(process.env.HOTSPOT_LOOKBACK_DAYS || 7)
const HOTSPOT_MAX_ZONES = Number(process.env.HOTSPOT_MAX_ZONES || 300)

const getSnapshotWindow = () => {
  const endDate = new Date()
  const startDate = new Date(
    endDate.getTime() - HOTSPOT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  )
  return { startDate, endDate }
}

const buildHotspotSnapshot = async ({ key = HOTSPOT_SNAPSHOT_KEY, status = 'completed', gridSize = 0.02 } = {}) => {
  const { startDate, endDate } = getSnapshotWindow()
  const { docs, safeGridSize } = await aggregateHeatmapDocs({
    status,
    startDate,
    endDate,
    gridSize: clampGridSize(gridSize)
  })
  const payload = buildTieredZones(docs, { includeLow: false, maxZones: HOTSPOT_MAX_ZONES })

  const snapshot = await HotspotSnapshot.findOneAndUpdate(
    { key },
    {
      $set: {
        key,
        status,
        gridSize: safeGridSize,
        rangeStart: startDate,
        rangeEnd: endDate,
        zones: payload.zones,
        summary: payload.summary,
        generatedAt: new Date()
      }
    },
    { upsert: true, new: true }
  )

  logger.info(
    `[hotspot_snapshot] key=${key} zones=${payload.zones.length} intervalMinutes=${HOTSPOT_INTERVAL_MINUTES}`
  )
  return snapshot
}

const getLatestHotspotSnapshot = async (key = HOTSPOT_SNAPSHOT_KEY) =>
  HotspotSnapshot.findOne({ key }).lean()

module.exports = {
  HOTSPOT_INTERVAL_MINUTES,
  HOTSPOT_SNAPSHOT_KEY,
  buildHotspotSnapshot,
  getLatestHotspotSnapshot
}
