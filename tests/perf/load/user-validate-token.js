import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const token = __ENV.USER_TOKEN || ''

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

  const res = http.get(`${BASE_URL}/users/validate-token`, { headers })

  check(res, {
    'status is 200': (r) => r.status === 200,
    'token valid': (r) => {
      const json = r.json()
      return json && json.valid === true
    },
  })
}
