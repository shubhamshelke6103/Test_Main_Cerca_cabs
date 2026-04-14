import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const token = __ENV.ADMIN_TOKEN || ''

export const options = {
  stages: [
    { duration: '30s', target: 5 },
    { duration: '1m', target: 20 },
    { duration: '30s', target: 5 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1100'],
  },
}

export default function () {
  const res = http.get(`${BASE_URL}/admin/dashboard`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  check(res, {
    'status is 200': (r) => r.status === 200,
    'dashboard payload returned': (r) => r.json() && typeof r.json() === 'object',
  })
}
