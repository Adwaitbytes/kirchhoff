#!/usr/bin/env bash
# Light chaos run for PRD section 17 against PRD section 14's failure table, on the stub chains:
# kill one RPC, a provider erroring, pause W2 (status stale), kill the Judge, restart it.
# Prints a transcript; judge/CHAOS.md records a real run.
set -euo pipefail
cd "$(dirname "$0")/.."
SC="${TMPDIR:-/tmp}/kirchhoff-chaos"
mkdir -p "$SC"
PORT=18081
CTL=http://127.0.0.1:18599

node load/stub-chains.ts >"$SC/stubs.log" 2>&1 &
STUBS=$!
cleanup() { kill "$STUBS" "${JUDGE:-}" 2>/dev/null || true; }
trap cleanup EXIT
until [ -f load/stub.env ] && curl -s -o /dev/null "$CTL/" 2>/dev/null; do sleep 0.2; done

start_judge() {
  (set -a; . load/stub.env; set +a
   JUDGE_PORT=$PORT JUDGE_AUTH_MODE=insecure JUDGE_SPEC_PATH=../engine/specs/kETH.yaml \
   JUDGE_DEPLOYMENTS_PATH=test/fixtures/deployments.test.json exec node src/main.ts) >>"$SC/judge.log" 2>&1 &
  JUDGE=$!
  until curl -sf -o /dev/null "http://127.0.0.1:$PORT/readyz"; do sleep 0.2; done
}

evaluate() {
  local label="$1" out code
  out=$(curl -s -o "$SC/body" -w '%{http_code} %{time_total}' -X POST -H 'content-type: application/json' \
    --data @load/payload.json "http://127.0.0.1:$PORT/v1/evaluate" || true)
  code=$?
  if [ -z "$out" ] || [ "${out%% *}" = "000" ]; then
    printf '%-44s -> no answer (connection refused): the verifier reads this as "verdict unknown" and retries\n' "$label"
  else
    printf '%-44s -> HTTP %s in %ss  %s\n' "$label" "${out%% *}" "${out##* }" "$(cat "$SC/body")"
  fi
}

ctl() { curl -s -X POST "$CTL/$1" >/dev/null; }

start_judge
evaluate "baseline"
ctl RPC_ETH_SEPOLIA_2/down;  evaluate "kill home RPC provider 2"
ctl RPC_ETH_SEPOLIA_2/up;    evaluate "home RPC provider 2 back"
ctl RPC_ARB_SEPOLIA_1/rpc-error; evaluate "arb RPC provider 1 returns errors"
ctl RPC_ARB_SEPOLIA_1/ok
ctl RPC_ARB_SEPOLIA_2/down; ctl RPC_ARB_SEPOLIA_1/down; evaluate "both arb providers down"
ctl RPC_ARB_SEPOLIA_1/up; ctl RPC_ARB_SEPOLIA_2/up
ctl stale/on;                evaluate "pause W2 (every ledger stale), fail_closed"
ctl stale/off;               evaluate "W2 resumes (fresh epoch)"
kill "$JUDGE"; wait "$JUDGE" 2>/dev/null || true
evaluate "kill the Judge"
start_judge;                 evaluate "Judge restarted (retry answers)"
echo
echo "judge_decisions_total after the run:"
curl -s "http://127.0.0.1:$PORT/metrics" | grep '^judge_decisions_total' || true
echo
echo "Judge PENDING/FAIL log lines (first 3):"
grep -E '"verdict (pending|FAIL)' "$SC/judge.log" | head -3 | cut -c1-400
