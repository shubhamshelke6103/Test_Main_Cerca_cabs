import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL } from '../common.js'

const randomPhoneNumber = () => {
  const prefix = '98'
  const suffix = Math.floor(Math.random() * 90000000 + 10000000).toString()
  return `${prefix}${suffix}`
}

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
  const phoneNumber = __ENV.PHONE_NUMBER || randomPhoneNumber()
  const payload = JSON.stringify({
    phoneNumber,
    privacyPolicyAccepted: true,
  })

  const res = http.post(`${BASE_URL}/users/login`, payload, {
    headers: { 'Content-Type': 'application/json' },
  })

  check(res, {
    'status is 200': (r) => r.status === 200,
    'login returned token': (r) => {
      const json = r.json()
      return json && json.token && json.userId
    },
  })
}
