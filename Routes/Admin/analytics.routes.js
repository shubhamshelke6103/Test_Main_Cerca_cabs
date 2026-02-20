const express = require('express');
const { getHeatmapData } = require('../../Controllers/Admin/analytics.controller');
const { authenticateAdmin } = require('../../utils/adminAuth');

const router = express.Router();

router.use(authenticateAdmin);
router.get('/analytics/heatmap', getHeatmapData);

module.exports = router;
