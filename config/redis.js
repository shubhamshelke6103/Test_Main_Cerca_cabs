const IORedis = require('ioredis')
const logger = require('../utils/logger')

const redis = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: Number(process.env.REDIS_DB) || 0,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
})

redis.on('connect', () => {
  logger.info('🟢 Redis connected')
})

redis.on('error', err => {
  logger.error('🔴 Redis error:', err)
})

redis.on('reconnecting', () => {
  logger.warn('🔄 Redis reconnecting...')
})

redis.on('end', () => {
  logger.warn('🛑 Redis connection ended')
})

module.exports = { redis }
