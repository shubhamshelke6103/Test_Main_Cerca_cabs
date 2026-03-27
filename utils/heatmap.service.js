const Ride = require('../Models/Driver/ride.model');

const DEFAULT_GRID_SIZE = 0.02;
const MIN_GRID_SIZE = 0.005;
const MAX_GRID_SIZE = 0.1;

const clampGridSize = (value) => {
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) return DEFAULT_GRID_SIZE;
  return Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE, parsed));
};

const buildHeatmapMatch = ({ status, startDate, endDate }) => {
  const match = {
    status,
    'pickupLocation.coordinates': { $exists: true, $size: 2 },
  };

  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }

  return match;
};

const aggregateHeatmapDocs = async ({ status = 'completed', startDate, endDate, gridSize }) => {
  const safeGridSize = clampGridSize(gridSize);
  const match = buildHeatmapMatch({ status, startDate, endDate });

  const docs = await Ride.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          lat: {
            $multiply: [
              { $floor: { $divide: [{ $arrayElemAt: ['$pickupLocation.coordinates', 1] }, safeGridSize] } },
              safeGridSize,
            ],
          },
          lng: {
            $multiply: [
              { $floor: { $divide: [{ $arrayElemAt: ['$pickupLocation.coordinates', 0] }, safeGridSize] } },
              safeGridSize,
            ],
          },
        },
        rideCount: { $sum: 1 },
      },
    },
    { $sort: { rideCount: -1 } },
  ]);

  return { docs, safeGridSize };
};

const buildTieredZones = (docs, { includeLow = true, maxZones } = {}) => {
  const boundedDocs = typeof maxZones === 'number' && maxZones > 0 ? docs.slice(0, maxZones) : docs;
  const totalRides = boundedDocs.reduce((sum, d) => sum + d.rideCount, 0);

  if (boundedDocs.length === 0) {
    return {
      zones: [],
      summary: { totalRides: 0, highThreshold: 0, mediumThreshold: 0 },
    };
  }

  const counts = boundedDocs.map((d) => d.rideCount).sort((a, b) => a - b);
  const p66Index = Math.floor(counts.length * 0.66);
  const p33Index = Math.floor(counts.length * 0.33);
  const highThreshold = counts[p66Index] ?? counts[counts.length - 1] ?? 0;
  const mediumThreshold = counts[p33Index] ?? counts[0] ?? 0;

  const zones = boundedDocs
    .map((d) => {
      let tier = 'low';
      if (d.rideCount >= highThreshold) tier = 'high';
      else if (d.rideCount >= mediumThreshold) tier = 'medium';

      return {
        lat: d._id.lat,
        lng: d._id.lng,
        rideCount: d.rideCount,
        tier,
      };
    })
    .filter((z) => includeLow || z.tier !== 'low');

  return {
    zones,
    summary: {
      totalRides,
      highThreshold,
      mediumThreshold,
    },
  };
};

module.exports = {
  clampGridSize,
  aggregateHeatmapDocs,
  buildTieredZones,
};
