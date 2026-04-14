import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const userId = __ENV.USER_ID || 'test-user-id'
const body = JSON.stringify({
  pickupLocation: {
    latitude: 12.9716,
    longitude: 77.5946
  }
})

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
    'Content-Type': 'application/json',
  }

  const res = http.post(`${BASE_URL}/rides/search/${userId}`, body, { headers })

  check(res, {
    'status is 200': (r) => r.status === 200,
    'nearbyDrivers object returned': (r) => r.json() && r.json().nearbyDrivers !== undefined,
  })
}
