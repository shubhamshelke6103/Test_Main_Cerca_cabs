import { sleep } from 'k6';
import { authHeaders, getBaseUrl, requireEnv } from '../config/env.js';
import { getJson, jsonCheck } from '../helpers/http.js';
import { rampingLoad, standardThresholds } from '../helpers/scenarios.js';

export const options = {
  ...rampingLoad([
    { duration: '1m', target: 5 },
    { duration: '2m', target: 15 },
    { duration: '2m', target: 25 },
    { duration: '1m', target: 0 },
  ]),
  thresholds: standardThresholds(1500),
};

export default function () {
  const token = requireEnv('VENDOR_TOKEN');
  const { response, body } = getJson(`${getBaseUrl()}/vendor/earnings-report`, {
    headers: authHeaders(token),
    tags: { name: 'vendor_earnings_report' },
  });

  jsonCheck(response, {
    'vendor earnings status is 200': (res) => res.status === 200,
    'vendor earnings has data summary': () => Boolean(body?.data?.summary),
  });

  sleep(1);
}
