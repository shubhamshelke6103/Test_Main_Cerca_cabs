class AppError extends Error {
  constructor(message, statusCode = 500, options = {}) {
    super(message)

    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = options.code || null
    this.details = options.details
    this.isOperational = options.isOperational !== false

    Error.captureStackTrace(this, this.constructor)
  }
}

module.exports = AppError
