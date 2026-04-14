import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const body = JSON.stringify({
  pickupLocation: {
    coordinates: [77.5946, 12.9716]
  },
  dropoffLocation: {
    coordinates: [77.6245, 12.9352]
  },
  service: 'cerca small',
  rideFor: 'SELF'
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

const randomObjectId = () => {
  const hex = '0123456789abcdef'
  let id = ''
  for (let i = 0; i < 24; i += 1) {
    id += hex[Math.floor(Math.random() * 16)]
  }
  return id
}

export default function () {
  const riderId = __ENV.RIDER_ID || randomObjectId()
  const payload = JSON.stringify({
    ...JSON.parse(body),
    rider: riderId,
  })

  const headers = {
    'Content-Type': 'application/json',
  }

  const res = http.post(`${BASE_URL}/rides`, payload, { headers })

  check(res, {
    'status is 201': (r) => r.status === 201,
    'ride created': (r) => {
      const json = r.json()
      return json && json.ride && json.ride._id
    },
  })
}
