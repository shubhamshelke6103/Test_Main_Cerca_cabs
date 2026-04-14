import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

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
  const url = `${BASE_URL}/drivers/${driverId}/upcoming-bookings`
  const res = http.get(url)

  check(res, {
    'status is 200': (r) => r.status === 200,
    'returns bookings array': (r) => {
      const json = r.json()
      return json && Array.isArray(json.bookings)
    },
  })
}
