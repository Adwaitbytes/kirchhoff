#!/usr/bin/env bash
# Brings up the local KIRCHHOFF CCV stack in k3d. Idempotent: safe to re-run after any partial failure.
#
#   ccv/scripts/up.sh                 # cluster + Postgres + cell 1
#   CELLS="1 2 3 4" ccv/scripts/up.sh # all four cells
#   JUDGE_AUTH=hmac ccv/scripts/up.sh # also hand the verifiers the Judge HMAC credential (require_auth=true)
#
# Env:
#   CCV_STARTER_KIT  path to a chainlink-ccv-starter-kit checkout at tag v0.8.0
#                    (default: ~/.cache/kirchhoff/chainlink-ccv-starter-kit, cloned on first run)
#   CELLS            cell numbers to install (default "1")
#   JUDGE_AUTH       insecure (default) or hmac
#
# Secret values from .env are never printed: they go from .env into 0600 temp files into Kubernetes Secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CCV="$ROOT/ccv"
CLUSTER=kirchhoff
NS=kirchhoff
CHART_TAG=v0.8.0
CCV_IMAGE_TAG=v0.13.0
CELLS="${CELLS:-1}"
JUDGE_AUTH="${JUDGE_AUTH:-insecure}"
CCV_STARTER_KIT="${CCV_STARTER_KIT:-$HOME/.cache/kirchhoff/chainlink-ccv-starter-kit}"

# Selector -> .env provider prefix. Order matters only for readability.
SELECTORS=(16015286601757825753 3478487238524512106 10344971235874465080)
# (a function, not an associative array: macOS ships bash 3.2)
rpc_prefix() {
  case "$1" in
    16015286601757825753) echo RPC_ETH_SEPOLIA ;;
    3478487238524512106) echo RPC_ARB_SEPOLIA ;;
    10344971235874465080) echo RPC_BASE_SEPOLIA ;;
  esac
}

log() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for bin in docker k3d kubectl helm git openssl uuidgen; do
  command -v "$bin" >/dev/null || die "$bin is required"
done
[ -f "$ROOT/.env" ] || die "$ROOT/.env not found"
[ "$JUDGE_AUTH" = insecure ] || [ "$JUDGE_AUTH" = hmac ] || die "JUDGE_AUTH must be insecure or hmac"

