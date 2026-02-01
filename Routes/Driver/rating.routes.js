const express = require('express');
const {
    submitRating,
    getRatingsForEntity,
    getRatingByRide,
    getRatingStats,
    deleteRating,
} = require('../../Controllers/Driver/rating.controller.js');

const router = express.Router();

// Submit a rating
// POST /drivers/ratings
router.post('/ratings', submitRating);

// Get ratings for a specific entity (Driver or User)
// GET /drivers/ratings/Driver/DRIVER_ID or /drivers/ratings/User/USER_ID
router.get('/ratings/:entityModel/:entityId', getRatingsForEntity);

// Get rating stats for an entity
// GET /drivers/ratings/Driver/DRIVER_ID/stats
router.get('/ratings/:entityModel/:entityId/stats', getRatingStats);

// Get rating for a specific ride
// GET /drivers/ratings/ride/:rideId
router.get('/ratings/ride/:rideId', getRatingByRide);

// Delete a rating (admin only)
// DELETE /drivers/ratings/:id
router.delete('/ratings/:id', deleteRating);

module.exports = router;

