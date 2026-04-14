import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const token = __ENV.VENDOR_TOKEN || ''
const startDate = __ENV.START_DATE || '2026-01-01'
const endDate = __ENV.END_DATE || '2026-03-31'

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 40 },
    { duration: '30s', target: 10 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1100'],
  },
}

export default function () {
  const headers = {
    Authorization: `Bearer ${token}`,
  }

  const url = `${BASE_URL}/vendor/earnings-report?startDate=${startDate}&endDate=${endDate}`
  const res = http.get(url, { headers })

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response has data': (r) => r.json() && typeof r.json() === 'object',
  })
}
