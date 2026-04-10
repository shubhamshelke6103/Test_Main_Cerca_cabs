const mongoose = require('mongoose')
const multer = require('multer')

const AppError = require('./AppError')

const isProduction = process.env.NODE_ENV === 'production'

function normalizeMongooseValidationError(error) {
  const details = Object.values(error.errors || {}).map(item => ({
    field: item.path,
    message: item.message,
    value: item.value,
  }))

  return new AppError('Validation failed', 400, {
    code: 'VALIDATION_ERROR',
    details,
  })
}

function normalizeDuplicateKeyError(error) {
  const fields = Object.keys(error.keyValue || {})
  const details = fields.map(field => ({
    field,
    value: error.keyValue[field],
  }))

  return new AppError('Duplicate value found', 409, {
    code: 'DUPLICATE_KEY',
    details,
  })
}

function normalizeCastError(error) {
  return new AppError(`Invalid ${error.path}`, 400, {
    code: 'INVALID_IDENTIFIER',
    details: {
      field: error.path,
      value: error.value,
      kind: error.kind,
    },
  })
}

function normalizeJwtError(error) {
  if (error.name === 'TokenExpiredError') {
    return new AppError('Token expired', 401, {
      code: 'TOKEN_EXPIRED',
    })
  }

  return new AppError('Invalid token', 401, {
    code: 'INVALID_TOKEN',
  })
}

function normalizeMulterError(error) {
  const errorMap = {
    FILE_TOO_LARGE: {
      statusCode: 413,
      message: 'File size exceeds the allowed limit',
      code: 'FILE_TOO_LARGE',
    },
    LIMIT_FILE_COUNT: {
      statusCode: 413,
      message: 'Too many files uploaded',
      code: 'LIMIT_FILE_COUNT',
    },
    LIMIT_PART_COUNT: {
      statusCode: 413,
      message: 'Too many fields in request',
      code: 'LIMIT_PART_COUNT',
    },
    LIMIT_UNEXPECTED_FILE: {
      statusCode: 400,
      message: 'Unexpected file field',
      code: 'LIMIT_UNEXPECTED_FILE',
    },
  }

  const normalized = errorMap[error.code] || {
    statusCode: 400,
    message: 'File upload error',
    code: 'MULTER_ERROR',
  }

  return new AppError(normalized.message, normalized.statusCode, {
    code: normalized.code,
    details: {
      originalMessage: error.message,
      field: error.field,
    },
  })
}

function normalizeError(error) {
  if (!error) {
    return new AppError('Internal server error', 500, {
      code: 'INTERNAL_SERVER_ERROR',
      isOperational: false,
    })
  }

  if (error instanceof AppError) {
    return error
  }

  if (error instanceof mongoose.Error.ValidationError) {
    return normalizeMongooseValidationError(error)
  }

  if (error instanceof mongoose.Error.CastError) {
    return normalizeCastError(error)
  }

  if (error && error.code === 11000) {
    return normalizeDuplicateKeyError(error)
  }

  if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    return normalizeJwtError(error)
  }

  if (error instanceof multer.MulterError) {
    return normalizeMulterError(error)
  }

  return new AppError(
    error.message || 'Internal server error',
    error.statusCode || error.status || 500,
    {
      code: error.code || 'INTERNAL_SERVER_ERROR',
      details: error.details,
      isOperational: false,
    }
  )
}

function buildErrorResponse(error) {
  const response = {
    success: false,
    message: error.message,
    code: error.code || 'INTERNAL_SERVER_ERROR',
  }

  if (error.details !== undefined) {
    response.details = error.details
  }

  if (!isProduction && error.stack) {
    response.stack = error.stack
  }

  return response
}

module.exports = {
  buildErrorResponse,
  normalizeError,
}
