#!/usr/bin/env bash
#
# Definition of done for this repository.
#
# A check that cannot run is reported as a failure, never as a pass. Integration
# tests need a real throwaway Postgres; see README.md.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

STEPS=(
  "npm run format:check"
  "npm run lint"
  "npm run typecheck"
  "npm run test"
)

preflight_failed=()

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  STEPS+=("npm run test:integration")
else
  preflight_failed+=("integration tests: TEST_DATABASE_URL is not set")
fi

STEPS+=("npm run build")

if [ "${RUN_E2E:-0}" = "1" ]; then
  STEPS+=("npm run test:e2e")
fi

failed=()
for step in "${STEPS[@]}"; do
  echo
  echo "--- $step"
  if ! eval "$step"; then
    failed+=("$step")
  fi
done

echo
if [ ${#preflight_failed[@]} -gt 0 ]; then
  echo "COULD NOT RUN:"
  printf '  %s\n' "${preflight_failed[@]}"
  echo "  Start a throwaway database with: ./scripts/test-db.sh start"
  echo "  Then export the TEST_DATABASE_URL it prints and re-run."
fi

if [ ${#failed[@]} -gt 0 ] || [ ${#preflight_failed[@]} -gt 0 ]; then
  if [ ${#failed[@]} -gt 0 ]; then
    echo "FAILED: ${#failed[@]} of ${#STEPS[@]} checks"
    printf '  %s\n' "${failed[@]}"
  fi
  exit 1
fi

echo "PASS: ${#STEPS[@]}/${#STEPS[@]} checks"
