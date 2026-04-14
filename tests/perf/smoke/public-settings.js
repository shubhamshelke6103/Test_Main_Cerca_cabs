import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<600'], // ✅ FIXED
  },
}

export default function () {
  const res = http.get(`${BASE_URL}/settings/public`)

  check(res, {
    'status is 200': (r) => r.status === 200,
    'settings payload returned': (r) =>
      r.json() && typeof r.json() === 'object',
  })
}