const { test } = require('node:test')
const assert = require('node:assert/strict')

const Ride = require('../Models/Driver/ride.model.js')
const Notification = require('../Models/User/notification.model.js')

test('Ride schema includes destinationRevision and destinationChangeLog', () => {
  assert.ok(Ride.schema.paths.destinationRevision)
  assert.ok(Ride.schema.paths.destinationChangeLog)
})

test('Notification type enum includes ride_destination_updated', () => {
  const enumValues = Notification.schema.path('type').enumValues
  assert.ok(enumValues.includes('ride_destination_updated'))
})
