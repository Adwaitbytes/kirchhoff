# CCV cell status

Last checked 2026-10-04 against chart `ccv-cell` v0.8.0, images `chainlink-ccv-{verifier,aggregator}:v0.13.0`,
k3d v5.9.0 (k3s v1.36.4), helm v4.3.0.

**Summary: cell 1 runs in the local k3d cluster `kirchhoff` with its policy hook wired to the Judge Service, connected to
all three Sepolia testnets through two RPC providers each. It cannot attest a real kETH message yet, because our
VersionedVerifierResolver is not deployed and kETH's pools do not require it. Until those exist, Fallback B
(KirchhoffTokenPool, contracts workstream) is the live enforcement path.**

## What runs

```
$ kubectl -n kirchhoff get pods
NAME                              READY   STATUS    RESTARTS   AGE
kh-cell-1-ccv-cell-aggregator-0   1/1     Running   0          2m44s
kh-cell-1-ccv-cell-verifier-0     1/1     Running   0          3m55s
postgres-0                        1/1     Running   0          20m

$ helm -n kirchhoff list
NAME       NAMESPACE  REVISION  STATUS    CHART
kh-cell-1  kirchhoff  5         deployed  ccv-cell-0.0.0      # chart version is stamped by upstream CI; source is tag v0.8.0
```

Verifier log (real, trimmed to the fields that matter):

```
"msg":"Resolved aggregators","count":1
"msg":"Using signer address","address":"0x4023f54d29d34868828724590b2f592b1dd14910"
"msg":"Policy hook enabled","endpoint":"http://judge.kirchhoff.svc.cluster.local:8080/v1/evaluate","retryDelay":"10s","authenticated":false
"msg":"RPC Node is online","chainSelector":"16015286601757825753","nodeName":"provider-1" ... "nodeState":"Alive"
   (Alive for provider-1 and provider-2 on all three selectors)
"msg":"Coordinator started successfully","verifierID":"kirchhoff-cell-1"
"msg":"🎯 Verifier service fully started and ready!"
"msg":"🌐 HTTP server starting","port":8100
"msg":"Healthy\n"
```

Aggregator log (real):

```
"msg":"Successfully resolved secrets"
"msg":"Database connection pool configured","maxOpenConns":25,...
"msg":"gRPC server started :50051"
"msg":"Service health summary",...,"overall_status":"ready","components":{"aggregation_service":"healthy",...
```

Verified behaviour:

- Placeholder resolver addresses do **not** stop either component from starting. Neither validates the resolver
  on chain at boot; the verifier simply never sees a message whose CCV set names `0x...cc01`, so it idles.
- The aggregator quorum carries the real signer (`values/cell-1.signer.yaml`, generated from the log line above).
- Judge NetworkPolicy, tested with a stand-in pod behind Service `judge` (removed afterwards): a pod labeled
  `kirchhoff.xyz/role=ccv-verifier` got `REACHABLE`, an unlabeled pod got `BLOCKED`, and kubelet readiness probes kept
  working. The real verifier pod carries `kirchhoff.xyz/role=ccv-verifier`.
- `up.sh` is idempotent: a second run changed nothing and restarted no pod.
- Replay command works in the pod: `kubectl -n kirchhoff exec kh-cell-1-ccv-cell-verifier-0 -- /bin/verifier ccv job-queue reschedule --help`.

## Judge in the cell

The Judge Deployment runs in the cell and the policy hook is authenticated end to end (`JUDGE_AUTH=hmac`):

```
$ JUDGE_AUTH=hmac ccv/scripts/up.sh
$ kubectl -n kirchhoff logs kh-cell-1-ccv-cell-verifier-0 | grep 'Policy hook'
"msg":"Policy hook enabled","endpoint":"http://judge.kirchhoff.svc.cluster.local:8080/v1/evaluate","retryDelay":"10s","authenticated":true

$ docker build -f judge/Dockerfile -t kirchhoff/judge:dev .
$ JUDGE_AUTH=hmac JUDGE_RPC_ENV=judge/load/anvil/k3d-rpc.env \
    ccv/scripts/judge-deploy.sh engine/specs/kETH.yaml judge/load/anvil/out/deployments.json
$ kubectl -n kirchhoff logs deploy/judge | head -1
{"level":"info","msg":"judge listening",...,"auth":"hmac","budgetMs":2000,"tokens":[{"symbol":"kETH",...,"active":{"state":"synced",...}}]}
```

