#!/usr/bin/env bash

set -uo pipefail

# Add one line per check once the stack is chosen, e.g.:
#   STEPS=("npm run lint" "npm run typecheck" "npm test" "npm run build")
STEPS=()

if [ ${#STEPS[@]} -eq 0 ]; then
  echo "FAIL: verify.sh is not configured for this project's stack yet."
  echo "Add checks to the STEPS array in scripts/verify.sh."
  exit 1
fi

failed=()
for step in "${STEPS[@]}"; do
  echo "--- $step"
  if ! eval "$step"; then
    failed+=("$step")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  echo
  echo "FAILED: ${#failed[@]} of ${#STEPS[@]} checks"
  printf '  %s\n' "${failed[@]}"
  exit 1
fi

echo
echo "PASS: ${#STEPS[@]}/${#STEPS[@]} checks"
