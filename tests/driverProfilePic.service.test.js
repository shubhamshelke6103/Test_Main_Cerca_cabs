const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isAllowedProfilePicMime,
  buildDriverProfilePicUrl,
  DRIVER_PROFILE_PIC_SUBDIR,
} = require('../utils/driverProfilePic.service');

test('isAllowedProfilePicMime allows jpeg, png, webp only', () => {
  assert.equal(isAllowedProfilePicMime('image/jpeg'), true);
  assert.equal(isAllowedProfilePicMime('image/png'), true);
  assert.equal(isAllowedProfilePicMime('image/webp'), true);
  assert.equal(isAllowedProfilePicMime('image/gif'), false);
  assert.equal(isAllowedProfilePicMime('application/octet-stream'), false);
  assert.equal(isAllowedProfilePicMime(null), false);
  assert.equal(isAllowedProfilePicMime(undefined), false);
});

test('buildDriverProfilePicUrl returns public absolute URL', () => {
  const req = {
    protocol: 'https',
    get: (h) => (h === 'host' ? 'api.example.com' : ''),
  };
  const url = buildDriverProfilePicUrl(req, { filename: 'pic-1.jpg' });
  assert.equal(
    url,
    `https://api.example.com/${DRIVER_PROFILE_PIC_SUBDIR}/pic-1.jpg`,
  );
});

test('buildDriverProfilePicUrl returns null when file missing', () => {
  const req = { protocol: 'http', get: () => 'localhost:4000' };
  assert.equal(buildDriverProfilePicUrl(req, null), null);
  assert.equal(buildDriverProfilePicUrl(req, {}), null);
  assert.equal(buildDriverProfilePicUrl(req, { filename: '' }), null);
});
