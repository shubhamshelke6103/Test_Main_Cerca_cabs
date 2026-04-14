import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const body = JSON.stringify({
  pickupLocation: {
    latitude: 12.9716,
    longitude: 77.5946
  },
  dropoffLocation: {
    latitude: 12.9352,
    longitude: 77.6245
  },
  vehicleType: 'small',
  userId: __ENV.USER_ID || 'test-user-id'
})

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 30 },
    { duration: '30s', target: 10 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<800'],
  },
}

export default function () {
  const headers = {
    'Content-Type': 'application/json',
  }

  const res = http.post(`${BASE_URL}/rides/calculate-fare`, body, { headers })

  check(res, {
    'status is 200': (r) => r.status === 200,
    'fare data returned': (r) => {
      const json = r.json()
      return json && json.data && json.data.fareBreakdown && typeof json.data.fareBreakdown.finalFare === 'number'
    },
  })
}
