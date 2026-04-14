import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const token = __ENV.DRIVER_TOKEN || ''
const driverId = __ENV.DRIVER_ID || 'driver-id-placeholder'

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 30 },
    { duration: '30s', target: 10 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<900'],
  },
}

export default function () {
  const headers = {
    Authorization: `Bearer ${token}`,
  }

  const url = `${BASE_URL}/drivers/${driverId}/hotspot-snapshot`
  const res = http.get(url, { headers })

  check(res, {
    'status is 200': (r) => r.status === 200,
    'hotspot payload returned': (r) => r.json() && typeof r.json() === 'object',
  })
}
