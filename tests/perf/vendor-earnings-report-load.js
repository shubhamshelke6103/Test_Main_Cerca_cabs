import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '2m',
  thresholds: {
    http_req_duration: ['p(95)<1500'],
    http_req_failed: ['rate<0.05'],
  },
};

const baseUrl = __ENV.BASE_URL || 'http://localhost:8000';
const token = __ENV.VENDOR_TOKEN || 'replace-token';

export default function () {
  const res = http.get(`${baseUrl}/vendor/earnings-report`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'contains summary': (r) => {
      const body = r.json();
      return !!body?.data?.summary;
    },
  });

  sleep(1);
}
