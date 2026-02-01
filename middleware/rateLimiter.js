// middleware/rateLimiter.js
const rateLimit = require('express-rate-limit')
const { redis } = require('../config/redis')
const logger = require('../utils/logger')

// Custom Redis store for express-rate-limit v7
class RedisStore {
  constructor(client, prefix = 'rl:', windowMs = 60000) {
    this.client = client
    this.prefix = prefix
    this.windowMs = windowMs
    this.windowSeconds = Math.ceil(windowMs / 1000)
  }

  async increment(key, cb) {
    const redisKey = `${this.prefix}${key}`
    try {
      const count = await this.client.incr(redisKey)
      if (count === 1) {
        // Set expiration on first increment based on windowMs
        await this.client.expire(redisKey, this.windowSeconds)
      }
      const ttl = await this.client.ttl(redisKey)
      cb(null, { totalHits: count, resetTime: new Date(Date.now() + ttl * 1000) })
    } catch (err) {
      cb(err)
    }
  }

  async decrement(key) {
    const redisKey = `${this.prefix}${key}`
    await this.client.decr(redisKey)
  }

  async resetKey(key) {
    const redisKey = `${this.prefix}${key}`
    await this.client.del(redisKey)
  }

  async shutdown() {
    // Store doesn't own the connection, so don't close it
  }
}

// Helper function to create RedisStore instances with unique prefixes
// Each rate limiter must have its own store instance (express-rate-limit v7 requirement)
function createRedisStore(prefix, windowMs = 60000) {
  try {
    // Check if redis object exists and has a valid status
    if (redis && typeof redis.status === 'string') {
      const status = redis.status.toLowerCase()
      if (status === 'ready' || status === 'connect' || status === 'connecting') {
        try {
          const store = new RedisStore(redis, prefix, windowMs)
          return store
        } catch (storeError) {
          logger.warn(`⚠️ Failed to create Redis store with prefix "${prefix}", using memory store:`, storeError.message)
          return undefined
        }
      } else {
        logger.warn(`⚠️ Redis status is "${status}", rate limiter with prefix "${prefix}" will use memory store`)
        return undefined
      }
    } else {
      return undefined
    }
  } catch (error) {
    logger.warn(`⚠️ Failed to initialize Redis store with prefix "${prefix}", using memory store:`, error.message)
    return undefined
  }
}

// Check if Redis is available (for logging)
function isRedisAvailable() {
  try {
    if (redis && typeof redis.status === 'string') {
      const status = redis.status.toLowerCase()
      return status === 'ready' || status === 'connect' || status === 'connecting'
    }
    return false
  } catch {
    return false
  }
}

// Create separate RedisStore instances for each rate limiter with unique prefixes
// Each limiter MUST have its own store instance (express-rate-limit v7 requirement)
// Pass windowMs to ensure correct expiration times
const apiLimiterStore = createRedisStore('rl:api:', 60 * 1000) // 1 minute
const authLimiterStore = createRedisStore('rl:auth:', 60 * 1000) // 1 minute
const readLimiterStore = createRedisStore('rl:read:', 60 * 1000) // 1 minute
const uploadLimiterStore = createRedisStore('rl:upload:', 60 * 60 * 1000) // 1 hour

if (isRedisAvailable()) {
  logger.info('✅ Rate limiters using Redis stores (shared across instances)')
} else {
  logger.warn('⚠️ Redis not available, rate limiters will use memory stores (not shared across instances)')
}

// General API rate limiter (100 requests per minute per IP)
const apiLimiterConfig = {
  windowMs: 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}, Path: ${req.path}`)
    res.status(429).json({
      error: 'Too many requests',
      message: 'Too many requests from this IP, please try again later.',
      retryAfter: req.rateLimit?.resetTime ? Math.ceil(req.rateLimit.resetTime / 1000) : 60
    })
  }
}

// Assign unique store instance to API limiter
if (apiLimiterStore) {
  apiLimiterConfig.store = apiLimiterStore
}

let apiLimiter
try {
  apiLimiter = rateLimit(apiLimiterConfig)
  if (typeof apiLimiter !== 'function') {
    throw new Error('rateLimit did not return a function')
  }
} catch (error) {
  logger.error('❌ Failed to create API rate limiter:', error)
  // Create a no-op middleware as fallback
  apiLimiter = (req, res, next) => next()
}

// Strict auth rate limiter (5 requests per minute per IP)
const authLimiterConfig = {
  windowMs: 60 * 1000, // 1 minute
  max: 5, // Limit each IP to 5 requests per windowMs
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful requests
  handler: (req, res) => {
    logger.warn(`Auth rate limit exceeded for IP: ${req.ip}`)
    res.status(429).json({
      error: 'Too many authentication attempts',
      message: 'Too many authentication attempts from this IP, please try again later.',
      retryAfter: req.rateLimit?.resetTime ? Math.ceil(req.rateLimit.resetTime / 1000) : 60
    })
  }
}

// Assign unique store instance to auth limiter
if (authLimiterStore) {
  authLimiterConfig.store = authLimiterStore
}

let authLimiter
try {
  authLimiter = rateLimit(authLimiterConfig)
} catch (error) {
  logger.error('❌ Failed to create auth rate limiter:', error)
  authLimiter = (req, res, next) => next()
}

// Lenient read rate limiter (200 requests per minute per IP)
const readLimiterConfig = {
  windowMs: 60 * 1000, // 1 minute
  max: 200, // Limit each IP to 200 requests per windowMs
  message: 'Too many read requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`Read rate limit exceeded for IP: ${req.ip}, Path: ${req.path}`)
    res.status(429).json({
      error: 'Too many requests',
      message: 'Too many read requests from this IP, please try again later.',
      retryAfter: req.rateLimit?.resetTime ? Math.ceil(req.rateLimit.resetTime / 1000) : 60
    })
  }
}

// Assign unique store instance to read limiter
if (readLimiterStore) {
  readLimiterConfig.store = readLimiterStore
}

let readLimiter
try {
  readLimiter = rateLimit(readLimiterConfig)
} catch (error) {
  logger.error('❌ Failed to create read rate limiter:', error)
  readLimiter = (req, res, next) => next()
}

// Upload rate limiter (10 uploads per hour per IP)
const uploadLimiterConfig = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Limit each IP to 10 uploads per hour
  message: 'Too many uploads, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`Upload rate limit exceeded for IP: ${req.ip}`)
    res.status(429).json({
      error: 'Too many uploads',
      message: 'Too many uploads from this IP, please try again later.',
      retryAfter: req.rateLimit?.resetTime ? Math.ceil(req.rateLimit.resetTime / 1000) : 3600
    })
  }
}

// Assign unique store instance to upload limiter
if (uploadLimiterStore) {
  uploadLimiterConfig.store = uploadLimiterStore
}

let uploadLimiter
try {
  uploadLimiter = rateLimit(uploadLimiterConfig)
} catch (error) {
  logger.error('❌ Failed to create upload rate limiter:', error)
  uploadLimiter = (req, res, next) => next()
}

module.exports = {
  apiLimiter,
  authLimiter,
  readLimiter,
  uploadLimiter
}