# Reads one key from .env without sourcing it (values may contain shell metacharacters).
env_get() { grep -E "^$1=" "$ROOT/.env" | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

# Applies a generic Secret built from files in a directory, without printing its data.
apply_secret_dir() {
  local name="$1" dir="$2"
  kubectl -n "$NS" create secret generic "$name" --from-file="$dir" --dry-run=client -o yaml \
    | kubectl apply -f - >/dev/null
}

secret_exists() { kubectl -n "$NS" get secret "$1" >/dev/null 2>&1; }

# Reads one key of an existing Secret into a file.
secret_to_file() {
  kubectl -n "$NS" get secret "$1" -o "jsonpath={.data.$2}" | base64 -d >"$3"
}

# ---------------------------------------------------------------- chart
if [ ! -d "$CCV_STARTER_KIT/charts/ccv-cell" ]; then
  log "cloning chainlink-ccv-starter-kit $CHART_TAG into $CCV_STARTER_KIT"
  git clone --quiet https://github.com/smartcontractkit/chainlink-ccv-starter-kit "$CCV_STARTER_KIT"
fi
(cd "$CCV_STARTER_KIT" && git fetch --quiet --tags && git -c advice.detachedHead=false checkout --quiet "$CHART_TAG")
CHART="$CCV_STARTER_KIT/charts/ccv-cell"

# ---------------------------------------------------------------- cluster
if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  log "k3d cluster $CLUSTER exists"
else
  log "creating k3d cluster $CLUSTER"
  k3d cluster create "$CLUSTER" --agents 0 --no-lb --wait --timeout 180s
fi
kubectl config use-context "k3d-$CLUSTER" >/dev/null

log "importing images into the cluster"
IMAGES=(
  postgres:16-alpine
  "public.ecr.aws/chainlink/chainlink-ccv-verifier:$CCV_IMAGE_TAG"
  "public.ecr.aws/chainlink/chainlink-ccv-aggregator:$CCV_IMAGE_TAG"
)
for image in "${IMAGES[@]}"; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image" >/dev/null
done
for image in "${IMAGES[@]}"; do "$CCV/scripts/import-image.sh" "$image"; done

kubectl apply -f "$CCV/k8s/namespace.yaml" >/dev/null

# ---------------------------------------------------------------- postgres
if ! secret_exists postgres-auth; then
  mkdir -p "$TMP/pg"
  openssl rand -hex 24 | tr -d '\n' >"$TMP/pg/password"
  apply_secret_dir postgres-auth "$TMP/pg"
fi
kubectl apply -f "$CCV/k8s/postgres.yaml" >/dev/null
log "waiting for Postgres"
kubectl -n "$NS" rollout status statefulset/postgres --timeout=600s >/dev/null
secret_to_file postgres-auth password "$TMP/pgpass"
PGPASS="$(cat "$TMP/pgpass")"

psql_exec() { kubectl -n "$NS" exec -i postgres-0 -- psql -v ON_ERROR_STOP=1 -qtA -U ccv -d ccv "$@"; }

# ---------------------------------------------------------------- judge env (shared by the cells)
log "rendering Secret judge-env from .env"
mkdir -p "$TMP/judge"
for key in RPC_ETH_SEPOLIA_1 RPC_ETH_SEPOLIA_2 RPC_ARB_SEPOLIA_1 RPC_ARB_SEPOLIA_2 RPC_BASE_SEPOLIA_1 RPC_BASE_SEPOLIA_2 \
  JUDGE_HMAC_SECRET JUDGE_TIME_BUDGET_MS JUDGE_SPEC_SYNC_SECONDS; do
  value="$(env_get "$key")"
  [ -n "$value" ] && printf '%s' "$value" >"$TMP/judge/$key"
done
# The Judge's port/auth mode come from the Deployment env, not .env (JUDGE_PORT in .env is for local runs).
if [ "$JUDGE_AUTH" = hmac ]; then
  [ -s "$TMP/judge/JUDGE_HMAC_SECRET" ] || die "JUDGE_AUTH=hmac needs JUDGE_HMAC_SECRET in .env (make secrets)"
  if secret_exists judge-hmac; then
    secret_to_file judge-hmac api_key "$TMP/judge/JUDGE_HMAC_API_KEY"
  else
    mkdir -p "$TMP/hmac" && uuidgen | tr 'A-Z' 'a-z' | tr -d '\n' >"$TMP/hmac/api_key"
    apply_secret_dir judge-hmac "$TMP/hmac"
    cp "$TMP/hmac/api_key" "$TMP/judge/JUDGE_HMAC_API_KEY"
  fi
fi
apply_secret_dir judge-env "$TMP/judge"

# ---------------------------------------------------------------- cells
for n in $CELLS; do
  case "$n" in 1 | 2 | 3 | 4) ;; *) die "unknown cell $n" ;; esac
  release="kh-cell-$n"
  values="$CCV/values/cell-$n.yaml"
  signer_values="$CCV/values/cell-$n.signer.yaml"
  log "cell $n: databases"
  for db in aggregator verifier bootstrap; do
    name="cell${n}_${db}"
    [ "$(psql_exec -c "SELECT 1 FROM pg_database WHERE datname='$name'")" = 1 ] || psql_exec -c "CREATE DATABASE $name" >/dev/null
  done

  # Raw credentials are generated once and kept in kh-cell-N-creds. Rotating the keystore password would orphan
  # the signing key stored in the bootstrap database, so it is never regenerated.
  creds="$release-creds"
  if ! secret_exists "$creds"; then
    log "cell $n: generating aggregator client credential and keystore password"
    mkdir -p "$TMP/$creds"
    uuidgen | tr 'A-Z' 'a-z' | tr -d '\n' >"$TMP/$creds/aggregator_api_key"
    openssl rand -hex 32 | tr -d '\n' >"$TMP/$creds/aggregator_secret_key"
    openssl rand -hex 24 | tr -d '\n' >"$TMP/$creds/keystore_password"
    apply_secret_dir "$creds" "$TMP/$creds"
  fi
  for k in aggregator_api_key aggregator_secret_key keystore_password; do secret_to_file "$creds" "$k" "$TMP/$n.$k"; done
  api_key="$(cat "$TMP/$n.aggregator_api_key")"
  secret_key="$(cat "$TMP/$n.aggregator_secret_key")"
  keystore_password="$(cat "$TMP/$n.keystore_password")"
  pg="postgres://ccv:$PGPASS@postgres.$NS.svc.cluster.local:5432"

  log "cell $n: rendering secrets.toml Secrets"
  mkdir -p "$TMP/$n/agg" "$TMP/$n/app" "$TMP/$n/boot" "$TMP/$n/evm"
  cat >"$TMP/$n/agg/secrets.toml" <<EOF
[storage]
url = "$pg/cell${n}_aggregator?sslmode=disable"

[[clients]]
client_id = "kirchhoff-cell-$n"
api_key = "$api_key"
secret_key = "$secret_key"
EOF
  cat >"$TMP/$n/app/secrets.toml" <<EOF
[db]
url = "$pg/cell${n}_verifier?sslmode=disable"

[[aggregators]]
secret_name = "aggregator_1"
api_key = "$api_key"
secret_key = "$secret_key"
EOF
  if [ "$JUDGE_AUTH" = hmac ]; then
    cat >>"$TMP/$n/app/secrets.toml" <<EOF

