// src/config/redis.js
const IORedis = require('ioredis')
const logger = require('../utils/logger')

// Connection state tracking
let isConnected = false
let connectionAttempts = 0
const maxConnectionAttempts = 10

// Redis connection configuration with connection pooling
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: Number(process.env.REDIS_DB) || 0,

  // TLS configuration
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,

  // Connection pooling
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectTimeout: 10000,
  keepAlive: 10000,
  lazyConnect: false,

  // Retry strategy with exponential backoff
  retryStrategy(times) {
    connectionAttempts = times
    if (times > maxConnectionAttempts) {
      logger.error('❌ Redis: Max connection attempts reached, giving up')
      return null // Stop retrying
    }
    const delay = Math.min(times * 100, 2000)
    logger.warn(`🔄 Redis: Retrying connection (attempt ${times}/${maxConnectionAttempts}) in ${delay}ms`)
    return delay
  },

  // Reconnect on error
  reconnectOnError(err) {
    const targetError = 'READONLY'
    if (err.message.includes(targetError)) {
      logger.error('❌ Redis: READONLY error, reconnecting...')
      return true
    }
    return false
  },

  // Enable offline queue for better resilience
  enableOfflineQueue: true,
}

// Create main Redis client
const redis = new IORedis(redisConfig)

// Connection event handlers
redis.on('connect', () => {
  isConnected = true
  connectionAttempts = 0
  logger.info('🟢 Redis connected successfully')
})

redis.on('ready', () => {
  isConnected = true
  logger.info('✅ Redis ready to accept commands')
})

redis.on('error', err => {
  isConnected = false
  logger.error('🔴 Redis error:', {
    message: err.message,
    code: err.code,
    errno: err.errno,
    syscall: err.syscall
  })
})

redis.on('close', () => {
  isConnected = false
  logger.warn('⚠️ Redis connection closed')
})

redis.on('reconnecting', (delay) => {
  logger.info(`🔄 Redis reconnecting in ${delay}ms...`)
})

redis.on('end', () => {
  isConnected = false
  logger.warn('⚠️ Redis connection ended')
})

// Health check function
async function checkRedisHealth() {
  try {
    if (!isConnected) {
      return { healthy: false, error: 'Not connected' }
    }
    const start = Date.now()
    await redis.ping()
    const latency = Date.now() - start
    return {
      healthy: true,
      latency: `${latency}ms`,
      connectionAttempts,
      status: redis.status
    }
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      connectionAttempts,
      status: redis.status
    }
  }
}

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  logger.info('🛑 SIGTERM received, closing Redis connections...')
  await redis.quit()
})

process.on('SIGINT', async () => {
  logger.info('🛑 SIGINT received, closing Redis connections...')
  await redis.quit()
})

module.exports = {
  redis,
  checkRedisHealth,
  getRedisStatus: () => ({
    isConnected,
    status: redis.status,
    connectionAttempts
  })
}
