const logger = require('../../utils/logger');
const { aggregateHeatmapDocs, buildTieredZones } = require('../../utils/heatmap.service');

/**
 * GET /admin/analytics/heatmap
 * Aggregates rides by pickup location into grid zones, returns zone data for heatmap visualization.
 * Query params: startDate, endDate, gridSize (default 0.02), status (default 'completed')
 */
const getHeatmapData = async (req, res) => {
  try {
    const { startDate, endDate, gridSize: gridSizeParam, status: statusParam } = req.query;
    const status = statusParam || 'completed';
    const { docs } = await aggregateHeatmapDocs({
      startDate,
      endDate,
      gridSize: gridSizeParam,
      status,
    });
    const response = buildTieredZones(docs, { includeLow: true });

    res.status(200).json(response);
  } catch (error) {
    logger.error('Error fetching heatmap data:', error);
    res.status(500).json({ message: 'Error fetching heatmap data', error: error.message });
  }
};

module.exports = {
  getHeatmapData,
};
