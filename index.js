// index.js
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const http = require('http')
const multer = require('multer')
const path = require('path')

const logger = require('./utils/logger')
const { initializeSocket } = require('./utils/socket')
const { connectDB } = require('./db')
const mongoose = require('mongoose')

const app = express()
const port = process.env.PORT || 8000
app.set('trust proxy', true)
app.set('trust proxy', 1)

/* =======================
   DATABASE
======================= */
connectDB()

/* =======================
   SERVER & SOCKET
======================= */
const server = http.createServer(app)

// Initialize Socket.IO FIRST
initializeSocket(server)
logger.info('✅ Socket.IO initialized')

/* =======================
   WORKERS
======================= */
// RUN ONLY ON ONE SERVER - Use distributed lock or run on single instance
require('./src/workers/rideBooking.worker')

const initScheduledRideWorker = require('./src/workers/scheduledRide.worker')
const initRideAutoCancelWorker = require('./src/workers/rideAutoCancel.worker')

initScheduledRideWorker()
initRideAutoCancelWorker()

/* =======================
   MIDDLEWARES
======================= */
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
)

app.use(express.static('public'))
app.use('/uploads', express.static('uploads'))
app.use('/images', express.static('uploads/images'))

/* =======================
   MULTER CONFIG
======================= */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname}`),
})

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const fileTypes = /jpeg|jpg|png/
    const extname = fileTypes.test(
      path.extname(file.originalname).toLowerCase()
    )
    const mimeType = fileTypes.test(file.mimetype)

    if (extname && mimeType) cb(null, true)
    else cb(new Error('Only images (jpeg, jpg, png) are allowed'))
  },
})

/* =======================
   ROUTES (ALL COMMONJS)
======================= */
app.use('/users', require('./Routes/User/user.routes'))
app.use('/users', require('./Routes/User/wallet.routes'))
app.use('/users', require('./Routes/User/referral.routes'))
app.use('/users', require('./Routes/User/support.routes'))

app.use('/drivers', require('./Routes/Driver/driver.routes'))
app.use('/drivers', require('./Routes/Driver/earnings.routes'))
app.use('/drivers', require('./Routes/Driver/payout.routes'))
app.use('/drivers/messages', require('./Routes/Driver/message.routes'))
app.use('/drivers', require('./Routes/Driver/rating.routes'))

app.use('/admin', require('./Routes/admin.routes'))
app.use('/admin', require('./Routes/Admin/dashboard.routes'))
app.use('/admin', require('./Routes/Admin/users.routes'))
app.use('/admin', require('./Routes/Admin/drivers.routes'))
app.use('/admin', require('./Routes/Admin/rides.routes'))
app.use('/admin', require('./Routes/Admin/payments.routes'))
app.use('/admin/support', require('./Routes/Admin/support.routes'))

app.use('/settings', require('./Routes/admin.routes'))
app.use('/coupons', require('./Routes/coupon.routes'))
app.use('/address', require('./Routes/User/address.route'))
app.use('/notifications', require('./Routes/User/notification.routes'))
app.use('/emergencies', require('./Routes/User/emergency.routes'))
app.use('/api/v1/payment', require('./Routes/payment.route'))
app.use('/api/google-maps', require('./Routes/googleMaps.routes'))
app.use('/api/offers', require('./Routes/User/offer.routes'))
app.use('/api/rides', require('./Routes/ride.routes'))
// Mount ride routes at /rides as well for backward compatibility with frontend
app.use('/rides', require('./Routes/ride.routes'))
// Mount shared ride page route at root level for easy access
app.use('/', require('./Routes/ride.routes'))

/* =======================
   HEALTH & UPLOAD
======================= */
app.get('/', (req, res) => {
  res.send('Welcome to Cerca API! Demo')
})

// ============================
// ADMIN UTILITIES (Redis Cleanup)
// ============================
// Admin endpoint to clear stale Redis data for a specific ride
app.post('/admin/redis/clear-ride/:rideId', async (req, res) => {
  try {
    // TODO: Add admin authentication middleware
    const { rideId } = req.params
    const { clearRideRedisKeys } = require('./utils/ride_booking_functions')
    
    const result = await clearRideRedisKeys(rideId)
    
    if (result.cleared) {
      res.status(200).json({
        success: true,
        message: `Redis keys cleared for ride ${rideId}`,
        deletedCount: result.deletedCount,
        errors: result.errors
      })
    } else {
      res.status(400).json({
        success: false,
        message: `Failed to clear Redis keys for ride ${rideId}`,
        error: result.error
      })
    }
  } catch (error) {
    logger.error('Error clearing Redis keys:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// Admin endpoint to clear stale Redis data for a specific rider
app.post('/admin/redis/clear-rider/:riderId', async (req, res) => {
  try {
    // TODO: Add admin authentication middleware
    const { riderId } = req.params
    const { checkAndCleanStaleRideLocks } = require('./utils/ride_booking_functions')
    
    const result = await checkAndCleanStaleRideLocks(riderId)
    
    res.status(200).json({
      success: true,
      message: `Stale lock check completed for rider ${riderId}`,
      cleaned: result.cleaned,
      reason: result.reason,
      activeRideIds: result.activeRideIds || []
    })
  } catch (error) {
    logger.error('Error checking stale locks:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.')
  }

  res.status(200).json({
    message: 'File uploaded successfully',
    file: req.file,
  })
})

/* =======================
   START SERVER
======================= */
server.listen(port, () => {
  logger.info(`🚀 Server running on http://localhost:${port}`)
})
