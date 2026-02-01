// config/envValidator.js
const logger = require('../utils/logger')

// Required environment variables
const requiredEnvVars = [
  // 'MONGODB_URI', // Optional if using default
  // 'REDIS_HOST', // Optional if using default
]

// Recommended environment variables (warnings only)
const recommendedEnvVars = [
  'MONGODB_URI',
  'REDIS_HOST',
  'REDIS_PORT',
  'ENABLE_WORKERS'
]

function validateEnvironment() {
  const missing = []
  const warnings = []

  // Check required variables
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      missing.push(envVar)
    }
  }

  // Check recommended variables
  for (const envVar of recommendedEnvVars) {
    if (!process.env[envVar]) {
      warnings.push(envVar)
    }
  }

  // Fail if required variables are missing
  if (missing.length > 0) {
    logger.error('❌ Missing required environment variables:')
    missing.forEach(envVar => {
      logger.error(`   - ${envVar}`)
    })
    logger.error('Please set these variables before starting the server.')
    process.exit(1)
  }

  // Warn about recommended variables
  if (warnings.length > 0) {
    logger.warn('⚠️  Recommended environment variables not set:')
    warnings.forEach(envVar => {
      logger.warn(`   - ${envVar}`)
    })
    logger.warn('The application will use default values, which may not be suitable for production.')
  }

  // Validate specific values
  if (process.env.ENABLE_WORKERS && process.env.ENABLE_WORKERS !== 'true' && process.env.ENABLE_WORKERS !== 'false') {
    logger.warn('⚠️  ENABLE_WORKERS should be "true" or "false", defaulting to false')
    process.env.ENABLE_WORKERS = 'false'
  }

  if (process.env.PORT && isNaN(Number(process.env.PORT))) {
    logger.error('❌ PORT must be a number')
    process.exit(1)
  }

  if (process.env.REDIS_PORT && isNaN(Number(process.env.REDIS_PORT))) {
    logger.error('❌ REDIS_PORT must be a number')
    process.exit(1)
  }

  logger.info('✅ Environment variables validated')
}

module.exports = { validateEnvironment }

