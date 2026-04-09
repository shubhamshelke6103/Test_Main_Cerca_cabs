const assert = require('assert');
const {
  normalizeEmail,
  normalizeMobileDigits
} = require('../utils/contactValidation');

const buildEmail = (len) => `${'a'.repeat(len - '@x.io'.length)}@x.io`;

(() => {
  const email253 = buildEmail(253);
  const email254 = buildEmail(254);
  const email255 = buildEmail(255);

  assert.strictEqual(normalizeEmail(email253).error, null);
  assert.strictEqual(normalizeEmail(email254).error, null);
  assert.ok(normalizeEmail(email255).error);

  assert.strictEqual(normalizeMobileDigits('98a-76 54').value, '987654');
  assert.strictEqual(normalizeMobileDigits('abc').error, 'Phone number must contain digits only');
})();
