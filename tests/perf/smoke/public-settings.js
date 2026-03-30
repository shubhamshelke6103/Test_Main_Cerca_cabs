import { sleep } from 'k6';
import { getBaseUrl } from '../config/env.js';
import { getJson, jsonCheck } from '../helpers/http.js';
import { constantLoad, standardThresholds } from '../helpers/scenarios.js';

export const options = {
  ...constantLoad(2, '30s'),
  thresholds: standardThresholds(1200),
};

export default function () {
  const { response: settingsResponse, body } = getJson(`${getBaseUrl()}/admin/settings/public`);
  const { response: policyResponse, body: policyBody } = getJson(`${getBaseUrl()}/users/privacy-policy`);

  jsonCheck(settingsResponse, {
    'public settings returns 200': (res) => res.status === 200,
    'public settings returns json': () => body !== null,
  });

  jsonCheck(policyResponse, {
    'privacy policy returns 200': (res) => res.status === 200,
    'privacy policy contains version': () => Boolean(policyBody?.privacyPolicy?.version),
  });

  sleep(1);
}
