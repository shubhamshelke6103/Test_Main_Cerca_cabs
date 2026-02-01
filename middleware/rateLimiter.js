// middleware/rateLimiter.js
const rateLimit = require('express-rate-limit')
const { redis } = require('../config/redis')
const logger = require('../utils/logger')

// Custom Redis store for express-rate-limit v7
class RedisStore {
  constructor(client, prefix = 'rl:') {
    this.client = client
    this.prefix = prefix
  }

  async increment(key, cb) {
    const redisKey = `${this.prefix}${key}`
    try {
      const count = await this.client.incr(redisKey)
      if (count === 1) {
        // Set expiration on first increment
        await this.client.expire(redisKey, 60) // 60 seconds default
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

// Initialize Redis store if Redis is available
// Note: Redis connection is async, so we check status but don't fail if not ready
let redisStore
try {
  // Check if redis object exists and has a valid status
  if (redis && typeof redis.status === 'string') {
    const status = redis.status.toLowerCase()
    if (status === 'ready' || status === 'connect' || status === 'connecting') {
      try {
        redisStore = new RedisStore(redis, 'rl:')
        logger.info('✅ Rate limiter using Redis store (shared across instances)')
      } catch (storeError) {
        logger.warn('⚠️ Failed to create Redis store, using memory store:', storeError.message)
        redisStore = undefined
      }
    } else {
      logger.warn(`⚠️ Redis status is "${status}", rate limiter will use memory store (not shared across instances)`)
      redisStore = undefined
    }
  } else {
    logger.warn('⚠️ Redis not available, rate limiter will use memory store (not shared across instances)')
    redisStore = undefined
  }
} catch (error) {
  logger.warn('⚠️ Failed to initialize Redis store for rate limiting, using memory store:', error.message)
  redisStore = undefined // Fallback to memory store
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

// Only add store if Redis is available
if (redisStore) {
  apiLimiterConfig.store = redisStore
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

if (redisStore) {
  authLimiterConfig.store = redisStore
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

if (redisStore) {
  readLimiterConfig.store = redisStore
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

if (redisStore) {
  uploadLimiterConfig.store = redisStore
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

