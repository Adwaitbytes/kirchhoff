# KIRCHHOFF CCV cells (local k3d)

A KIRCHHOFF cell is one Chainlink CCV verifier plus one aggregator from the official
[CCV Starter Kit](https://github.com/smartcontractkit/chainlink-ccv-starter-kit) Helm chart `ccv-cell`
**v0.8.0**, with every verifier's policy hook pointed at the in-cluster Judge
(`http://judge.kirchhoff.svc.cluster.local:8080/v1/evaluate`). The Judge is the only KIRCHHOFF code in the cell.
What runs today and what is still missing is in [STATUS.md](STATUS.md).

| Path | What |
| --- | --- |
| `values/cell-1.yaml` .. `values/cell-4.yaml` | Helm values per cell (release `kh-cell-N`, verifier id `kirchhoff-cell-N`) |
| `values/cell-N.signer.yaml` | Generated on first boot: the cell's signer address for its aggregator quorum |
| `k8s/namespace.yaml` | Namespace `kirchhoff` |
| `k8s/postgres.yaml` | In-cluster Postgres 16, one database set per cell (local only, no TLS) |
| `k8s/judge.yaml` | Judge Deployment + Service `judge` + NetworkPolicy (only verifier pods may call it) |
| `scripts/up.sh` | Cluster, images, Postgres, Secrets, cells. Idempotent |
| `scripts/judge-deploy.sh` | Imports `kirchhoff/judge:dev`, creates ConfigMap `judge-config`, applies `k8s/judge.yaml` |
| `scripts/import-image.sh` | Loads a local Docker image into the k3d node (works around a `k3d image import` bug) |
| `scripts/down.sh` | Uninstalls cells and Judge (`--cluster` deletes the cluster) |

## Prerequisites

docker (running), k3d 5.x, kubectl, helm 3.x or 4.x, git, openssl, uuidgen, and the repo `.env` with
`RPC_{ETH,ARB,BASE}_SEPOLIA_{1,2}` (and `JUDGE_HMAC_SECRET` for HMAC mode).

The chart is installed from a checkout, not a Helm repo (the starter kit publishes none):

```bash
git clone https://github.com/smartcontractkit/chainlink-ccv-starter-kit ~/.cache/kirchhoff/chainlink-ccv-starter-kit
cd ~/.cache/kirchhoff/chainlink-ccv-starter-kit && git checkout v0.8.0
```

`up.sh` does this itself when `CCV_STARTER_KIT` is unset. Images: `public.ecr.aws/chainlink/chainlink-ccv-verifier:v0.13.0`
and `public.ecr.aws/chainlink/chainlink-ccv-aggregator:v0.13.0` (the chart defaults).

## Bring up cell 1

```bash
ccv/scripts/up.sh
kubectl -n kirchhoff get pods
```

What it does, in order:

1. `k3d cluster create kirchhoff --agents 0 --no-lb` if the cluster does not exist.
2. Loads `postgres:16-alpine` and both CCV images into the node with `scripts/import-image.sh`.
3. Applies the namespace and Postgres; generates the Postgres password into Secret `postgres-auth` once.
4. Renders Secret `judge-env` from `.env` (RPC URLs, `JUDGE_*`). No secret value is ever printed.
5. Per cell: creates databases `cellN_{aggregator,verifier,bootstrap}`; generates the aggregator client credential
   (UUID + 32-byte hex) and keystore password once into `kh-cell-N-creds` (never rotated, because the signing key in
   the bootstrap DB is encrypted with it); renders the four `existingSecret`s the values reference
   (`kh-cell-N-aggregator-app`, `-verifier-app`, `-verifier-bootstrap`, `-verifier-evm`, the last holding both RPC
   providers per chain); `helm lint`; `helm upgrade --install kh-cell-N`.
6. First boot only: waits for the verifier's `Using signer address` log line, writes `values/cell-N.signer.yaml`
   and upgrades again so the aggregator accepts that signer.

Healthy looks like this (real output from this cluster):

```
kh-cell-1-ccv-cell-aggregator-0   1/1     Running   0
kh-cell-1-ccv-cell-verifier-0     1/1     Running   0
postgres-0                        1/1     Running   0
```

```bash
kubectl -n kirchhoff logs kh-cell-1-ccv-cell-verifier-0 | grep -E 'Using signer address|Policy hook enabled|fully started'
kubectl -n kirchhoff logs kh-cell-1-ccv-cell-aggregator-0 | grep -E 'gRPC server started|overall_status'
```

## Deploy the Judge

```bash
docker build -t kirchhoff/judge:dev -f judge/Dockerfile .        # from the repo root
ccv/scripts/judge-deploy.sh                                       # engine/specs/kETH.yaml + deployments/testnet.json
# or: ccv/scripts/judge-deploy.sh <spec.yaml> <deployments.json>
kubectl -n kirchhoff get pods -l app.kubernetes.io/name=judge
```

Use `ccv/scripts/import-image.sh kirchhoff/judge:dev` rather than `k3d image import`: with Docker's containerd image
store, `k3d image import` fails with `content digest ... not found` or reports success without importing.

Smoke test from inside the namespace (the NetworkPolicy admits only pods labeled `kirchhoff.xyz/role=ccv-verifier`
or `kirchhoff.xyz/role=judge-client`):

```bash
kubectl -n kirchhoff run judge-smoke --rm -i --restart=Never --image=rancher/mirrored-library-busybox:1.37.0 \
  --labels=kirchhoff.xyz/role=judge-client -- wget -qO- http://judge.kirchhoff.svc.cluster.local:8080/healthz
```

Once the Judge is up, the verifier calls it for every message whose CCV set names our resolver. Policy outcomes show
on `verifier_message_transitions_total{stage="policy"}` (OTLP push, not scraped) and in the verifier log as
`Dropping task - policy hook returned FAIL` or `Policy hook verdict unavailable, scheduling retry` (Judge 503).

## HMAC between verifier and Judge (optional)

Chart v0.8.0 has no value for the policy hook credential, but the verifier reads it from its secrets file
(`[policy_hook] api_key, secret_key`, chainlink-ccv `docs/config/verifier/secrets.documented.toml`), and with the
`existingSecret` type we write that file ourselves. So:

```bash
JUDGE_AUTH=hmac ccv/scripts/up.sh   # adds [policy_hook] to kh-cell-N-verifier-app, sets require_auth=true,
                                    # puts JUDGE_HMAC_API_KEY (generated once, Secret judge-hmac) into judge-env
# then set JUDGE_AUTH_MODE=hmac in k8s/judge.yaml and re-run ccv/scripts/judge-deploy.sh
```

The secret is `JUDGE_HMAC_SECRET` from `.env` (64 hex chars; the verifier hex-decodes it). Default mode is
unauthenticated in-cluster behind the NetworkPolicy, which is what Chainlink's docs recommend.

## Scale to a 4-cell committee

```bash
CELLS="1 2 3 4" ccv/scripts/up.sh
```

Each cell then runs with its own signer but a 1-of-1 quorum. To form the committee (threshold 3 of 4):

1. Collect the four signers: `grep -h address ccv/values/cell-*.signer.yaml | sort -u`.
2. In every `cell-N.signer.yaml`, list all four addresses under each selector and add `threshold: 3`.
3. Every verifier must write to every aggregator: add the other three aggregators to each cell's
   `verifier.config.aggregators` (address `kh-cell-M-ccv-cell-aggregator:50051`, `insecure_connection: true` in-cluster),
   one client per verifier in each `aggregator.config.clients`, and one credential pair per (verifier, aggregator) in the
   secrets (RUNBOOK.md "committee" key matrix).
4. Register the signer set on chain (STATUS.md step 2) with threshold 3, which passes the on-chain kit's strength check.

In production each cell runs in its own failure domain with its own Postgres, KMS key and Judge with its own RPCs.
This local cluster shares Postgres and one Judge between cells, a testnet-only shortcut.

## Tear down

```bash
ccv/scripts/down.sh            # keep cluster, Postgres (signing keys) and Secrets
ccv/scripts/down.sh --cluster  # delete everything
```

## Replay a message after a FAIL

A Judge FAIL is a permanent drop for that verifier. Replay (adapted from chainlink-ccv `verifier/docs/policy_hook.md`):

```bash
kubectl -n kirchhoff exec kh-cell-1-ccv-cell-verifier-0 -- /bin/verifier ccv job-queue reschedule \
  --queue task-verifier --verifier-id kirchhoff-cell-1 --message-id <0x...>
```
