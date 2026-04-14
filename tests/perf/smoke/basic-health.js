import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<500'], // ✅ FIXED
  },
}

export default function () {
  const res = http.get(`${BASE_URL}/`)

  check(res, {
    'status is 200': (r) => r.status === 200,
    'body contains welcome': (r) =>
      r.body && r.body.indexOf('Welcome to Cerca API') !== -1,
  })
}