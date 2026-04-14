import http from 'k6/http'
import { check } from 'k6'
import encoding from 'k6/encoding'
import { hmac } from 'k6/crypto'
import { BASE_URL } from '../common.js'

const body = JSON.stringify({
  pickupLocation: {
    coordinates: [77.5946, 12.9716],
  },
  dropoffLocation: {
    coordinates: [77.6245, 12.9352],
  },
  service: 'cerca small',
  rideFor: 'SELF',
})

const JWT_SECRET = '@#@!#@dasd4234jkdh3874#$@#$#$@#$#$dkjashdlk$#442343%#$%f34234T$vtwefcEC$%'

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

const base64UrlEncode = (str) =>
  encoding
    .b64encode(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const createJwt = (payload) => {
  const header = { alg: 'HS256', typ: 'JWT' }
  const encodedHeader = base64UrlEncode(JSON.stringify(header))
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signature = hmac('sha256', JWT_SECRET, `${encodedHeader}.${encodedPayload}`, 'base64url')
  const encodedSignature = signature
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`
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
  const token = __ENV.RIDER_TOKEN || createJwt({ id: riderId })
  const quoteHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }

  const query = '?latitude=77.6330&longitude=12.9120'
  const quoteRes = http.get(`${BASE_URL}/rides/${rideId}/destination-quote${query}`, {
    headers: quoteHeaders,
  })

  check(quoteRes, {
    'destination quote status is 200': (r) => r.status === 200,
    'destination quote success': (r) => {
      const json = r.json()
      return json && json.success === true && json.pricing && json.pricing.newFare != null
    },
  })
}
