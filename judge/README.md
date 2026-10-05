# @kirchhoff/judge

The CCV policy hook every KIRCHHOFF cell's committee verifier calls before it signs
(PRD section 9). `POST /v1/evaluate` implements the chainlink-ccv policy hook OpenAPI v1 spec,
copied byte-for-byte into `openapi/policy_hook_openapi_v1.yaml` from
`smartcontractkit/chainlink-ccv@d7b7b63`. The verdict logic is `@kirchhoff/engine` judge-core; this
package is the I/O shell around it: HMAC, schema validation, two-provider RPC reads, the spec cache,
the 2 s budget, logs and metrics.

## Endpoints

| Route | Answer |
| --- | --- |
| `POST <JUDGE_BASE_PATH>/v1/evaluate` | `200 {"decision":"PASS"\|"FAIL","message_id","reason"}` for a verdict; `503 {"error":"PENDING_ATTESTATION ..."}` when it cannot be confirmed yet (INTERFACES.md Revision 2: the verifier retries 5xx and drops FAIL for good); `401` bad or stale HMAC; `400` not an EvaluateRequest |
| `GET /healthz` | Liveness: `200 {"status":"ok"}` while the process serves |
| `GET /readyz` | Readiness: `200` once every token's registry spec hash is synced within `JUDGE_SPEC_MAX_AGE_SECONDS`, else `503` |
| `GET /metrics` | Prometheus: `judge_evaluate_duration_seconds{outcome}`, `judge_decisions_total{decision,reason}`, `judge_auth_failures_total{failure}`, `judge_invalid_requests_total`, `judge_spec_cache_synced{token}`, Node process metrics |

Reason strings follow `"<REASON_CODE> <symbol> <short note>"`, at most 256 characters, e.g.
`OK kETH CONSERVED delta=0 epoch=4182`, `TOKEN_BROKEN kETH DEBIT_NOT_FOUND incident=0x9f3c...`.

## What one request does (PRD section 9)

1. HMAC-SHA256 over `POST <request-target> <sha256hex(raw body)> <api-key> <ts-ms>` with the hex-decoded
   secret, 15 s window, constant-time compare. Verified against vectors produced by chainlink-ccv's own
   Go signer (`test/hmac.test.ts`).
2. Validate against the OpenAPI `EvaluateRequest` schema, then normalize with the engine's `parseHookRequest`.
3. Map `token_transfer.source_token_address` to a protected token; the cached spec hash must equal
   `KirchhoffRegistry.activeSpecHash` (synced every `JUDGE_SPEC_SYNC_SECONDS`, both providers must agree).
   `SPEC_MISMATCH` (spec hash, or a lane the spec does not declare) and `UNKNOWN_TOKEN` are answered before any ledger read.
4. No protected token: `PASS OK no protected token`.
5. In parallel through `RPC_<CHAIN>_1` and `RPC_<CHAIN>_2` (JSON-RPC batched, one round trip per provider and chain):
   `statusOf` + `latestEpoch` on the source and destination ledgers, `isFrozen` on both chains,
   `isTainted(sender)` on the source chain, and `eth_getLogs` at `source_block_number` for the source tx.
6. to 9. The engine decides. The debit is the pool's `LockedOrBurned` that precedes the OnRamp's
   `CCIPMessageSent` carrying this message id in `source_tx_hash` (CCIP 2.0.0 pool events carry no id).
   Every read reaches the engine as a provider pair; an error or disagreement is PENDING (503) unless an
   earlier, agreed step already decided (e.g. an agreed BROKEN, or an agreed `isFrozen=true`).
   Per chain and provider the ledger and quarantine reads are one Multicall3 `aggregate3` call, so both
   values come from the same block.

Stateless apart from the spec cache. Every FAIL is logged at `warn` as one JSON line with
`messageId`, `reasonCode`, `reason` and the full read `evidence`; every PENDING at `info`.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `JUDGE_SPEC_PATH` | required | KIRCH-SPEC YAML, comma-separated for several tokens |
| `JUDGE_DEPLOYMENTS_PATH` | required | `deployments/<network>.json` (engine format) |
| `RPC_ETH_SEPOLIA_1/_2`, `RPC_ARB_SEPOLIA_1/_2`, `RPC_BASE_SEPOLIA_1/_2` | required per spec chain | Two independent providers; identical URLs are refused |
| `JUDGE_AUTH_MODE` | `hmac` | `hmac` needs `JUDGE_HMAC_API_KEY` (UUID) and `JUDGE_HMAC_SECRET` (hex, at least 32 bytes) |
| `JUDGE_PORT` / `JUDGE_HOST` | `8080` / `0.0.0.0` | |
| `JUDGE_BASE_PATH` | empty | Path prefix of the verifier's `base_url`; it is part of the signed request target |
| `JUDGE_TIME_BUDGET_MS` | `2000` | Total budget per request; past it the answer is 503 |
| `JUDGE_SPEC_SYNC_SECONDS` | `60` | Registry sync interval |
| `JUDGE_SPEC_MAX_AGE_SECONDS` | 3 x sync | Older cache answers 503 |
| `JUDGE_LOG_LEVEL` | `info` | `debug` also logs every PASS |

