#!/usr/bin/env bash
# Tears down the local KIRCHHOFF CCV stack.
#
#   ccv/scripts/down.sh            # uninstall the cells and the Judge, keep the cluster, Postgres and Secrets
#   ccv/scripts/down.sh --cluster  # delete the whole k3d cluster (signing keys in Postgres are lost)
set -euo pipefail
CLUSTER=kirchhoff
NS=kirchhoff
if [ "${1:-}" = --cluster ]; then
  k3d cluster delete "$CLUSTER"
  exit 0
fi
kubectl config use-context "k3d-$CLUSTER" >/dev/null
for release in $(helm -n "$NS" list -q | grep -E '^kh-cell-[0-9]+$' || true); do
  helm -n "$NS" uninstall "$release"
done
kubectl -n "$NS" delete deployment/judge service/judge networkpolicy/judge-ingress --ignore-not-found
