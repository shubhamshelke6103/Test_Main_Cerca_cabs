import { sleep } from 'k6';
import { authHeaders, getBaseUrl, requireEnv } from '../config/env.js';
import { getJson, jsonCheck } from '../helpers/http.js';
import { rampingLoad, standardThresholds } from '../helpers/scenarios.js';

export const options = {
  ...rampingLoad([
    { duration: '1m', target: 10 },
    { duration: '2m', target: 20 },
    { duration: '2m', target: 35 },
    { duration: '1m', target: 0 },
  ]),
  thresholds: standardThresholds(1200),
};

export default function () {
  const driverId = requireEnv('DRIVER_ID');
  const token = requireEnv('DRIVER_TOKEN');
  const { response, body } = getJson(`${getBaseUrl()}/drivers/${driverId}/hotspot-snapshot`, {
    headers: authHeaders(token),
    tags: { name: 'driver_hotspot_snapshot' },
  });

  jsonCheck(response, {
    'driver hotspot returns 200': (res) => res.status === 200,
    'driver hotspot has zones array': () => Array.isArray(body?.zones),
    'driver hotspot has summary object': () => typeof body?.summary === 'object',
  });

  sleep(1);
}
