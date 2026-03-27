const logger = require('../../utils/logger');
const { aggregateHeatmapDocs, buildTieredZones } = require('../../utils/heatmap.service');
const {
  HOTSPOT_SNAPSHOT_KEY,
  buildHotspotSnapshot,
  getLatestHotspotSnapshot,
} = require('../../utils/hotspotSnapshot.service');

const MAX_LOOKBACK_DAYS = 30;
const MAX_ZONES = 300;
const DRIVER_HEATMAP_CACHE_TTL_MS = 2 * 60 * 1000;
const HEATMAP_ALLOWED_STATUSES = new Set(['completed', 'accepted', 'arrived', 'ongoing', 'inProgress']);

const responseCache = new Map();
const DRIVER_HEATMAP_ENABLED = process.env.DRIVER_HEATMAP_ENABLED !== 'false';

const sanitizeDateRange = (startDateRaw, endDateRaw) => {
  const now = new Date();
  const earliest = new Date(now.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  let startDate = startDateRaw ? new Date(startDateRaw) : earliest;
  let endDate = endDateRaw ? new Date(endDateRaw) : now;

  if (Number.isNaN(startDate.getTime())) startDate = earliest;
  if (Number.isNaN(endDate.getTime())) endDate = now;
  if (startDate < earliest) startDate = earliest;
  if (endDate > now) endDate = now;
  if (startDate > endDate) startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);

  return { startDate, endDate };
};

const buildCacheKey = ({ startDate, endDate, gridSize, status }) =>
  `${startDate.toISOString()}|${endDate.toISOString()}|${gridSize}|${status}`;

const setNoStoreCacheHeaders = (res) => {
  // Driver payload changes frequently and is bounded; prevent stale proxy replay.
  res.set('Cache-Control', 'private, max-age=0, must-revalidate');
};

const getDriverHeatmap = async (req, res) => {
  try {
    if (!DRIVER_HEATMAP_ENABLED) {
      return res.status(503).json({ message: 'Driver heatmap is currently disabled' });
    }
    const { startDate: startDateRaw, endDate: endDateRaw, gridSize, status: statusRaw } = req.query;
    const status = HEATMAP_ALLOWED_STATUSES.has(statusRaw) ? statusRaw : 'completed';
    const { startDate, endDate } = sanitizeDateRange(startDateRaw, endDateRaw);
    const cacheKey = buildCacheKey({ startDate, endDate, gridSize: gridSize || 'default', status });

    const cached = responseCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < DRIVER_HEATMAP_CACHE_TTL_MS) {
      setNoStoreCacheHeaders(res);
      return res.status(200).json(cached.payload);
    }

    const fetchStartedAt = Date.now();
    const { docs, safeGridSize } = await aggregateHeatmapDocs({
      status,
      startDate,
      endDate,
      gridSize,
    });
    const payload = buildTieredZones(docs, { includeLow: false, maxZones: MAX_ZONES });
    payload.meta = {
      gridSize: safeGridSize,
      range: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      maxZones: MAX_ZONES,
      cacheTtlMs: DRIVER_HEATMAP_CACHE_TTL_MS,
    };

    responseCache.set(cacheKey, { payload, createdAt: Date.now() });
    logger.info(
      `[driver_heatmap] status=${status} zones=${payload.zones.length} latencyMs=${Date.now() - fetchStartedAt}`
    );

    setNoStoreCacheHeaders(res);
    return res.status(200).json(payload);
  } catch (error) {
    logger.error('Error fetching driver heatmap data:', error);
    return res.status(500).json({ message: 'Error fetching driver heatmap data', error: error.message });
  }
};

const getDriverHotspotSnapshot = async (req, res) => {
  try {
    if (!DRIVER_HEATMAP_ENABLED) {
      return res.status(503).json({ message: 'Driver heatmap is currently disabled' });
    }
    const status = HEATMAP_ALLOWED_STATUSES.has(req.query.status) ? req.query.status : 'completed';
    let snapshot = await getLatestHotspotSnapshot(HOTSPOT_SNAPSHOT_KEY);

    if (!snapshot) {
      snapshot = await buildHotspotSnapshot({ status });
      snapshot = snapshot.toObject ? snapshot.toObject() : snapshot;
    }

    return res.status(200).json({
      zones: snapshot.zones || [],
      summary: snapshot.summary || {},
      meta: {
        source: 'snapshot',
        generatedAt: snapshot.generatedAt,
        range: {
          startDate: snapshot.rangeStart,
          endDate: snapshot.rangeEnd,
        },
        gridSize: snapshot.gridSize,
      },
    });
  } catch (error) {
    logger.error('Error fetching driver hotspot snapshot:', error);
    return res.status(500).json({ message: 'Error fetching driver hotspot snapshot', error: error.message });
  }
};

module.exports = {
  getDriverHeatmap,
  getDriverHotspotSnapshot,
};
