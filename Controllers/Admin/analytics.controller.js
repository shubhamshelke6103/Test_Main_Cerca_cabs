const Ride = require('../../Models/Driver/ride.model');
const logger = require('../../utils/logger');

/**
 * GET /admin/analytics/heatmap
 * Aggregates rides by pickup location into grid zones, returns zone data for heatmap visualization.
 * Query params: startDate, endDate, gridSize (default 0.02), status (default 'completed')
 */
const getHeatmapData = async (req, res) => {
  try {
    const { startDate, endDate, gridSize: gridSizeParam, status: statusParam } = req.query;

    const gridSize = Math.max(0.005, Math.min(0.1, parseFloat(gridSizeParam) || 0.02));
    const status = statusParam || 'completed';

    const match = {
      status,
      'pickupLocation.coordinates': { $exists: true, $size: 2 },
    };

    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) match.createdAt.$lte = new Date(endDate);
    }

    const docs = await Ride.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            lat: {
              $multiply: [
                { $floor: { $divide: [{ $arrayElemAt: ['$pickupLocation.coordinates', 1] }, gridSize] } },
                gridSize,
              ],
            },
            lng: {
              $multiply: [
                { $floor: { $divide: [{ $arrayElemAt: ['$pickupLocation.coordinates', 0] }, gridSize] } },
                gridSize,
              ],
            },
          },
          rideCount: { $sum: 1 },
        },
      },
      { $sort: { rideCount: -1 } },
    ]);

    const totalRides = docs.reduce((sum, d) => sum + d.rideCount, 0);

    if (docs.length === 0) {
      return res.status(200).json({
        zones: [],
        summary: { totalRides: 0, highThreshold: 0, mediumThreshold: 0 },
      });
    }

    const counts = docs.map((d) => d.rideCount).sort((a, b) => a - b);
    const p66Index = Math.floor(counts.length * 0.66);
    const p33Index = Math.floor(counts.length * 0.33);
    const highThreshold = counts[p66Index] ?? counts[counts.length - 1] ?? 0;
    const mediumThreshold = counts[p33Index] ?? counts[0] ?? 0;

    const zones = docs.map((d) => {
      let tier = 'low';
      if (d.rideCount >= highThreshold) tier = 'high';
      else if (d.rideCount >= mediumThreshold) tier = 'medium';

      return {
        lat: d._id.lat,
        lng: d._id.lng,
        rideCount: d.rideCount,
        tier,
      };
    });

    res.status(200).json({
      zones,
      summary: {
        totalRides,
        highThreshold,
        mediumThreshold,
      },
    });
  } catch (error) {
    logger.error('Error fetching heatmap data:', error);
    res.status(500).json({ message: 'Error fetching heatmap data', error: error.message });
  }
};

module.exports = {
  getHeatmapData,
};