The Judge reads the same `JUDGE_HMAC_API_KEY` / `JUDGE_HMAC_SECRET` that `up.sh` writes into the verifier's
`[policy_hook]` secrets (Secret `judge-env`).

**Which chains it reads.** There is no testnet KIRCHHOFF deployment yet (`deployments/testnet.json` does not exist),
so the in-cluster Judge is pointed at the private Anvil chains of `judge/load/anvil` (real ConservationLedger,
QuarantineController and KirchhoffRegistry from `contracts/script/Deploy.s.sol`, spec registered and active, CONSERVED
epochs), reached at `host.k3d.internal`. Pointed at the testnet RPCs with addresses that have no code, it does what it
should: the registry read fails, the spec cache stays unsynced, `/readyz` is 503 and the pod is never Ready, so the
verifier's calls are refused and retried:

```
{"level":"warn","msg":"spec cache sync failed","token":"kETH","note":"registry activeSpecHash read failed: The contract function \"activeSpecHash\" returned no data (\"0x\"). | ..."}
```

Once `deployments/testnet.json` exists: `JUDGE_AUTH=hmac ccv/scripts/judge-deploy.sh engine/specs/kETH.yaml deployments/testnet.json`
(no `JUDGE_RPC_ENV`, so `judge-env`'s testnet `RPC_*_1/_2` apply; `kubectl -n kirchhoff set env deployment/judge RPC_...-`
removes the Anvil overrides).

Smoke checks from inside the cluster (real output):

```
pod labeled kirchhoff.xyz/role=ccv-verifier, signed like the verifier:
  HTTP 200 {"decision":"PASS","message_id":"0x5a5a...5a5a","reason":"OK kETH CONSERVED delta=0 epoch=1791069405"}
same pod, unsigned:
  HTTP 401 {"error":"unauthorized"}
unlabeled pod (NetworkPolicy):
  curl: (7) Failed to connect to judge.kirchhoff.svc.cluster.local port 8080
Judge scaled to 0 (PRD 14 "Judge unreachable"): EndpointSlice empty, labeled pod gets
  curl: (7) Failed to connect ... -> the verifier reads this as "verdict unknown" and retries; scaled back to 1
```

The verifier itself has not called the Judge yet: it only does so for a finalized message that names our CCV,
which needs items 1 to 3 below.

## Problems hit and fixed

