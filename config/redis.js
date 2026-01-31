// src/config/redis.js
const IORedis = require('ioredis')

const redis = new IORedis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,

  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,

  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  connectTimeout: 10000,
  keepAlive: 10000,

  retryStrategy(times) {
    const delay = Math.min(times * 100, 2000)
    return delay
  }
})

redis.on('connect', () => {
  console.log('🟢 Redis connected')
})

redis.on('error', err => {
  console.error('🔴 Redis error:', err)
})

module.exports = redis
