import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const driverId = __ENV.DRIVER_ID || 'driver-id-placeholder'
const rideId = __ENV.RIDE_ID || 'ride-id-placeholder'
const token = __ENV.DRIVER_TOKEN || ''

export const options = {
  stages: [
    { duration: '30s', target: 5 },
    { duration: '1m', target: 15 },
    { duration: '30s', target: 5 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<900'],
  },
}

export default function () {
  const url = `${BASE_URL}/drivers/${driverId}/rides/${rideId}/reject-accepted`
  const payload = JSON.stringify({ reason: 'Load test reject accepted ride' })
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const res = http.patch(url, payload, { headers })

  check(res, {
    'status is 200': (r) => r.status === 200,
    'ride rejected': (r) => {
      const json = r.json()
      return json && json.message && json.message.includes('rejected successfully')
    },
  })
}