### `insecure` mode (no HMAC)

`JUDGE_AUTH_MODE=insecure` skips step 1. It exists because the ccv-cell Helm chart v0.8.0 does not
template the verifier's `[policy_hook] api_key/secret_key` (docs/research/ccv.md). Use it only when the
Judge is reachable solely by its verifier: in `ccv/k8s/judge.yaml` a NetworkPolicy admits only pods
labeled `kirchhoff.xyz/role=ccv-verifier`. `ccv/scripts/up.sh` with `JUDGE_AUTH=hmac` writes the
credential into the verifier secrets file through the chart's `existingSecret` path and sets
`require_auth=true`; switch the Judge to `hmac` with the same `JUDGE_HMAC_API_KEY` / `JUDGE_HMAC_SECRET`.

## Run

```bash
pnpm --filter @kirchhoff/judge test          # vitest: HMAC, every FAIL and PENDING path, budget, disagreement, schema, replay
JUDGE_LIVE=1 pnpm --filter @kirchhoff/judge test   # plus live Sepolia debit lookups through both providers
node judge/src/main.ts                        # Node 26 runs the TypeScript directly; no build step
docker build -f judge/Dockerfile -t kirchhoff/judge:dev .   # from the repo root
```

Load and chaos: `load/RESULTS.md`, `CHAOS.md`. Fixtures: `test/fixtures/crafted/` (from the spec
examples) and `test/fixtures/real/` (Sepolia CCIP 2.0 sends, captured by `scripts/capture-real.ts`).

## Verdict sink (API read model)

With `VERDICT_SINK_URL` set, every answered message whose chains are in the specs is reported to the API's
`POST /internal/verdicts` (header `x-kirchhoff-internal-key` = `INTERNAL_INGEST_KEY`, falling back to
`JUDGE_HMAC_SECRET`, as on the API; `VERDICT_SINK_KEY` overrides). Reports carry `cellId` (`JUDGE_CELL_ID`, else the
request's `verifier_id`), the decision (PASS, FAIL or PENDING), reason code, note, latency, both selectors, amount,
sender, receiver, token and always `sourceTxHash`. The sink runs after the answer is written: `offer()` is synchronous,
a bounded queue (5000) drops the oldest report while the API is down (`judge_verdict_sink_dropped_total{reason="overflow"}`),
batches of up to 100 go out one at a time with backoff, and a batch the API rejects with a 4xx is dropped
(`reason="rejected"`). `test/sink.test.ts` validates reports with the API's own `parseVerdictReport` and checks a hung
API never delays a verdict.

## Live testnet check (2026-10-05)

Judge on `deployments/testnet.json` with `RPC_*_1/_2` from `.env` (Tenderly gateway and publicnode per chain), HMAC on:

```
$ JUDGE_SPEC_PATH=../engine/specs/kETH.yaml JUDGE_DEPLOYMENTS_PATH=../deployments/testnet.json node src/main.ts
{"msg":"judge listening",...,"auth":"hmac",...,"tokens":[{"symbol":"kETH","tokenId":"0xe7cb...eb9c",
 "cachedSpecHash":"0x22c75309594e0a07596c003695911bb61b1618c9519c1e6d32175ab719915dfe","active":{"state":"synced","activeSpecHash":null}}]}
$ curl -s localhost:18100/readyz
{"status":"ready"}

# real Sepolia CCIP 2.0 send (test/fixtures/real/sepolia-dca61a6f.json, tx 0xdca61a6f...d602), signed like the verifier:
HTTP 200 in 26.6ms {"decision":"PASS","message_id":"0x8d541ce3...1f54","reason":"OK no protected token"}
# the same payload with source token/pool set to testnet kETH (derived, not a real kETH send):
HTTP 200 in 21.3ms {"decision":"FAIL","message_id":"0x8d541ce3...1f54","reason":"UNKNOWN_TOKEN kETH no active spec in registry"}
# unsigned:
HTTP 401 {"error":"unauthorized"}
```

The registry read synced through both providers (Ready). kETH is registered in `KirchhoffRegistry`
(`issuerOf` = the issuer Safe `0x1fdF...fc46`) but no spec has been proposed (`pendingSpec` empty), so every kETH
message FAILs `UNKNOWN_TOKEN` deterministically, before any ledger read, until the Safe proposes and activates
`0x22c75309...5dfe` (the hash of `engine/specs/kETH.yaml` resolved against `deployments/testnet.json`). No real kETH
CCIP send exists on Sepolia yet (no `LockedOrBurned` from the kETH pool in the last 45,000 blocks).
The k3d cell's Judge runs the same testnet config (`JUDGE_AUTH=hmac ccv/scripts/judge-deploy.sh engine/specs/kETH.yaml
deployments/testnet.json`, Anvil RPC overrides removed): Ready, same log line.
