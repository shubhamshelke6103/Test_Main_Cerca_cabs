# Global Error Handling

## Overview

This project now has a shared global error handling foundation for Express.

The goal is to:

- centralize unexpected error handling
- standardize API error responses
- keep logging consistent
- reduce repetitive `try/catch + res.status(...).json(...)` patterns
- make controller and middleware code easier to maintain

## What Was Added

### Shared Error Utilities

The following files were added:

- [utils/errors/AppError.js](d:/Techlaps_pvt.ltd/test/Cerca-API/utils/errors/AppError.js)
- [utils/errors/asyncHandler.js](d:/Techlaps_pvt.ltd/test/Cerca-API/utils/errors/asyncHandler.js)
- [utils/errors/normalizeError.js](d:/Techlaps_pvt.ltd/test/Cerca-API/utils/errors/normalizeError.js)

These files provide the base error system.

#### `AppError`

`AppError` is a custom error class used for expected application errors.

It supports:

- `message`
- `statusCode`
- `code`
- `details`
- `isOperational`

Example:

```js
throw new AppError('User not found', 404, {
  code: 'USER_NOT_FOUND',
})
```

#### `asyncHandler`

`asyncHandler` wraps async Express handlers and forwards rejected promises to Express error middleware.

Example:

```js
const asyncHandler = require('../utils/errors/asyncHandler')

const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
  if (!user) {
    throw new AppError('User not found', 404, { code: 'USER_NOT_FOUND' })
  }
  res.status(200).json(user)
})
```

#### `normalizeError`

`normalizeError` converts different raw error types into a consistent `AppError`-style object.

It currently normalizes:

- Mongoose validation errors
- Mongoose `CastError`
- Mongo duplicate key errors
- JWT errors
- Multer errors
- unknown/unexpected errors

## Global Middleware

Two global middlewares were added:

- [middleware/notFound.middleware.js](d:/Techlaps_pvt.ltd/test/Cerca-API/middleware/notFound.middleware.js)
- [middleware/error.middleware.js](d:/Techlaps_pvt.ltd/test/Cerca-API/middleware/error.middleware.js)

These are registered in [index.js](d:/Techlaps_pvt.ltd/test/Cerca-API/index.js).

### Middleware Order

At the end of route registration, the app now uses:

```js
app.use(notFoundHandler)
app.use(errorHandler)
```

This order is important:

1. `notFoundHandler` converts unmatched routes into a `404` error
2. `errorHandler` formats and returns the final JSON response

## Standard Error Response Shape

The global handler returns a consistent response shape:

```json
{
  "success": false,
  "message": "Authentication required",
  "code": "AUTHENTICATION_REQUIRED",
  "details": {}
}
```

Notes:

- `details` is optional
- `stack` is included only outside production

## Current Logging Behavior

The global error middleware logs errors through:

- [utils/logger.js](d:/Techlaps_pvt.ltd/test/Cerca-API/utils/logger.js)

Logged fields include:

- message
- code
- statusCode
- request method
- request path
- stack
- details

## Files Updated To Use Global Error Flow

### Auth and Shared Middleware

These now forward errors using `next(error)` or `AppError`:

- [utils/driverAuth.js](d:/Techlaps_pvt.ltd/test/Cerca-API/utils/driverAuth.js)
- [utils/adminAuth.js](d:/Techlaps_pvt.ltd/test/Cerca-API/utils/adminAuth.js)
- [utils/vendorAuth.js](d:/Techlaps_pvt.ltd/test/Cerca-API/utils/vendorAuth.js)
- [middleware/shareToken.middleware.js](d:/Techlaps_pvt.ltd/test/Cerca-API/middleware/shareToken.middleware.js)

### Route-Level Handling

- [Routes/Driver/driver.routes.js](d:/Techlaps_pvt.ltd/test/Cerca-API/Routes/Driver/driver.routes.js)

This now forwards multer errors and some authorization errors to the global handler.

### Controllers Migrated

The following controllers were migrated to use `AppError` and/or `asyncHandler`:

- [Controllers/User/user.controller.js](d:/Techlaps_pvt.ltd/test/Cerca-API/Controllers/User/user.controller.js)
- [Controllers/User/wallet.controller.js](d:/Techlaps_pvt.ltd/test/Cerca-API/Controllers/User/wallet.controller.js)
- [Controllers/Driver/driver.controller.js](d:/Techlaps_pvt.ltd/test/Cerca-API/Controllers/Driver/driver.controller.js)
- [Controllers/User/ride.controller.js](d:/Techlaps_pvt.ltd/test/Cerca-API/Controllers/User/ride.controller.js)

## Important Limitation

Global error handling is active and working, but it is not yet the only error path in the whole codebase.

Some older controllers and modules in the project still use direct patterns like:

```js
return res.status(400).json({ message: '...' })
```

or:

```js
catch (error) {
  res.status(500).json({ ... })
}
```

Those paths bypass the global error middleware because the response is sent locally.

So the current state is:

- migrated routes use the new centralized error flow
- non-migrated routes may still use local error responses

## What Changes Logically

The intention of this system is to improve consistency without changing business logic.

### What Should Stay The Same

- route behavior
- database operations
- success responses
- business rules

### What May Change

- error response structure
- status code consistency
- logging behavior
- where errors are handled

## Recommended Usage Pattern

### For expected business errors

Use `AppError`:

```js
if (!user) {
  throw new AppError('User not found', 404, {
    code: 'USER_NOT_FOUND',
  })
}
```

### For async controllers

Wrap with `asyncHandler`:

```js
const handler = asyncHandler(async (req, res) => {
  // async logic
})
```

### For middleware

Forward errors using `next(...)`:

```js
if (!req.user) {
  return next(
    new AppError('Authentication required', 401, {
      code: 'AUTHENTICATION_REQUIRED',
    })
  )
}
```

## When Not To Use Local `res.status(...).json(...)`

Avoid local error responses when:

- the error is generic
- the error should follow the project-wide response shape
- the same validation pattern appears in many files

Local handling is still acceptable when:

- a route intentionally returns a special non-standard response
- HTML/text output is required instead of JSON
- a very route-specific error payload is necessary

## Testing

Regression coverage for the global error system was added in:

- [tests/globalErrorHandling.test.js](d:/Techlaps_pvt.ltd/test/Cerca-API/tests/globalErrorHandling.test.js)

Covered cases:

- route not found -> `404`
- validation error -> `400`
- invalid Mongo cast -> `400`
- duplicate key -> `409`
- JWT error -> `401`
- multer file-too-large -> `413`
- standardized error response shape
- `headersSent` behavior in final middleware

## Future Improvement Areas

- migrate remaining controllers that still handle errors locally
- export the Express app separately from server startup
- add route-level integration tests for migrated endpoints
- standardize business error codes across all modules

## Summary

This project now has a working global error handling foundation.

It provides:

- a reusable custom error class
- async error forwarding
- centralized normalization
- centralized logging
- standardized JSON responses
- automated regression tests for the shared error layer

It is already working for the migrated parts of the project, and it provides a solid base for completing error-flow standardization across the rest of the API.
