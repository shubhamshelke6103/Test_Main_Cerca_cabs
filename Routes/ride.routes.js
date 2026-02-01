// routes/ride.routes.js
const express = require('express');
const {
  createRide,
  getAllRides,
  getRideById,
  updateRide,
  deleteRide,
  getRidesByUserId,
  getRidesByDriverId,
  searchRide,
  calculateFare,
  calculateAllFares
} = require('../Controllers/User/ride.controller');

const router = express.Router();

// Create a new ride
// POST /rides
router.post('/', createRide);

// Calculate fare
// POST /rides/calculate-fare
router.post('/calculate-fare', calculateFare);

// Calculate fare for all vehicle types
// POST /rides/calculate-all-fares
router.post('/calculate-all-fares', calculateAllFares);

// Get all rides
// GET /rides
router.get('/', getAllRides);

// Get a single ride by ID
// GET /rides/:id
router.get('/:id', getRideById);

// Update a ride by ID
// PUT /rides/:id
router.put('/:id', updateRide);

// Delete a ride by ID
// DELETE /rides/:id
router.delete('/:id', deleteRide);

// Get rides for a specific user
// GET /rides/user/:userId
router.get('/user/:userId', getRidesByUserId);

// Get rides for a specific driver
// GET /rides/driver/:driverId
router.get('/driver/:driverId', getRidesByDriverId);

// Search for nearby drivers for a user (your controller uses req.params.id and req.body.pickupLocation)
// POST /rides/search/:id
router.post('/search/:id', searchRide);

module.exports = router;
