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
const { apiLimiter, authLimiter, readLimiter, uploadLimiter } = require('./middleware/rateLimiter')

const app = express()
const port = process.env.PORT || 8000
app.set('trust proxy', true)
app.set('trust proxy', 1)

/* =======================
   DATABASE
======================= */
connectDB().catch(err => {
  logger.error('Failed to connect to database:', err)
  process.exit(1)
})

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
// Rate limiting - apply general API limiter to all routes
app.use(apiLimiter)

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
// Auth routes with strict rate limiting
app.use('/users/login', authLimiter)
app.use('/users', require('./Routes/User/user.routes'))
app.use('/users', require('./Routes/User/wallet.routes'))
app.use('/users', require('./Routes/User/referral.routes'))

app.use('/drivers', require('./Routes/Driver/driver.routes'))
app.use('/drivers', require('./Routes/Driver/earnings.routes'))
app.use('/drivers', require('./Routes/Driver/payout.routes'))
app.use('/drivers', require('./Routes/Driver/message.routes'))
app.use('/drivers', require('./Routes/Driver/rating.routes'))

app.use('/admin', require('./Routes/admin.routes'))
app.use('/admin', require('./Routes/Admin/dashboard.routes'))
app.use('/admin', require('./Routes/Admin/users.routes'))
app.use('/admin', require('./Routes/Admin/drivers.routes'))
app.use('/admin', require('./Routes/Admin/rides.routes'))
app.use('/admin', require('./Routes/Admin/payments.routes'))

app.use('/settings', require('./Routes/admin.routes'))
app.use('/coupons', require('./Routes/coupon.routes'))
app.use('/address', require('./Routes/User/address.route'))
app.use('/notifications', require('./Routes/User/notification.routes'))
app.use('/emergencies', require('./Routes/User/emergency.routes'))
app.use('/api/v1/payment', require('./Routes/payment.route'))
app.use('/api/google-maps', require('./Routes/googleMaps.routes'))
app.use('/api/offers', require('./Routes/User/offer.routes'))
app.use('/rides', require('./Routes/ride.routes'))

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

app.post('/upload', uploadLimiter, upload.single('image'), (req, res) => {
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
