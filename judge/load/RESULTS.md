# Judge load test results (PRD section 17: 100 rps, p99 under 300 ms)

`judge/load/k6.js`, constant arrival rate 100 requests per second for 60 s, every request HMAC-signed exactly as
the chainlink-ccv verifier signs, every answer checked for HTTP 200 `PASS`. k6 v1, Node 26.8.2, Apple Silicon
(15 cores), 2026-10-04. Shared machine: other workstreams (Playwright suites, a k3d cluster, Anvil deploys) ran at
the same time, so the 1-minute load average is printed with every run.

The numbers below are for the current code (engine `ReadPair` reads through both providers, Multicall3 batching:
per message, per provider, one `aggregate3` eth_call per chain plus one `eth_getLogs`).

## Summary

| Run | Backend | p50 | p90 | p99 | max | Failed | Load avg (1 min, start/end) | Target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | In-process JSON-RPC stubs (3 chains x 2 providers) | **3.64 ms** | 4.90 ms | **6.13 ms** | 18.35 ms | 0 / 6001 | 22.6 / 10.7 | met |
| B | 3 private Anvil chains, real KIRCHHOFF contracts, provider 2 = same node | **3.46 ms** | 41.83 ms | **485.9 ms** | 578.6 ms | 0 / 5984 (17 dropped) | 19.1 / 15.2 | missed |
| C | 3 private Anvil chains, provider 2 = an Anvil fork of each chain | 3.19 ms | 131.7 ms | 1.12 s | 1.5 s | 0 / 5852 (148 dropped) | 43.6 / 26.0 | missed |

Run A meets the target with two orders of magnitude to spare. The Anvil runs do not: the median is the same 3 ms,
but the tail is the local Anvil nodes, not the Judge (evidence below).

## Run A: stub RPCs (real output)

```
$ node load/stub-chains.ts &      # ports 18545-18550
$ JUDGE_PORT=18080 JUDGE_SPEC_PATH=../engine/specs/kETH.yaml JUDGE_DEPLOYMENTS_PATH=test/fixtures/deployments.test.json \
  JUDGE_HMAC_API_KEY=... JUDGE_HMAC_SECRET=... node src/main.ts &   # RPC_* from load/stub.env
$ k6 run -e JUDGE_URL=http://127.0.0.1:18080 -e PAYLOAD=./payload.json -e HMAC_API_KEY=... -e HMAC_SECRET=... load/k6.js

 5:09  up  9:45, 3 users, load averages: 22.55 23.56 30.07
  █ THRESHOLDS
    checks
    ✓ 'rate==1.0' rate=100.00%
    dropped_iterations
    ✓ 'count==0' count=0
    http_req_duration
    ✓ 'p(99)<300' p(99)=6.13ms
  █ TOTAL RESULTS
    checks_total.......: 12002   200.015672/s
    checks_succeeded...: 100.00% 12002 out of 12002
    checks_failed......: 0.00%   0 out of 12002
    ✓ status 200
    ✓ decision PASS
    HTTP
    http_req_duration..............: min=1.32ms med=3.64ms avg=3.84ms p(90)=4.9ms p(95)=5.24ms p(99)=6.13ms max=18.35ms
    http_req_failed................: 0.00%  0 out of 6001
    http_reqs......................: 6001   100.007836/s
    EXECUTION
    dropped_iterations.............: 0      0/s
    iterations.....................: 6001   100.007836/s
 5:10  up  9:46, 3 users, load averages: 10.73 19.99 28.29
```

An earlier run of the previous build (before the engine took over provider disagreement and before Multicall3)
at load 5.7 gave `p(50)=2.76ms p(99)=4.2ms max=51.05ms`, 0 of 6000 failed. A run at load 13.8 to 18 gave
`p(99)=516.16ms` with 18 dropped iterations, and the Judge's own `judge_evaluate_duration_seconds` histogram showed the
same tail: on this machine, CPU contention alone can push p99 past the target.

## Run B: private Anvil chains (real output)

Setup (`load/anvil/setup.sh`, `setup.ts`): three Anvil nodes on 28545-28547 with the CCIP selectors and chain ids
31337-31339, separate from the shared `demo/anvil-up.sh` chains (which another workstream restarted mid-run once).
Real `ConservationLedger`, `QuarantineController`, `KirchhoffRegistry` from `contracts/script/Deploy.s.sol`; the kETH
spec hash proposed and activated in the registry; a CONSERVED `EPOCH` report on every ledger through the
`MockKeystoneForwarder`; the debit (`LockedOrBurned` then `CCIPMessageSent`, one transaction) emitted by two
`LogEmitter` stand-ins for the CCIP pool and OnRamp, since Anvil has no CCIP. Interval mining off
(`evm_setIntervalMining 0`). Every answer was `PASS OK kETH CONSERVED delta=0 epoch=1791069405`.

