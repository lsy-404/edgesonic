# EdgeSonic Test Suite

Most tests are standalone TypeScript scripts grouped by the API or frontend area they exercise. A small set of legacy security tests imports Vitest, which is not installed or configured by this repository.

## Run tests

```bash
pnpm install --frozen-lockfile

# Run one test
pnpm exec tsx test/subsonic/annotation.test.ts

# Run all tests
find test -name '*.test.ts' -exec pnpm exec tsx {} \;
```

## Layout

- `frontend/`: UI stores, components, and browser-side utilities
- `internal/`: Worker application behavior and integration boundaries
- `opensubsonic/`: OpenSubsonic compatibility
- `subsonic/`: Subsonic API behavior
- `web/`: browser-facing security behavior
- `fixtures/`: shared test data

No aggregate test runner, watch mode, coverage reporter, or browser automation framework is configured. Individual standalone scripts report their own assertions and exit status.
