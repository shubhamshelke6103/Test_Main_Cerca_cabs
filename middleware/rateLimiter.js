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
let redisStore
try {
  if (redis && (redis.status === 'ready' || redis.status === 'connect')) {
    redisStore = new RedisStore(redis, 'rl:')
    logger.info('✅ Rate limiter using Redis store (shared across instances)')
  } else {
    logger.warn('⚠️ Redis not ready, rate limiter will use memory store (not shared across instances)')
    redisStore = undefined // Fallback to memory store
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

const apiLimiter = rateLimit(apiLimiterConfig)

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

const authLimiter = rateLimit(authLimiterConfig)

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

const readLimiter = rateLimit(readLimiterConfig)

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

const uploadLimiter = rateLimit(uploadLimiterConfig)

module.exports = {
  apiLimiter,
  authLimiter,
  readLimiter,
  uploadLimiter
}