```
 5:11  up  9:48, 3 users, load averages: 19.14 20.34 27.66
  █ THRESHOLDS
    checks
    ✓ 'rate==1.0' rate=100.00%
    dropped_iterations
    ✗ 'count==0' count=17
    http_req_duration
    ✗ 'p(99)<300' p(99)=485.9ms
  █ TOTAL RESULTS
    checks_succeeded...: 100.00% 11968 out of 11968
    ✓ status 200
    ✓ decision PASS
    HTTP
    http_req_duration..............: min=1.36ms med=3.46ms avg=25.86ms p(90)=41.83ms p(95)=162.11ms p(99)=485.9ms max=578.6ms
    http_req_failed................: 0.00%  0 out of 5984
    http_reqs......................: 5984   99.724656/s
    EXECUTION
    dropped_iterations.............: 17     0.283309/s
 5:12  up  9:49, 3 users, load averages: 15.22 19.13 26.71
```

Run C (provider 2 = `anvil --fork-url` of each chain, `load/anvil/forks.sh`) at load 43.6 to 54:
`med=3.19ms p(90)=131.7ms p(95)=493.21ms p(99)=1.12s max=1.5s`, 0 of 5852 failed, 148 dropped iterations.

## Why the Anvil tail is Anvil

Measured on the same machine during the session:

| Probe | Result |
| --- | --- |
| Judge + Anvil, one request at a time, n=500 | p50 3.03 ms, p90 4.18 ms, p99 37.56 ms |
| Raw Anvil, `eth_getLogs` + `eth_blockNumber` batches at 400/s (the Judge's request rate), n=6956 | p50 0.65 ms, p99 3.01 ms |
| Raw Anvil, 3x `eth_call` batches at 400/s, n=5928 of 8000 sent | p50 0.93 ms, p90 16.44 ms, **p99 250.54 ms**, max 635 ms |
| Same Judge, same code, stub RPCs (run A) | p99 6.13 ms |

A single Anvil node per chain cannot serve 100 messages per second of state reads (two providers x ledger and
quarantine reads) at a flat latency on a contended machine; the Judge itself adds about 3 ms. Moving the reads
into one Multicall3 call per chain and provider (this build) cut the Anvil-run p99 from 2.14 s (with 25 budget
timeouts) to 486 ms. What the Anvil runs do show: zero wrong verdicts and zero errors, with every slow answer still a
correct PASS inside the 2 s budget.

## Run D: real contracts on Anvil, two independent providers, quiet machine (2026-10-06)

Same Judge build and harness as run C (provider 1 = origin Anvil node per chain, provider 2 = a separate
`anvil --fork-url` process), HMAC-signed requests, 100 rps for 60 s, measured with the machine at a 1-minute load
average of about 4 (runs B and C ran at 15 to 54 alongside Playwright suites and a k3d cluster).

| Metric | Value |
| --- | --- |
| Requests | 6001 at 100.0 rps, 0 dropped iterations |
| Failed requests | 0 of 6001 |
| Checks | 12002 of 12002 succeeded (every answer a correct PASS) |
| http_req_duration | min 1.07 ms, p50 4.26 ms, p90 5.37 ms, p95 5.96 ms, **p99 9.31 ms**, max 22.79 ms |
| Threshold `p(99)<300` | passed |

This is the measurement to quote for the PRD target (p99 under 300 ms at 100 rps): the earlier Anvil misses were
caused by machine contention, not by the Judge.

## Against real testnet RPCs (not a load test)

The live Sepolia check in `test/replay.test.ts` (`JUDGE_LIVE=1`) ran the debit lookup through both keyless
providers: 397 to 677 ms per message. Public RPC round trips, not the Judge, set testnet latency; the 2 s budget
covers them and the verifier's call timeout is 5 s.

## Reproduce

```bash
cd judge
node load/stub-chains.ts &                                   # run A backend
load/anvil/setup.sh && node load/anvil/setup.ts && load/anvil/forks.sh   # runs B/C backend (writes load/anvil/out/)
set -a; . load/anvil/out/judge.env; set +a; JUDGE_PORT=18090 JUDGE_HMAC_API_KEY=... JUDGE_HMAC_SECRET=... node src/main.ts &
k6 run -e JUDGE_URL=http://127.0.0.1:18090 -e PAYLOAD=./anvil/out/payload.json -e HMAC_API_KEY=... -e HMAC_SECRET=... load/k6.js
```