[policy_hook]
api_key = "$(cat "$TMP/judge/JUDGE_HMAC_API_KEY")"
secret_key = "$(cat "$TMP/judge/JUDGE_HMAC_SECRET")"
EOF
  fi
  cat >"$TMP/$n/boot/secrets.toml" <<EOF
[db]
url = "$pg/cell${n}_bootstrap?sslmode=disable"

[keystore]
backend = "postgres"
password = "$keystore_password"
EOF
  {
    echo "[chains]"
    for sel in "${SELECTORS[@]}"; do
      prefix="$(rpc_prefix "$sel")"
      url1="$(env_get "${prefix}_1")"
      url2="$(env_get "${prefix}_2")"
      [ -n "$url1" ] || die "${prefix}_1 missing in .env"
      printf '  [chains."%s"]\n    finality_depth = 0\n' "$sel"
      printf '    [[chains."%s".nodes]]\n      name = "provider-1"\n      http_url = "%s"\n      ws_url = ""\n      order = 1\n' "$sel" "$url1"
      if [ -n "$url2" ]; then
        printf '    [[chains."%s".nodes]]\n      name = "provider-2"\n      http_url = "%s"\n      ws_url = ""\n      order = 2\n' "$sel" "$url2"
      fi
    done
  } >"$TMP/$n/evm/secrets.toml"
  apply_secret_dir "$release-aggregator-app" "$TMP/$n/agg"
  apply_secret_dir "$release-verifier-app" "$TMP/$n/app"
  apply_secret_dir "$release-verifier-bootstrap" "$TMP/$n/boot"
  apply_secret_dir "$release-verifier-evm" "$TMP/$n/evm"

  helm_args=(-n "$NS" -f "$values")
  [ -f "$signer_values" ] && helm_args+=(-f "$signer_values")
  [ "$JUDGE_AUTH" = hmac ] && helm_args+=(--set verifier.config.policy_hook.require_auth=true)
  # The Secrets are external to the chart, so a changed secret alone would not roll the pods.
  helm_args+=(--set-string "verifier.podAnnotations.kirchhoff\.xyz/secrets-rev=$(cat "$TMP/$n"/*/secrets.toml | openssl sha256 | awk '{print $NF}')")
  helm_args+=(--set-string "aggregator.podAnnotations.kirchhoff\.xyz/secrets-rev=$(openssl sha256 <"$TMP/$n/agg/secrets.toml" | awk '{print $NF}')")

  log "cell $n: helm upgrade --install $release"
  helm lint "$CHART" "${helm_args[@]}" >/dev/null
  helm upgrade --install "$release" "$CHART" "${helm_args[@]}" >/dev/null
  # A StatefulSet never replaces a pod stuck in CrashLoopBackOff with the new revision (OrderedReady rollout),
  # so a fix to a crashing cell would otherwise never land. Delete such pods so they come back on the new spec.
  for component in verifier aggregator; do
    sts="$release-ccv-cell-$component"
    current="$(kubectl -n "$NS" get sts "$sts" -o 'jsonpath={.status.currentRevision}')"
    update="$(kubectl -n "$NS" get sts "$sts" -o 'jsonpath={.status.updateRevision}')"
    if [ -n "$update" ] && [ "$current" != "$update" ]; then
      kubectl -n "$NS" delete pod "$sts-0" --wait=false >/dev/null 2>&1 || true
    fi
  done

  # First boot: the verifier generates its signing key and logs it. The aggregator must list that address as a
  # quorum signer, so record it and re-apply once.
  if [ ! -f "$signer_values" ]; then
    log "cell $n: waiting for the verifier's signer address (first boot)"
    signer=""
    for _ in $(seq 1 60); do
      signer="$(kubectl -n "$NS" logs "$release-ccv-cell-verifier-0" 2>/dev/null \
        | grep -o '"msg":"Using signer address"[^}]*' | grep -oE '0x[0-9a-fA-F]{40}' | head -n1 || true)"
      [ -n "$signer" ] && break
      sleep 5
    done
    if [ -n "$signer" ]; then
      log "cell $n: signer $signer"
      {
        echo "# Generated by ccv/scripts/up.sh from the verifier's first-boot log line \"Using signer address\"."
        echo "# Public address, not a secret. For a 4-cell committee see ccv/README.md, section 'Scale to a 4-cell committee'."
        echo "aggregator:"
        echo "  config:"
        echo "    committee:"
        echo "      quorumConfigs:"
        for sel in "${SELECTORS[@]}"; do
          printf '        "%s":\n          signers:\n            - address: "%s"\n' "$sel" "$signer"
        done
      } >"$signer_values"
      helm upgrade --install "$release" "$CHART" "${helm_args[@]}" -f "$signer_values" >/dev/null
    else
      echo "cell $n: no signer address yet; check: kubectl -n $NS logs $release-ccv-cell-verifier-0" >&2
    fi
  fi
done

log "done"
kubectl -n "$NS" get pods -o wide
