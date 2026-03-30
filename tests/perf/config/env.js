const DEFAULT_BASE_URL = 'http://localhost:8000';

export function getBaseUrl() {
  return __ENV.BASE_URL || DEFAULT_BASE_URL;
}

export function requireEnv(name) {
  const value = __ENV[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name, fallback = '') {
  return __ENV[name] || fallback;
}

export function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}
