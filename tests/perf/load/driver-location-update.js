import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const driverId = __ENV.DRIVER_ID || '69db24ec88cbaf798914e145'
const token = __ENV.DRIVER_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY5ZGIyNGVjODhjYmFmNzk4OTE0ZTE0NSIsImVtYWlsIjoic2h1YmhhbXNoZWxrZTYxMDNAZ21haWwuY29tIiwiaWF0IjoxNzc2MTY3NTc1LCJleHAiOjE3NzY3NzIzNzV9.vijKoffouxdwL7azsoK-RM5WpT4aOZhMF3j4CjPaaCs'

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

const randomLocation = () => {
  const lng = 77.59 + Math.random() * 0.05
  const lat = 12.94 + Math.random() * 0.05
  return [lng, lat]
}

export default function () {
  const url = `${BASE_URL}/drivers/${driverId}/location`
  const payload = JSON.stringify({ coordinates: randomLocation() })
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const res = http.patch(url, payload, { headers })

  check(res, {
    'status is 200': (r) => r.status === 200,
    'location updated': (r) => {
      const json = r.json()
      return json && json.location && Array.isArray(json.location.coordinates)
    },
  })
}
