const express = require('express')
const router = express.Router()
const { authenticateAdmin } = require('../../utils/adminAuth')
const fleetVehicleController = require('../../Controllers/Admin/fleetVehicle.controller')

router.get('/inventory', authenticateAdmin, fleetVehicleController.listVehicleInventory)
router.get('/', authenticateAdmin, fleetVehicleController.listFleetVehicles)
router.get('/:id', authenticateAdmin, fleetVehicleController.getFleetVehicleAdmin)
router.patch('/:id/approve', authenticateAdmin, fleetVehicleController.approveFleetVehicle)
router.patch('/:id/reject', authenticateAdmin, fleetVehicleController.rejectFleetVehicle)

module.exports = router
