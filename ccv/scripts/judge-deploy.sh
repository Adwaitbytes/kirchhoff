#!/usr/bin/env bash
# Deploys the Judge into the kirchhoff namespace. Run after ccv/scripts/up.sh (which creates Secret judge-env).
#
#   docker build -t kirchhoff/judge:dev -f judge/Dockerfile .   # from the repo root
#   ccv/scripts/judge-deploy.sh [spec.yaml] [deployments.json]
#
# Env:
#   JUDGE_AUTH=insecure|hmac   must match the JUDGE_AUTH the cells were installed with (ccv/scripts/up.sh);
#                              hmac reads JUDGE_HMAC_API_KEY / JUDGE_HMAC_SECRET from Secret judge-env.
#   JUDGE_RPC_ENV=<file>       KEY=VALUE lines overriding judge-env's RPC_* (e.g. the private Anvil chains of
#                              judge/load/anvil, reached from k3d at host.k3d.internal).
#
#   VERDICT_SINK_URL=<url>     overrides judge-env's API base URL for the verdict sink (e.g. http://host.k3d.internal:8080).
#
# Defaults: engine/specs/kETH.yaml and deployments/testnet.json. Both are mounted read-only at /etc/judge.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS=kirchhoff
IMAGE=kirchhoff/judge:dev
SPEC="${1:-$ROOT/engine/specs/kETH.yaml}"
DEPLOYMENTS="${2:-$ROOT/deployments/testnet.json}"

docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "build $IMAGE first (see header)" >&2; exit 1; }
[ -f "$SPEC" ] || { echo "spec not found: $SPEC" >&2; exit 1; }
[ -f "$DEPLOYMENTS" ] || { echo "deployments not found: $DEPLOYMENTS (run the testnet deploy first)" >&2; exit 1; }
kubectl -n "$NS" get secret judge-env >/dev/null || { echo "Secret judge-env missing: run ccv/scripts/up.sh" >&2; exit 1; }

"$ROOT/ccv/scripts/import-image.sh" "$IMAGE"
kubectl -n "$NS" create configmap judge-config \
  --from-file=spec.yaml="$SPEC" --from-file=deployments.json="$DEPLOYMENTS" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -f "$ROOT/ccv/k8s/judge.yaml"
JUDGE_AUTH="${JUDGE_AUTH:-insecure}"
[ "$JUDGE_AUTH" = insecure ] || [ "$JUDGE_AUTH" = hmac ] || { echo "JUDGE_AUTH must be insecure or hmac" >&2; exit 1; }
kubectl -n "$NS" set env deployment/judge "JUDGE_AUTH_MODE=$JUDGE_AUTH" >/dev/null
[ -z "${VERDICT_SINK_URL:-}" ] || kubectl -n "$NS" set env deployment/judge "VERDICT_SINK_URL=$VERDICT_SINK_URL" >/dev/null
if [ -n "${JUDGE_RPC_ENV:-}" ]; then
  # shellcheck disable=SC2046
  kubectl -n "$NS" set env deployment/judge $(grep -E '^RPC_[A-Z_]+_[12]=' "$JUDGE_RPC_ENV") >/dev/null
fi
# The tag is reused (dev), so force new pods to pick up a re-imported image.
kubectl -n "$NS" rollout restart deployment/judge >/dev/null
kubectl -n "$NS" rollout status deployment/judge --timeout=120s
