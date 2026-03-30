import { sleep } from 'k6';
import { authHeaders, getBaseUrl, requireEnv } from '../config/env.js';
import { getJson, jsonCheck } from '../helpers/http.js';
import { rampingLoad, standardThresholds } from '../helpers/scenarios.js';

export const options = {
  ...rampingLoad([
    { duration: '1m', target: 3 },
    { duration: '2m', target: 8 },
    { duration: '2m', target: 12 },
    { duration: '1m', target: 0 },
  ]),
  thresholds: standardThresholds(1800),
};

export default function () {
  const token = requireEnv('ADMIN_TOKEN');
  const { response, body } = getJson(`${getBaseUrl()}/admin/dashboard`, {
    headers: authHeaders(token),
    tags: { name: 'admin_dashboard' },
  });

  jsonCheck(response, {
    'admin dashboard returns 200': (res) => res.status === 200,
    'admin dashboard has stats': () => typeof body?.stats === 'object',
    'admin dashboard has revenue': () => typeof body?.revenue === 'object',
    'admin dashboard has recent activities array': () => Array.isArray(body?.recentActivities),
  });

  sleep(1);
}
