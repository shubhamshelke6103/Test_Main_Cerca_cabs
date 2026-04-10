const { test } = require('node:test')
const assert = require('node:assert/strict')

const jwt = require('jsonwebtoken')
const mongoose = require('mongoose')
const multer = require('multer')

const AppError = require('../utils/errors/AppError')
const errorHandler = require('../middleware/error.middleware')
const notFoundHandler = require('../middleware/notFound.middleware')
const { normalizeError, buildErrorResponse } = require('../utils/errors/normalizeError')

function createMockRes() {
  return {
    headersSent: false,
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

test('notFoundHandler forwards a 404 AppError', () => {
  const req = { method: 'GET', originalUrl: '/missing-route' }
  let forwardedError = null

  notFoundHandler(req, {}, error => {
    forwardedError = error
  })

  assert.ok(forwardedError instanceof AppError)
  assert.equal(forwardedError.statusCode, 404)
  assert.equal(forwardedError.code, 'ROUTE_NOT_FOUND')
  assert.match(forwardedError.message, /GET \/missing-route/)
})

test('normalizeError keeps AppError details intact', () => {
  const error = new AppError('Forbidden', 403, {
    code: 'FORBIDDEN',
    details: { scope: 'driver' }
  })

  const normalized = normalizeError(error)

  assert.equal(normalized, error)
  assert.equal(normalized.statusCode, 403)
  assert.deepEqual(normalized.details, { scope: 'driver' })
})

test('normalizeError converts mongoose validation errors to 400', () => {
  const error = new mongoose.Error.ValidationError()
  error.addError(
    'email',
    new mongoose.Error.ValidatorError({
      path: 'email',
      message: 'Email is required',
      value: ''
    })
  )

  const normalized = normalizeError(error)

  assert.equal(normalized.statusCode, 400)
  assert.equal(normalized.code, 'VALIDATION_ERROR')
  assert.deepEqual(normalized.details, [
    { field: 'email', message: 'Email is required', value: '' }
  ])
})

test('normalizeError converts mongoose cast errors to 400', () => {
  const error = new mongoose.Error.CastError('ObjectId', 'bad-id', 'rideId')

  const normalized = normalizeError(error)

  assert.equal(normalized.statusCode, 400)
  assert.equal(normalized.code, 'INVALID_IDENTIFIER')
  assert.equal(normalized.details.field, 'rideId')
  assert.equal(normalized.details.value, 'bad-id')
})

test('normalizeError converts duplicate key errors to 409', () => {
  const error = {
    code: 11000,
    keyValue: {
      email: 'test@example.com'
    }
  }

  const normalized = normalizeError(error)

  assert.equal(normalized.statusCode, 409)
  assert.equal(normalized.code, 'DUPLICATE_KEY')
  assert.deepEqual(normalized.details, [
    { field: 'email', value: 'test@example.com' }
  ])
})

test('normalizeError converts JWT errors to 401', () => {
  const error = new jwt.JsonWebTokenError('jwt malformed')

  const normalized = normalizeError(error)

  assert.equal(normalized.statusCode, 401)
  assert.equal(normalized.code, 'INVALID_TOKEN')
  assert.equal(normalized.message, 'Invalid token')
})

test('normalizeError converts multer file-too-large errors to 413', () => {
  const error = new multer.MulterError('LIMIT_FILE_SIZE', 'document')

  const normalized = normalizeError(error)

  assert.equal(normalized.statusCode, 413)
  assert.equal(normalized.code, 'FILE_TOO_LARGE')
  assert.equal(normalized.details.field, 'document')
})

test('buildErrorResponse returns the standardized JSON shape', () => {
  const response = buildErrorResponse(
    new AppError('Invalid wallet amount', 400, {
      code: 'INVALID_WALLET_AMOUNT',
      details: { amount: -1 }
    })
  )

  assert.equal(response.success, false)
  assert.equal(response.message, 'Invalid wallet amount')
  assert.equal(response.code, 'INVALID_WALLET_AMOUNT')
  assert.deepEqual(response.details, { amount: -1 })
})

test('errorHandler writes normalized status and body to response', () => {
  const req = {
    method: 'POST',
    originalUrl: '/users/login'
  }
  const res = createMockRes()

  errorHandler(
    new AppError('Authentication required', 401, {
      code: 'AUTHENTICATION_REQUIRED'
    }),
    req,
    res,
    () => {
      throw new Error('next() should not be called when headers are not sent')
    }
  )

  assert.equal(res.statusCode, 401)
  assert.equal(res.body.success, false)
  assert.equal(res.body.code, 'AUTHENTICATION_REQUIRED')
  assert.equal(res.body.message, 'Authentication required')
})

test('errorHandler delegates to next when headers are already sent', () => {
  const req = {
    method: 'GET',
    originalUrl: '/users/123'
  }
  const res = createMockRes()
  res.headersSent = true
  const error = new Error('late failure')
  let delegated = null

  errorHandler(error, req, res, nextError => {
    delegated = nextError
  })

  assert.equal(delegated, error)
  assert.equal(res.statusCode, null)
  assert.equal(res.body, null)
})
