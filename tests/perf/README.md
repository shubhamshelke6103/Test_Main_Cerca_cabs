# k6 Performance Testing for Cerca-API

## Setup
1. Install k6 on the machine where tests will run.
   - macOS/Linux: https://k6.io/docs/getting-started/installation/
   - Windows: install via Chocolatey or download the binary.
2. Start your API server in the test environment.
3. Set `BASE_URL` to the API root if it is not `http://localhost:8000`.

## Available test scripts
- `tests/perf/smoke/basic-health.js` — validates service availability
- `tests/perf/smoke/public-settings.js` — validates public settings endpoint
- `tests/perf/load/vendor-earnings-report.js` — load test for vendor earnings report
- `tests/perf/load/driver-hotspot-snapshot.js` — load test for driver hotspot snapshot
- `tests/perf/load/driver-rides.js` — load test for driver ride list retrieval / GET /drivers/:id/rides
- `tests/perf/load/driver-upcoming-bookings.js` — load test for driver upcoming bookings / GET /drivers/:id/upcoming-bookings
- `tests/perf/load/driver-location-update.js` — load test for driver location updates / PATCH /drivers/:id/location
- `tests/perf/load/driver-reject-accepted.js` — load test for driver ride rejection / PATCH /drivers/:driverId/rides/:rideId/reject-accepted
- `tests/perf/load/user-login.js` — load test for user login / POST /users/login
- `tests/perf/load/user-get-by-id.js` — load test for getting user profile / GET /users/:id
- `tests/perf/load/user-validate-token.js` — load test for token validation / GET /users/validate-token
- `tests/perf/load/user-wallet.js` — load test for user wallet retrieval / GET /users/:id/wallet
- `tests/perf/load/admin-dashboard.js` — load test for admin dashboard
- `tests/perf/load/ride-calculate-fare.js` — load test for ride fare calculation
- `tests/perf/load/ride-calculate-all-fares.js` — load test for all-vehicle fare quotes
- `tests/perf/load/ride-create.js` — load test for ride creation / POST /rides
- `tests/perf/load/ride-get-by-id.js` — load test for ride detail retrieval / GET /rides/:id
- `tests/perf/load/ride-destination-quote.js` — load test for destination preview / GET /rides/:id/destination-quote
- `tests/perf/load/ride-search.js` — load test for nearby driver search
- `tests/perf/soak/vendor-earnings-report-soak.js` — soak test for vendor earnings report

## Recommended commands
```bash
BASE_URL=http://localhost:8000 k6 run tests/perf/smoke/basic-health.js
BASE_URL=http://localhost:8000 k6 run tests/perf/smoke/public-settings.js
BASE_URL=http://localhost:8000 ADMIN_TOKEN=xxxx k6 run tests/perf/load/admin-dashboard.js
BASE_URL=http://localhost:8000 VENDOR_TOKEN=xxxx k6 run tests/perf/load/vendor-earnings-report.js
BASE_URL=http://localhost:8000 DRIVER_ID=driver-id k6 run tests/perf/load/driver-rides.js
BASE_URL=http://localhost:8000 DRIVER_ID=driver-id k6 run tests/perf/load/driver-upcoming-bookings.js
BASE_URL=http://localhost:8000 DRIVER_TOKEN=xxxx DRIVER_ID=driver-id k6 run tests/perf/load/driver-location-update.js
BASE_URL=http://localhost:8000 DRIVER_TOKEN=xxxx DRIVER_ID=driver-id RIDE_ID=ride-id k6 run tests/perf/load/driver-reject-accepted.js
BASE_URL=http://localhost:8000 USER_TOKEN=xxxx k6 run tests/perf/load/user-validate-token.js
BASE_URL=http://localhost:8000 USER_ID=user-id k6 run tests/perf/load/user-get-by-id.js
BASE_URL=http://localhost:8000 USER_ID=user-id k6 run tests/perf/load/user-wallet.js
BASE_URL=http://localhost:8000 k6 run tests/perf/load/user-login.js
BASE_URL=http://localhost:8000 DRIVER_TOKEN=xxxx DRIVER_ID=driver-id k6 run tests/perf/load/driver-hotspot-snapshot.js
BASE_URL=http://localhost:8000 k6 run tests/perf/load/ride-calculate-fare.js
BASE_URL=http://localhost:8000 k6 run tests/perf/load/ride-calculate-all-fares.js
BASE_URL=http://localhost:8000 k6 run tests/perf/load/ride-create.js
BASE_URL=http://localhost:8000 k6 run tests/perf/load/ride-get-by-id.js
BASE_URL=http://localhost:8000 k6 run tests/perf/load/ride-destination-quote.js
BASE_URL=http://localhost:8000 k6 run tests/perf/load/ride-search.js
BASE_URL=http://localhost:8000 VENDOR_TOKEN=xxxx k6 run tests/perf/soak/vendor-earnings-report-soak.js
```

## Notes
- `ADMIN_TOKEN`, `VENDOR_TOKEN`, and `DRIVER_TOKEN` must be valid JWTs for the respective user type.
- The `DRIVER_ID` must match the authenticated driver.
- Adjust the options in each script to increase or decrease concurrency and duration.
