import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const body = JSON.stringify({
  pickupLocation: {
    coordinates: [77.5946, 12.9716],
  },
  dropoffLocation: {
    coordinates: [77.6245, 12.9352],
  },
  service: 'cercaZip',
  rideFor: 'SELF',
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
  const createPayload = JSON.stringify({
    ...JSON.parse(body),
    rider: riderId,
  })

  const headers = {
    'Content-Type': 'application/json',
  }

  const createRes = http.post(`${BASE_URL}/rides`, createPayload, { headers })

  const createCheck = check(createRes, {
    'create status is 201': (r) => r.status === 201,
    'created ride has id': (r) => {
      const json = r.json()
      return json && json.ride && json.ride._id
    },
  })

  if (!createCheck) {
    return
  }

  const rideId = createRes.json().ride._id
  const getRes = http.get(`${BASE_URL}/rides/${rideId}`, { headers })

  check(getRes, {
    'get status is 200': (r) => r.status === 200,
    'ride retrieved': (r) => {
      const json = r.json()
      return json && json._id === rideId
    },
  })
}
