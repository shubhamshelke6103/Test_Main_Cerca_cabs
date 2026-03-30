import http from 'k6/http';
import { check } from 'k6';

export function getJson(url, params = {}) {
  const response = http.get(url, params);
  return {
    response,
    body: safeJson(response),
  };
}

export function safeJson(response) {
  try {
    return response.json();
  } catch (error) {
    return null;
  }
}

export function checkStatus(response, expectedStatus, label) {
  return check(response, {
    [label || `status is ${expectedStatus}`]: (res) => res.status === expectedStatus,
  });
}

export function jsonCheck(response, checks) {
  return check(response, checks);
}
