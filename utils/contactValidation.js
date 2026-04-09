const EMAIL_MAX_LENGTH = 254;

const normalizeEmail = (email) => {
  if (email == null) {
    return { value: null, error: null };
  }

  const value = String(email).trim().toLowerCase();
  if (!value) {
    return { value: '', error: null };
  }

  if (value.length > EMAIL_MAX_LENGTH) {
    return { value, error: `Email must be at most ${EMAIL_MAX_LENGTH} characters` };
  }

  const basicEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!basicEmailRegex.test(value)) {
    return { value, error: 'Please enter a valid email address' };
  }

  return { value, error: null };
};

const normalizeMobileDigits = (phone) => {
  if (phone == null) {
    return { value: null, error: null };
  }

  const raw = String(phone).trim();
  if (!raw) {
    return { value: '', error: null };
  }

  const digits = raw.replace(/\D/g, '');
  if (!digits) {
    return { value: '', error: 'Phone number must contain digits only' };
  }

  return { value: digits, error: null };
};

module.exports = {
  EMAIL_MAX_LENGTH,
  normalizeEmail,
  normalizeMobileDigits
};
