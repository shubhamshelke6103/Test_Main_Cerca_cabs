# k6 Performance Testing Guide

This folder contains the first reusable k6 setup for the Cerca API.

## Test layout

- `config/`: environment helpers
- `helpers/`: shared k6 wrappers and thresholds
- `smoke/`: quick validation scripts
- `load/`: normal performance tests
- `soak/`: longer stability tests

## Environment variables

Set these before running protected-route tests:

```powershell
$env:BASE_URL="http://localhost:8000"
$env:VENDOR_TOKEN="replace-with-real-vendor-jwt"
$env:DRIVER_TOKEN="replace-with-real-driver-jwt"
$env:DRIVER_ID="replace-with-real-driver-id"
$env:ADMIN_TOKEN="replace-with-real-admin-jwt"
```

## Recommended execution order

1. Start the API and confirm MongoDB and Redis are reachable.
2. Run smoke tests to validate connectivity and payload shapes.
3. Run one load script at a time.
4. Run soak tests only after load tests are stable.

## Commands

Smoke tests:

```powershell
npm run perf:smoke:health
npm run perf:smoke:public
```

Load tests:

```powershell
npm run perf:load:vendor
npm run perf:load:driver-hotspot
npm run perf:load:admin-dashboard
```

Soak test:

```powershell
npm run perf:soak:vendor
```

## What to watch while k6 runs

- API logs for `500`, `429`, and timeout patterns
- MongoDB CPU, slow queries, and connection pressure
- Redis latency and connection churn
- Node.js memory and CPU usage
- Worker side effects for ride, payout, or notification flows

## Notes for this codebase

- `GET /vendor/earnings-report` is a good first authenticated read-heavy endpoint.
- `GET /drivers/:driverId/hotspot-snapshot` exercises heatmap snapshot logic and auth.
- `GET /admin/dashboard` is useful for aggregate query performance.
- Avoid starting with write-heavy endpoints like ride creation or payment flows until read tests are stable.
