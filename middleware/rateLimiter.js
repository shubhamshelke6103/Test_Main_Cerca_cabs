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

// Helper function to safely create a rate limiter
function createRateLimiter(config, store, name) {
  try {
    // Only add store if it's defined
    if (store) {
      config.store = store
    }
    
    const limiter = rateLimit(config)
    
    if (typeof limiter !== 'function') {
      throw new Error(`${name}: rateLimit did not return a function`)
    }
    
    return limiter
  } catch (error) {
    logger.error(`❌ Failed to create ${name}:`, error.message || error)
    // Return no-op middleware as fallback
    return (req, res, next) => next()
  }
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

const apiLimiter = createRateLimiter(apiLimiterConfig, apiLimiterStore, 'apiLimiter')

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

const authLimiter = createRateLimiter(authLimiterConfig, authLimiterStore, 'authLimiter')

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

const readLimiter = createRateLimiter(readLimiterConfig, readLimiterStore, 'readLimiter')

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

const uploadLimiter = createRateLimiter(uploadLimiterConfig, uploadLimiterStore, 'uploadLimiter')

// Ensure all rate limiters are valid middleware functions
// If any are undefined, replace with no-op middleware
const ensureMiddleware = (middleware, name) => {
  if (typeof middleware === 'function') {
    return middleware
  }
  logger.warn(`⚠️ ${name} is not a function, using no-op middleware`)
  return (req, res, next) => next()
}

module.exports = {
  apiLimiter: ensureMiddleware(apiLimiter, 'apiLimiter'),
  authLimiter: ensureMiddleware(authLimiter, 'authLimiter'),
  readLimiter: ensureMiddleware(readLimiter, 'readLimiter'),
  uploadLimiter: ensureMiddleware(uploadLimiter, 'uploadLimiter')
}

