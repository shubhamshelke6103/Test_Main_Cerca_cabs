import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const token = __ENV.VENDOR_TOKEN || ''
const startDate = __ENV.START_DATE || '2026-01-01'
const endDate = __ENV.END_DATE || '2026-03-31'

export const options = {
  stages: [
    { duration: '5m', target: 20 },
    { duration: '20m', target: 20 },
    { duration: '5m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<900'],
  },
}

export default function () {
  const res = http.get(`${BASE_URL}/vendor/earnings-report?startDate=${startDate}&endDate=${endDate}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response has data': (r) => r.json() && typeof r.json() === 'object',
  })
}
