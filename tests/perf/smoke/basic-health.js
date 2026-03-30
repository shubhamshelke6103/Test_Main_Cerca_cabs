import { sleep } from 'k6';
import { getBaseUrl } from '../config/env.js';
import { getJson, jsonCheck } from '../helpers/http.js';
import { constantLoad, standardThresholds } from '../helpers/scenarios.js';

export const options = {
  ...constantLoad(1, '20s'),
  thresholds: standardThresholds(500),
};

export default function () {
  const { response } = getJson(`${getBaseUrl()}/`);

  jsonCheck(response, {
    'health returns 200': (res) => res.status === 200,
    'health body contains welcome text': (res) =>
      typeof res.body === 'string' && res.body.includes('Welcome to Cerca API'),
  });

  sleep(1);
}
