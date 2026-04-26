const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  getDriverRideAccessProfile,
  normalizeRideAccessPreferences
} = require('../utils/ride_booking_functions')

test('glide driver defaults keep glide enabled', async () => {
  const profile = await getDriverRideAccessProfile({
    vehicleInfo: { vehicleType: 'cercaGlide' },
    rideAccess: {}
  })

  assert.deepEqual(profile.availableToggles, ['allowGlide', 'allowZip'])
  assert.deepEqual(profile.allowedRideTypes, ['cercaGlide'])
  assert.equal(profile.rideAccess.allowGlide, true)
  assert.equal(profile.rideAccess.allowZip, false)
})

test('glide driver cannot be normalized to zero enabled ride feeds', () => {
  const normalized = normalizeRideAccessPreferences(
    {
      allowGlide: false,
      allowZip: false
    },
    'cercaGlide'
  )

  assert.equal(normalized.allowGlide, true)
  assert.equal(normalized.allowZip, false)
})

test('titan driver always includes titan and can include lower tiers', async () => {
  const profile = await getDriverRideAccessProfile({
    vehicleInfo: { vehicleType: 'cercaTitan' },
    rideAccess: { allowGlide: false, allowZip: true }
  })

  assert.deepEqual(profile.availableToggles, ['allowGlide', 'allowZip'])
  assert.deepEqual(profile.allowedRideTypes, ['cercaTitan', 'cercaZip'])
})
