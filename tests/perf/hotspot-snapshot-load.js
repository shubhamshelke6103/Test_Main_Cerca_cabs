import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 20,
  duration: '2m',
  thresholds: {
    http_req_duration: ['p(95)<1200'],
    http_req_failed: ['rate<0.05'],
  },
};

const baseUrl = __ENV.BASE_URL || 'http://localhost:8000';
const driverId = __ENV.DRIVER_ID || 'replace-driver-id';
const token = __ENV.DRIVER_TOKEN || 'replace-token';

export default function () {
  const res = http.get(`${baseUrl}/drivers/${driverId}/hotspot-snapshot`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has zones array': (r) => {
      const body = r.json();
      return Array.isArray(body?.zones);
    },
  });

  sleep(1);
}
