import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const userId = __ENV.USER_ID || 'user-id-placeholder'

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
  const res = http.get(`${BASE_URL}/users/${userId}`)

  check(res, {
    'status is 200': (r) => r.status === 200,
    'returned user object': (r) => {
      const json = r.json()
      return json && json._id === userId
    },
  })
}
