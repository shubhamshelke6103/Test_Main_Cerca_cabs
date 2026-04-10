const logger = require('../utils/logger')
const { buildErrorResponse, normalizeError } = require('../utils/errors/normalizeError')

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error)
  }

  const normalizedError = normalizeError(error)
  const statusCode = normalizedError.statusCode || 500

  logger.error(normalizedError.message, {
    code: normalizedError.code,
    statusCode,
    method: req.method,
    path: req.originalUrl,
    stack: normalizedError.stack,
    details: normalizedError.details,
  })

  res.status(statusCode).json(buildErrorResponse(normalizedError))
}

module.exports = errorHandler
