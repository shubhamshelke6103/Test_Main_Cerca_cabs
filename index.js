// index.js
require('dotenv').config() // MUST BE FIRST

// Validate environment variables
const { validateEnvironment } = require('./config/envValidator')
validateEnvironment()

const express = require('express')
const cors = require('cors')
const http = require('http')
const multer = require('multer')
const path = require('path')

const logger = require('./utils/logger')
const { initializeSocket, getSocketHealth } = require('./utils/socket')
const { connectDB, checkMongoDBHealth } = require('./db')
const { redis, checkRedisHealth } = require('./config/redis')
// Rate limiting temporarily disabled - will be re-enabled later
// const { apiLimiter, authLimiter, readLimiter, uploadLimiter } = require('./middleware/rateLimiter')
const mongoose = require('mongoose')

const app = express()
const port = process.env.PORT || 8000
app.set('trust proxy', true)
app.set('trust proxy', 1)

/* =======================
   DATABASE
======================= */
// Connect to database and wait for connection before starting server
(async () => {
  try {
    await connectDB()
    logger.info('✅ Database connection established')
  } catch (err) {
    logger.error('❌ Failed to connect to database:', err)
    process.exit(1)
  }
})()

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
// Worker configuration: Only run workers on one instance to prevent duplicate processing
// Set ENABLE_WORKERS=true on ONE instance only, or use distributed lock
const enableWorkers = process.env.ENABLE_WORKERS === 'true'

if (enableWorkers) {
  logger.info('🔧 Workers enabled on this instance')
  
  // BullMQ worker (auto-starts on require)
  try {
    require('./src/workers/rideBooking.worker')
    logger.info('✅ Ride Booking Worker initialized')
  } catch (error) {
    logger.error('❌ Ride Booking Worker failed', error)
  }

  // Cron-based workers (need explicit init)
  const initScheduledRideWorker = require('./src/workers/scheduledRide.worker')
  const initRideAutoCancelWorker = require('./src/workers/rideAutoCancel.worker')

  try {
    initScheduledRideWorker()
    logger.info('✅ Scheduled Ride Worker initialized')
  } catch (error) {
    logger.error('❌ Scheduled Ride Worker failed', error)
  }

  try {
    initRideAutoCancelWorker()
    logger.info('✅ Ride Auto-Cancellation Worker initialized')
  } catch (error) {
    logger.error('❌ Ride Auto-Cancellation Worker failed', error)
  }
} else {
  logger.info('⚠️ Workers disabled on this instance (set ENABLE_WORKERS=true to enable)')
}

/* =======================
   MIDDLEWARES
======================= */
// Rate limiting temporarily disabled - will be re-enabled later
// if (apiLimiter && typeof apiLimiter === 'function') {
//   app.use(apiLimiter)
// } else {
//   logger.warn('⚠️ apiLimiter is not available, skipping rate limiting')
// }

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
// Helper function to safely require and use routes
function useRoute(path, routePath) {
  try {
    const route = require(routePath)
    if (route && typeof route === 'function') {
      app.use(path, route)
      logger.info(`✅ Route loaded: ${path}`)
    } else {
      logger.error(`❌ Route ${routePath} did not export a valid router - got ${typeof route}`)
    }
  } catch (error) {
    logger.error(`❌ Failed to load route ${routePath}:`, error.message || error)
    // Don't crash the server, just log the error
  }
}

// Auth routes - rate limiting temporarily disabled
// if (authLimiter && typeof authLimiter === 'function') {
//   app.use('/users/login', authLimiter)
// }

// Load routes with error handling
try {
  useRoute('/users', './Routes/User/user.routes')
  useRoute('/users', './Routes/User/wallet.routes')
  useRoute('/users', './Routes/User/referral.routes')

  useRoute('/drivers', './Routes/Driver/driver.routes')
  useRoute('/drivers', './Routes/Driver/earnings.routes')
  useRoute('/drivers', './Routes/Driver/payout.routes')
  useRoute('/drivers', './Routes/Driver/message.routes')
  useRoute('/drivers', './Routes/Driver/rating.routes')

  useRoute('/admin', './Routes/admin.routes')
  useRoute('/admin', './Routes/Admin/dashboard.routes')
  useRoute('/admin', './Routes/Admin/users.routes')
  useRoute('/admin', './Routes/Admin/drivers.routes')
  useRoute('/admin', './Routes/Admin/rides.routes')
  useRoute('/admin', './Routes/Admin/payments.routes')

  useRoute('/settings', './Routes/admin.routes')
  useRoute('/coupons', './Routes/coupon.routes')
  useRoute('/address', './Routes/User/address.route')
  useRoute('/notifications', './Routes/User/notification.routes')
  useRoute('/emergencies', './Routes/User/emergency.routes')
  useRoute('/api/v1/payment', './Routes/payment.route')
  useRoute('/api/google-maps', './Routes/googleMaps.routes')
  useRoute('/api/offers', './Routes/User/offer.routes')
  useRoute('/rides', './Routes/ride.routes')
} catch (error) {
  logger.error('❌ Error loading routes:', error.message || error)
  // Continue anyway - server should still start
}

/* =======================
   HEALTH & UPLOAD
======================= */
app.get('/', (req, res) => {
  res.send('Welcome to Cerca API! Demo')
})

// Enhanced health check endpoint
app.get('/health', async (req, res) => {
  try {
    const [redisHealth, mongoHealth, socketHealth] = await Promise.all([
      checkRedisHealth(),
      checkMongoDBHealth(),
      Promise.resolve(getSocketHealth())
    ])

    const allHealthy = redisHealth.healthy && mongoHealth.healthy

    res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        redis: redisHealth,
        mongodb: mongoHealth,
        socket: socketHealth
      }
    })
  } catch (error) {
    logger.error('Health check error:', error)
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    })
  }
})

// Individual health check endpoints
app.get('/health/redis', async (req, res) => {
  try {
    const health = await checkRedisHealth()
    res.status(health.healthy ? 200 : 503).json(health)
  } catch (error) {
    res.status(503).json({ healthy: false, error: error.message })
  }
})

app.get('/health/mongodb', async (req, res) => {
  try {
    const health = await checkMongoDBHealth()
    res.status(health.healthy ? 200 : 503).json(health)
  } catch (error) {
    res.status(503).json({ healthy: false, error: error.message })
  }
})

app.get('/health/socket', (req, res) => {
  try {
    const health = getSocketHealth()
    res.status(200).json(health)
  } catch (error) {
    res.status(503).json({ healthy: false, error: error.message })
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
// Wait for MongoDB connection before starting server
mongoose.connection.once('connected', () => {
  server.listen(port, () => {
    logger.info(`🚀 Server running on http://localhost:${port}`)
  })
})

// If already connected, start server immediately
if (mongoose.connection.readyState === 1) {
  server.listen(port, () => {
    logger.info(`🚀 Server running on http://localhost:${port}`)
  })
}
