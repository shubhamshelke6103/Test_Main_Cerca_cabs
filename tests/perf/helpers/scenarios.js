export function constantLoad(vus, duration) {
  return {
    vus,
    duration,
  };
}

export function rampingLoad(stages) {
  return {
    stages,
  };
}

export function standardThresholds(durationP95Ms) {
  return {
    http_req_duration: [`p(95)<${durationP95Ms}`],
    http_req_failed: ['rate<0.05'],
  };
}
