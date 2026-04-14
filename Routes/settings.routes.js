const express = require('express')
const {
  getVehicleServices,
  getPublicSettings,
  getSystemSettings,
} = require('../Controllers/adminSettings.controller.js')

const router = express.Router()

router.get('/vehicle-services', getVehicleServices)
router.get('/public', getPublicSettings)
router.get('/system', getSystemSettings)

module.exports = router