| Symptom | Cause | Fix |
| --- | --- | --- |
| `k3d image import`: `ctr: content digest sha256:... not found`, or "Successfully imported" with nothing in `crictl images` | Docker's containerd image store keeps a multi-platform index without the other platforms' blobs | `scripts/import-image.sh`: `docker save --platform linux/<node arch> | ctr -n k8s.io images import -` |
| Verifier `OOMKilled` (exit 137) 1s after start at a 512Mi limit, right after `key already exists ... bootstrap_default_csa_key` | Keystore unlock needs more memory | limit 2Gi (chart's own example pod limit) |
| Fixed StatefulSet never replaced the crashing pod | OrderedReady rollout waits on the broken pod | `up.sh` deletes a pod whose revision is behind the StatefulSet's update revision |

## Known runtime noise

- Base Sepolia keyless RPCs flap: in the first 2 minutes the verifier logged 92 `No live RPC nodes available` for
  selector `10344971235874465080` (Ethereum Sepolia: 0, Arbitrum Sepolia: 4 out-of-sync blips). Both providers are
  keyless public endpoints (Tenderly gateway, publicnode). The starter kit itself warns public nodes stall under
  verifier load. For a real attestation run, put a keyed RPC first in `.env` `RPC_BASE_SEPOLIA_1` and re-run `up.sh`.
- The verifier logs RPC URLs in clear (`"node":"(primary)provider-1:https://..."`). Ours carry no key today; a keyed
  URL would leak into pod logs.
- The verifier's config reference says `retry_delay` doubles per attempt, capped at 1h; the OpenAPI spec text says it
  does not grow. Either way a Judge 503 is retried, never dropped.

## What is missing for a real CCV attestation (in order)

All of it is self-serve except item 5 (docs/research/ccv.md section 5). The deployer key and testnet ETH already exist.

1. **Deploy our CCV contracts** with the on-chain kit
   (`smartcontractkit/chainlink-ccv-starter-kit-contracts`, forge 1.8.1, `@chainlink/contracts-ccip` 2.0.0), on
   Sepolia, Arbitrum Sepolia and Base Sepolia:
   ```bash
   make install && cp .env.example .env    # PRIVATE_KEY, SEPOLIA_RPC_URL, ARBITRUM_SEPOLIA_RPC_URL, BASE_SEPOLIA_RPC_URL, OUTPUT_MODE=EOA
   make seed-operator-config && make build
   make add-chain CHAIN=sepolia SELECTOR=16015286601757825753          # and arbitrum-sepolia, base-sepolia
   make bootstrap-factory CHAIN=<chain> RPC_URL=<rpc>                    # per chain
   make deploy-resolver   CHAIN=<chain> RPC_URL=<rpc>                    # CREATE2: same address on every chain
   make deploy-verifier   CHAIN=<chain> TAG=0x00010001 RPC_URL=<rpc>
   make apply-remote-config / apply-inbound / apply-outbound ...         # lane config, see the kit's commands doc
   make deployments-check                                                # resolver address parity
   ```
   Then replace every `0x000000000000000000000000000000000000cc01` in `values/cell-*.yaml` with the resolver
   (never the implementation: an implementation gives green pods that never attest) and re-run `up.sh`.
2. **Register the signer set** on each destination chain's verifier:
   `ALLOW_WEAK_COMMITTEE=true make apply-signature-configs CHAIN=<chain> TAG=0x00010001` with signer
   `0x4023f54d29d34868828724590b2f592b1dd14910` (cell 1). A 1-of-1 committee is rejected without
   `ALLOW_WEAK_COMMITTEE=true` (testnet only); 3-of-4 is the smallest strong committee.
3. **Make kETH require our CCV**: deploy `AdvancedPoolHooks` (or the Fallback B hook subclass) with the pool as
   authorized caller, set it on each kETH pool, and call
   `applyCCVConfigUpdates([{remoteChainSelector, outboundCCVs: [address(0), resolver], inboundCCVs: [address(0), resolver], ...}])`
   for every remote chain, so the Chainlink default committee stays required next to ours (docs/research/ccip.md
   section 4). Check with `ccip-cli send ... --only-ccvs`.
4. **Expose the aggregator** over TLS with a publicly trusted certificate (HTTP/2 + gRPC end to end, stable hostname),
   e.g. a cloud VM with cert-manager + Let's Encrypt. Not possible from a laptop k3d cluster without a tunnel.
   `ccip-cli manual-exec <src-tx> --verifiers grpcs://<aggregator-host>:443` then executes messages ourselves.
5. **Indexer onboarding** (default executor runs our messages automatically) is NOT self-serve: email
   `clusersupport@smartcontract.com`; undersized committees are not onboarded. Plan: self-execute with
   `ccip-cli manual-exec` (item 4). Tracked in HUMAN_TASKS.md.

Finality pacing: a default (finalized) message on Ethereum Sepolia reaches the verifier, and so the Judge, roughly
13 to 17 minutes after the send.

## Testnet-only shortcuts (say so on the slide)

- Signing key in the Postgres keystore, not cloud KMS. Secrets are plain Kubernetes Secrets (`existingSecret`).
- One shared in-cluster Postgres without TLS (`sslmode=disable`); production wants one TLS Postgres per cell.
- One Judge shared by all local cells; production runs one Judge per cell with that cell's own RPC providers.
- Judge called over in-cluster plain HTTP, unauthenticated, behind a NetworkPolicy (HMAC available via `JUDGE_AUTH=hmac`).
