import { sleep } from 'k6';
import { authHeaders, getBaseUrl, requireEnv } from '../config/env.js';
import { getJson, jsonCheck } from '../helpers/http.js';
import { constantLoad } from '../helpers/scenarios.js';

export const options = {
  ...constantLoad(8, '30m'),
  thresholds: {
    http_req_duration: ['p(95)<1800'],
    http_req_failed: ['rate<0.02'],
  },
};

export default function () {
  const token = requireEnv('VENDOR_TOKEN');
  const { response, body } = getJson(`${getBaseUrl()}/vendor/earnings-report`, {
    headers: authHeaders(token),
    tags: { name: 'vendor_earnings_report_soak' },
  });

  jsonCheck(response, {
    'vendor soak status is 200': (res) => res.status === 200,
    'vendor soak has summary': () => Boolean(body?.data?.summary),
  });

  sleep(2);
}
