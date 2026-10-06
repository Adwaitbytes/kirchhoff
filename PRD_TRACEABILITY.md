# PRD traceability matrix

Every requirement in [docs/PRD.md](docs/PRD.md), sections 1 to 20, mapped to code, test and status.
Audited 2026-10-05 against the working tree (including uncommitted files) by reading and grepping the code, running
the test suites, and reading testnet state with `cast call`. Re-audited 2026-10-06 at commit `6ad7ab8` plus the
working tree by reading and grepping the code, the commit log since `d9437b1`, the green GitHub CI run
[37393797827](https://github.com/Adwaitbytes/kirchhoff/actions/runs/37393797827), `workflows/SIMULATION_LOG.md`,
`demo/logs/*.log`, the local Playwright report, and testnet state with `cast call` / `cast logs`. No suite was re-run
locally for the re-audit.

**Statuses**

- **DONE**: implemented, with the code and the test or run evidence named in the row.
- **FALLBACK**: the PRD path is blocked by something outside the repo; the PRD-sanctioned fallback is in place. Reason given.
- **CUT**: an item from the PRD section 16 cut list, cut with its listed fallback. Nothing else is marked CUT.
- **PENDING**: not finished; the row says what remains. Rows whose note starts with **Roadmap** are post-hackathon
  by design in the PRD itself (12-month goals, v1 adapters, section 18), not hackathon work.

**Evidence baseline (2026-10-05 local runs, updated 2026-10-06 from CI and recorded logs)**

| Command | Result |
| --- | --- |
| `pnpm -r test` (CI run 37393797827, commit `6ad7ab8`, Postgres 17 service) | engine 251, workflows 54, judge 96 (+3 skipped, need `JUDGE_LIVE=1`), ai 33, api 28, indexer 10, sdk 8, mcp 6, demo 8 passed (494 passed) |
| `pnpm --filter @kirchhoff/engine coverage` | 100% on all four columns (CI run 37393797827); 2026-10-05 local run: statements 894/894, branches 586/586, functions 203/203, lines 736/736 |
| `cd contracts && forge test` | 150 passed, 0 failed, 10 suites (CI run 37393797827) |
| Playwright `web/e2e` (local report, 2026-10-06) | 124 / 124 passed, incl. axe WCAG 2.2 AA on 11 routes in both themes and keyboard suites |
| `bash scripts/no-ai-in-veto-path.sh` | OK |
| `cast call <ledger> statusOf(kETH)` on all 3 testnets | 2026-10-05: `UNKNOWN`. 2026-10-06: spec `0x22c75309...5dfe` active; ledgers went CONSERVED (first EPOCH), BROKEN (Loop BREACH, Δ -116,500 kETH), QUARANTINED, RECOVERING, then CONSERVED again (`cast logs StatusChanged`, `demo/logs/testnet-reset0.log`) |
| Etherscan V2 `getsourcecode` for every testnet contract | all verified; Arbitrum Sepolia `ConservationFeed` verified on Blockscout only |
| `cre whoami` | logged in, `Deploy Access: Not enabled` |

Abbreviations: `SIM_LOG` = `workflows/SIMULATION_LOG.md`; `CL` = `contracts/src/ConservationLedger.sol`;
`CLt` = `contracts/test/ConservationLedger.t.sol`; `JC` = `engine/src/judge-core.ts`;
`Jt` = `judge/test/evaluate.test.ts`; `MCs` = `web/e2e/mission-control.spec.ts`; `IRs` = `web/e2e/incident-room.spec.ts`;
`ALs` = `web/e2e/attack-lab.spec.ts`; `APIt` = `api/test/api.int.test.ts`.

## Summary

| Status | Count |
| --- | --- |
| DONE | 378 |
| FALLBACK | 17 |
| CUT | 6 |
| PENDING (hackathon work remaining) | 49 |
| PENDING (Roadmap, post-hackathon by design) | 16 |
| **Total requirements** | **466** |

Unmapped requirements: 0. Every row carries exactly one of the four statuses (the counting commands at the end
sum to the row count). The 6 CUT rows all trace to cut list items 4 (LayerZero adapter) and 5 (4-cell committee);
items 1 to 3, 6 and 7 were not cut. Demo video and deck work is paused by the product owner: those rows stay
PENDING with the note "Deferred by product owner", never CUT.

Counts are produced from this file by `grep -c` on the status column (see the end of the file).

---

## 1. Overview

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 1.R1 | Conservation Engine: CRE workflow reading supply, locks and reserves on 3+ chains with DON consensus | `workflows/src/w1.ts`..`w4.ts`, `workflows/src/cre-io.ts` | SIM_LOG scenarios 1-6 | FALLBACK | Runs via `cre workflow simulate` (deploy access not enabled). Simulation is single node; consensus reads are the same SDK calls a DON makes |
| 1.R2 | KIRCHHOFF CCV: policy hook plus onchain verifier signing PASS or FAIL per CCIP message | `judge/src`, `ccv/`, `contracts/src/KirchhoffTokenPool.sol` | `judge/test/*` (96 passed); `contracts/test/KirchhoffTokenPool.t.sol` | FALLBACK | Cell runs but cannot attest (CCV resolver not deployed, not onboarded). Fallback B pools enforce |
| 1.R3 | Quarantine: excess frozen on the infected chain; clean chains keep working | `contracts/src/QuarantineController.sol`, `workflows/src/w3.ts` | CLt `test_breach_fromConservedSetsBrokenAndContains`, `test_quarantine_fromBroken`; SIM_LOG scenario 3 | DONE | Lanes for the token freeze and the recipient is tainted; untainted holders keep transferring (Guard blocks only tainted senders) |
| 1.R4 | Mission Control: live ledger UI of every chain, the invariant and every verdict | `web/components/mission/*` | MCs (10 tests) | DONE | Public deployment tracked in 15.SUB2 |
| 1.R5 | Spec Copilot turns plain English into a machine-checked spec; AI never in the veto path | `ai/src/copilot/*`, `scripts/no-ai-in-veto-path.sh` | `ai/test/copilot.int.test.ts`; `ai/eval/RESULTS.md` sections 1-2 | DONE | |
| 1.R6 | Kelp Replay: scripted forged-message attack that fails | `demo/attack-kelp-replay.ts`, `demo/src/attack.ts`, `demo/e2e.ts` | SIM_LOG scenario 3 (local, 7 kETH); `demo/logs/testnet-run1*.log` | PENDING | Testnet simulation: the Loop Rule BREACH (Δ -116,500 kETH), W3 quarantine and Safe resolution are onchain on all 3 testnets (README "Testnet transactions"), but no `demo e2e --network testnet` has passed: runs 1 and 1b died on RPC 429s, run 1c stopped at the baseline assert because the ledgers were still BROKEN from an earlier attack. A 3-run series was running at audit time (`demo/logs/series.txt`) |
| 1.R7 | Tagline "Every bridge checks who signed. KIRCHHOFF checks if the money adds up." | `web/components/landing/landing.tsx:83`, `README.md` | n/a | DONE | |

## 2. Goals, non-goals, success metrics

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 2.G1 | Win the Chainlink track and place main-track Top 5 | `SUBMISSION.md` | n/a | PENDING | Submission not made |
| 2.G2 | A working CRE workflow is the core of the product | `workflows/` | SIM_LOG 7/7 local; staging section | DONE | |
| 2.G3 | Real CCV policy hook in a CCV Starter Kit cell, with a working fallback | `ccv/`, `judge/`, Fallback B pools | `ccv/STATUS.md`; `KirchhoffTokenPool.t.sol` | FALLBACK | Cell runs with the Judge wired; live attestation blocked (see 9.D2); Fallback B deployed |
| 2.G4 | Kelp Replay end to end on public testnets, real txs and explorer links | `demo/e2e.ts` | `demo/logs/testnet-run1c.log`, `demo/logs/testnet-reset0.log` | PENDING | kETH spec active on testnet and the first EPOCH written (SIM_LOG staging); no passing testnet e2e yet (1.R6) |
| 2.G5 | UI good enough to screen-record without edits | `web/`, stage mode | `web/e2e/*` (124 / 124 passed) | PENDING | UI built; recording deferred by product owner (demo video work paused until the owner asks) |
| 2.P1 | Default economic CCV in the CCV marketplace | n/a | n/a | PENDING | Roadmap (PRD 18) |
| 2.P2 | Cover tokens on several bridges at once | `engine/src/adapters/event.ts` (generic adapter) | n/a | PENDING | Roadmap: LayerZero, Wormhole, native bridge adapters |
| 2.P3 | Public conservation status feed consumed by lending protocols | `contracts/src/ConservationFeed.sol` | `ConservationFeed.t.sol` | PENDING | Roadmap: integrations with money markets |
| 2.NG1 | Do not replace the Committee Verifier; additive | `ccv/STATUS.md` item 3 (`[address(0), resolver]`); pools keep upstream checks | `KirchhoffTokenPool.t.sol` `test_upstreamAuthStillFirst` | DONE | |
| 2.NG2 | No bridge operation, custody or user token movement | demo bridge is `TESTNET SIMULATION ONLY` | n/a | DONE | |
| 2.NG3 | AI never makes a PASS or FAIL decision | `scripts/no-ai-in-veto-path.sh` (CI step) | script output OK | DONE | |
| 2.NG4 | No AI trading, yield or wallet | repo-wide | n/a | DONE | None present |
| 2.NG5 | No price-based detection in the veto path | `engine/src/types.ts` (no price inputs) | n/a | DONE | |
| 2.M1 | Forged-credit detection in the same CRE run as the credit event | `workflows/src/w1.ts` `runJunction` | SIM_LOG scenario 3 "BREACH written to 3 chains in the same run ... writes=3" | DONE | Local Anvil; testnet run under 2.G4 |
| 2.M2 | Loop Rule breach to BROKEN onchain under 60 s after confidence | `workflows/src/w2.ts` | SIM_LOG scenario 7 | DONE | Measured in the scenario harness (Anvil, 1 s blocks): BREACH mined 2 / 3 / 4 s after confidence on home / arb / base. Single-node simulation, excludes DON trigger delivery; not measured on public testnets |
| 2.M3 | 0 false BROKEN over the demo token's full history in backtest | `engine/src/backtest.ts`, `ai/src/backtest.ts` | `engine/test/property.test.ts` (synthetic only) | PENDING | No replay of real kETH history asserted; pending measurement |
| 2.M4 | Policy hook p99 under 300 ms | `judge/` | `judge/load/RESULTS.md` | PENDING | Met with stub RPCs (p99 6.13 ms); missed on Anvil (485.9 ms); live debit lookups via public RPCs 397-677 ms per message |
| 2.M5 | 3 testnets, 2 bridges in the demo | `deployments/testnet.json` | TokenAdminRegistry `getPool` returns our pools on all 3 chains; Etherscan verification | DONE | CCIP and WeakBridge |
| 2.M6 | Onboard the demo token with Spec Copilot in under 10 min | `web/components/onboard/*` | none | PENDING | Pending measurement |

## 3. Users, personas, jobs to be done

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 3.P1 | Issuer security lead: onboarding wizard, Spec Copilot, Incident Room, quarantine controls | `web/app/app/onboard`, `web/components/incident/resolve-dialog.tsx` | IRs "Resolve via Safe prepares resolve(tokenId, incidentId) calldata" | DONE | |
| 3.P2 | On-call: Incident Room with AI narrative and evidence links | `web/components/incident/*` | IRs "shows evidence, the AI narrative with citations and containment" | DONE | |
| 3.P3 | Risk steward: AggregatorV3 feed, public status page | `ConservationFeed.sol`, `web/app/t/[token]` | `ConservationFeed.t.sol` `test_answersFollowStatus` | DONE | |
| 3.P4 | Holder: public status page with one CONSERVED / BROKEN badge | `web/components/status-page/status-page.tsx`, `web/app/t/[token]/badge.svg/route.ts` | `web/e2e/console-errors.spec.ts` on `/t/kETH` (smoke) | DONE | |
| 3.P5 | CCV operator: Verifier Ops, Helm values, policy hook image | `web/components/ops/verifier-ops.tsx`, `ccv/values/*`, `judge/Dockerfile` | `api/test/lab-ops.test.ts` | DONE | |
| 3.P6 | AI agent: MCP `kirchhoff.status` and public API | `mcp/src/server.ts` | `mcp/test/mcp.test.ts` | DONE | Tool named `kirchhoff_status` (13.MCP1) |
| 3.P7 | Judge: Kelp Replay in Mission Control, architecture slide | `web/app/lab`, `docs/ARCHITECTURE.md`, `media/deck/build.cjs` `slideArchitecture` | ALs "Kelp Replay runs all 7 steps and Mission Control breaks"; `media/deck/KIRCHHOFF.pptx` slide 5 | DONE | |
| 3.S1 | Issuer describes token, gets an approvable spec with a backtest proving no false alarms on its history | `ai/src/copilot`, `ai/src/backtest.ts`, `web/components/onboard/wizard.tsx` | `ai/test/copilot.int.test.ts`; APIt "backtests a resolved spec against the world's history through the engine" | PENDING | Backtest replays events but evaluates one Loop epoch at head; per-epoch history replay remains |
| 3.S2 | Every CCIP transfer is signed by KIRCHHOFF only if the money adds up | Judge + Fallback B | `Jt`; `KirchhoffTokenPool.t.sol` | FALLBACK | Enforced at the pool (Fallback B); CCV signature path not onboarded |
| 3.S3 | When another bridge is exploited, CCIP lanes stop the spread | W1, W3, Fallback B | SIM_LOG scenario 3; `KirchhoffTokenPool.t.sol` `test_revertsWhenLanesFrozenWhileConserved` | DONE | |
| 3.S4 | Risk steward reads one feed and freezes the asset | `ConservationFeed.sol`, `DemoLendingMarket.sol`, `KirchhoffProtected.sol` | `GuardAndLending.t.sol` `test_lending_borrowRevertsCollateralBroken` | DONE | |
| 3.S5 | On-call page with exact deficit, offending tx and what is quarantined | `indexer/src/notifier.ts` `incidentText`, `api/src/pager.ts` | `indexer/test/unit.test.ts` "every page carries deficit, offending tx link, containment, Incident Room link and narrative"; APIt "pages once with deficit, offending tx link, containment, Incident Room link and narrative" | DONE | Tested against mocked endpoints; no live page delivered yet (no channel secrets configured) |
| 3.S6 | Agent queries one MCP tool before moving funds | `mcp/src/server.ts` `kirchhoff_check_transfer` | `mcp.test.ts` "kirchhoff_check_transfer maps snake_case input and tells the agent to stop" | DONE | |
| 3.N1 | Nice-to-have: replay held messages after recovery with multisig approval | `api/src/replay.ts`, `GET /v1/incidents/:id/replay-plan`, `web/components/incident/replay-plan.tsx` | `web/e2e/incident-extras.spec.ts` (`replay-plan`) | PENDING | Read-only replay plan, gated on CONSERVED, tainted senders stay held; no execution and no Safe approval flow (calls are empty by design; the operator runs `ccip-cli manual-exec`) |
| 3.N2 | Nice-to-have: holder Telegram alert subscription | none | none | PENDING | Not implemented at all; only one operator chat id |

## 4. Core concepts and glossary

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 4.R1 | Junction Rule per message | `engine/src/junction.ts` `junction`, `matchAll` | `engine/test/junction.test.ts` "settles an exact match", condition 1-5 tests | DONE | |
| 4.R2 | Loop Rule per epoch | `engine/src/loop.ts` `loop` | `engine/test/loop.test.ts` "is BROKEN with LOOP_DEFICIT below minus tolerance" | DONE | |
| 4.G1 | Protected token | `KirchhoffRegistry.registerToken`, `CL` `isRegistered` | `KirchhoffRegistry.t.sol` | DONE | |
| 4.G2 | KIRCH-SPEC | `engine/specs/kETH.yaml`, `engine/src/spec/*` | `engine/test/spec.test.ts` | DONE | |
| 4.G3 | Home chain | `TokenSpec.home` (`engine/src/types.ts`) | `spec.test.ts` | DONE | |
| 4.G4 | Remote chain | `TokenSpec.remotes` | `spec.test.ts` | DONE | |
| 4.G5 | Debit | `Debit` type | `adapters.test.ts` | DONE | |
| 4.G6 | Credit | `Credit` type | `adapters.test.ts` | DONE | |
| 4.G7 | In flight | `Snapshot.inFlightOut/In`, `matchAll` | `junction.test.ts` "settles matches and computes in-flight from unmatched debits by side" | DONE | |
| 4.G8 | Epoch keyed to pinned blocks | `Epoch` (Solidity and TS), `blocksHash` | `encoding.test.ts` | DONE | |
| 4.G9 | Deficit Δ | `LoopResult.delta` | `loop.test.ts` | DONE | |
| 4.G10 | Confidence latest / safe / finalized | `Confidence` type, compile mapping | `compile.test.ts` | DONE | `safe` reads at finalized (Deviation D9) |
| 4.G11 | Verdict PASS or FAIL plus reason | `JC` `decide` | `engine/test/judge.test.ts` | DONE | |
| 4.G12 | Quarantine | `QuarantineController.sol` | `QuarantineController.t.sol` | DONE | |
| 4.G13 | Conservation Feed, one per token per chain | `ConservationFeed.sol` | `ConservationFeed.t.sol` | DONE | Deployed on all 3 testnets |
| 4.G14 | Cell: verifier + aggregator + Postgres | `ccv/` | `ccv/STATUS.md` pod listing | DONE | |
| 4.G15 | Policy hook | `judge/src/server.ts` | `Jt` | DONE | |
| 4.S1 | UNKNOWN: per-token fail-closed (default) or fail-open; feed 0 | `JC` step 6, `ConservationFeed.latestRoundData` | `engine/test/judge.test.ts` "stale and UNKNOWN fail closed by default"; `ConservationFeed.t.sol` `test_unknownBeforeFirstEpoch` | DONE | |
| 4.S2 | CONSERVED: PASS if the message passes the Junction check; feed 1 | `JC` step 8-9 | `Jt` "passes a conserved, debited kETH transfer with the PRD reason format" | DONE | Judge matches the source debit amount for the message id |
| 4.S3 | DRIFT: PASS, flagged in the UI; feed 2 | `JC`, `web/lib/status.ts` | `engine/test/loop.test.ts` "raises FLOW_LIMIT as DRIFT above the hourly limit only" | DONE | |
| 4.S4 | BROKEN: FAIL for all messages; feed 3 | `JC` `CONTAINED` | `Jt` "TOKEN_BROKEN on the destination, quoting the breach reason and incident" | DONE | |
| 4.S5 | QUARANTINED: FAIL, held messages kept for replay; feed 4 | `JC`; `api/src/incident.ts` `heldMessages` | `Jt` "TOKEN_QUARANTINED status" | DONE | Replay itself: 3.N1 and 9.H4 |
| 4.S6 | RECOVERING: FAIL until timelock, then CONSERVED; feed 5 | `JC` (`TOKEN_RECOVERING`), `CL` `_applyRecoveryCheck` | `Jt` "TOKEN_RECOVERING status"; CLt `test_recovery_fullPath` | DONE | |
| 4.T1 | UNKNOWN to CONSERVED | `engine/src/status.ts` `transition`; `CL` `_applyEpoch` | `status.test.ts` "transition: PRD section 4 allowed transitions"; CLt `test_epoch_firstConservedFromUnknown` | DONE | |
| 4.T2 | CONSERVED to DRIFT, BROKEN or UNKNOWN | same | same; CLt `test_epoch_conservedDriftConserved` | DONE | UNKNOWN via staleness |
| 4.T3 | DRIFT to CONSERVED or BROKEN | same | same; CLt `test_breach_fromDrift` | DONE | |
| 4.T4 | BROKEN to QUARANTINED automatically | `workflows/src/w3.ts` | SIM_LOG scenario 3 "W3 QUARANTINE_APPLIED on 3 chains" | DONE | W3 runs on the `BreachRecorded` log, a separate execution right after W1 (Deviation D14) |
| 4.T5 | QUARANTINED to RECOVERING by issuer multisig only | `QuarantineController.resolve` (`onlyIssuer`), `CL.beginRecovery` | `QuarantineController.t.sol` `test_resolve_onlyIssuer`; CLt `test_beginRecovery_onlyQuarantineController` | DONE | |
| 4.T6 | RECOVERING to CONSERVED after timelock and a fresh epoch with Δ >= 0 | `CL._applyRecoveryCheck` | CLt `test_recovery_fullPath`, `test_recovery_rejectsNegativeDelta` | DONE | |
| 4.T7 | No other transitions | `status.ts` `illegal`; `CL` | `status.test.ts` "transition: illegal"; CLt `test_recovery_illegalFromEveryOtherStatus`; invariant `invariant_brokenNeverHealthyWithoutRecovering` | DONE | |

## 5. System architecture

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 5.L1 | Design law: UI, AI and API can be offline and every verdict still works | Judge reads chains directly; `judge/src/sink.ts` posts after the answer | `judge/test/sink.test.ts` (hung API never delays a verdict); `no-ai-in-veto-path.sh` | DONE | |
| 5.C1 | Protected token contracts (canonical, escrow adapter, remotes) | `contracts/src/demo/KETH.sol`, `HomeEscrowAdapter.sol`, `RemoteKETH.sol` | `WeakBridge.t.sol`, `GuardAndLending.t.sol` | DONE | |
| 5.C2 | Onchain suite: Registry, Ledger, Feed, Quarantine, Guard, TokenPool; Solidity 0.8.26 | `contracts/src/*` | 150 forge tests | DONE | |
| 5.C3 | Conservation Engine: 4 CRE workflows on CRE DONs | `workflows/` | SIM_LOG | FALLBACK | Simulation; DON deploy access not enabled |
| 5.C4 | CCV committee of cells running the Judge (1 to 4 at the hackathon) | `ccv/`, `judge/` | `ccv/STATUS.md` | FALLBACK | 1 cell on local k3d, cannot attest yet |
| 5.C5 | Indexer and API: Postgres, viem indexer, Fastify, WebSocket | `indexer/src/indexer.ts`, `api/src/app.ts` | `indexer/test/indexer.int.test.ts`; APIt "WS /v1/stream sends status on connect..." | DONE | |
| 5.C6 | AI services: Copilot, Narrator, Scout via Claude, tool use, JSON schema | `ai/src/*` | `ai/test/*` (33) | DONE | Claude through OpenRouter by default (Deviation D17) |
| 5.C7 | MCP server and public API | `mcp/`, `api/src/mcp.ts` | `mcp.test.ts` | DONE | |
| 5.C8 | Mission Control frontend on Vercel (Next.js 15, Tailwind, shadcn, motion, wagmi) | `web/`, `web/vercel.json` | https://kirchhoff-two.vercel.app (HTTP 200, `x-vercel-id: sin1`, checked 2026-10-06); MCs | DONE | API at https://kirchhoff-api.vercel.app (`/healthz` ok, sin1) |
| 5.C9 | Notifier: Telegram, Slack, PagerDuty | `indexer/src/notifier.ts`, `api/src/pager.ts`, W3 `post()` | `indexer/test/unit.test.ts` "posts to mocked Telegram, Slack and PagerDuty Events v2 endpoints, once per incident per channel" | DONE | PagerDuty Events v2 added (dedup_key = incident id); no live page delivered yet (no channel secrets configured) |
| 5.A1 | Flow A: user sends 10 kETH Arbitrum to Ethereum through CCIP; pool burns | `demo/seed.ts` | none recorded | PENDING | No recorded testnet CCIP send of kETH |
| 5.A2 | Each cell's verifier POSTs to its Judge after source finality | upstream verifier, `ccv/values/cell-1.yaml` | `ccv/STATUS.md` ("Policy hook enabled") | FALLBACK | Verifier has never called the Judge: no message names our CCV |
| 5.A3 | Judge reads status from the ledger through its own RPC | `judge/src/evaluate.ts` `destinationView`, `sourceView` | `Jt` PASS and FAIL paths | DONE | |
| 5.A4 | Judge confirms a source pool burn of exactly the amount for this message id | `evaluate.ts` `lookupDebit` | `Jt` "AMOUNT_MISMATCH when the pool debit differs from the transfer"; `replay.test.ts` "%s: pool debit equals the message amount" | DONE | Deviation D8 |
| 5.A5 | Status CONSERVED and burn matches: PASS | `JC` step 9 | `Jt` "passes a conserved, debited kETH transfer..." | DONE | |
| 5.A6 | Committee Verifier signs too; executor releases | n/a | none | FALLBACK | Needs our resolver on the lanes (9.D2) |
| 5.A7 | W1 matches the release, W2 settles it; Δ unchanged | `w1.ts` OK path, `w2.ts` settled ids | SIM_LOG scenario 1 "message ... consumed on every ledger" | DONE | |
| 5.B1 | Flow B: forged WeakBridge message releases 116,500 kETH on Ethereum Sepolia | `demo/src/attack.ts` `forgeRelease`, `DEMO_BREACH_AMOUNT` | SIM_LOG scenario 3 (7 kETH, local) | DONE | 116,500 kETH testnet run under 2.G4 |
| 5.B2 | W1 log trigger on `Released`, searches remotes for `Burned`, none | `w1.ts` `findDebit` | SIM_LOG scenario 3 | DONE | |
| 5.B3 | W1 writes BROKEN with evidence hash to all 3 ledgers in the same run | `w1.ts` `writeToLedgers` | SIM_LOG scenario 3 "writes=3" | DONE | |
| 5.B4 | W3 quarantine: lanes freeze, attacker tainted, feed BROKEN or worse | `w3.ts`, `QuarantineController` | SIM_LOG scenario 3 "every ledger QUARANTINED" | DONE | |
| 5.B5 | Attacker's CCIP move to Base refused (Judge FAIL TOKEN_BROKEN, never executes) | Fallback B pools; `JC` | `KirchhoffTokenPool.t.sol` `test_revertsWhenBroken_everyEntryPoint`; `Jt` "TOKEN_BROKEN on the source chain" | FALLBACK | Enforced by Fallback B. `demo/src/attack.ts` now sends a real `Router.ccipSend` on testnet and asserts the revert (KirchhoffGuard first, then the pool with lanes frozen); no recorded testnet run of that step yet |
| 5.B6 | Guard blocks tainted transfer on home; lending market freezes borrowing | `KirchhoffGuard.sol`, `DemoLendingMarket.sol` | `GuardAndLending.t.sol` `test_guard_blocksTaintedSender`, `test_lending_borrowRevertsCollateralBroken` | DONE | |
| 5.B7 | W2 next epoch confirms Δ = -116,500 kETH | `demo/e2e.ts` (asserts Δ exactly -116,500 kETH), `demo/src/attack.ts` `deficitEpoch`, `w2.ts` | `demo/logs/testnet-run1c.log` "epoch 1791245933 status=3 reason=6 delta=-116500000000000000000000 writes=3"; SIM_LOG scenario 5 | DONE | Testnet simulation: W2 wrote BREACH `LOOP_DEFICIT` with Δ = -116,500 kETH to all 3 testnet ledgers |
| 5.TB1 | Chain data: DON consensus; each Judge uses independent RPCs | `judge/src/config.ts` `rpcFor` (refuses identical URLs) | `judge/test/config.test.ts` "needs two distinct providers per spec chain" | DONE | |
| 5.TB2 | CRE DON honest majority; KIRCHHOFF additive | design | n/a | DONE | |
| 5.TB3 | 3 of 4 cells honest in production | `ccv/values/cell-1..4.yaml` | n/a | CUT | Cut list item 5 (4-cell committee); 1 cell, committee shown in the architecture |
| 5.TB4 | Spec changes need issuer multisig plus 48 h timelock | `KirchhoffRegistry.sol` (`PRODUCTION_TIMELOCK = 48 hours`, testnet 600 s) | `KirchhoffRegistry.t.sol` `test_proposeActivate_timelock` | DONE | Testnet registry reads `timelockSeconds() = 600` |
| 5.TB5 | Control plane cannot sign, write verdicts or change status | `api/`, `indexer/`, `web/` hold no keys for ledgers | `no-ai-in-veto-path.sh`; CREReceiver allowlist tests | DONE | |

## 6. Invariant engine and KIRCH-SPEC

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 6.E1 | One pure TS library used by CRE workflows (WASM), backtester and Judge | `engine/`; imports in `workflows/src/w1.ts`, `w2.ts`, `judge/src/evaluate.ts`, `ai/src/backtest.ts` | `workflows` `build:wasm`, SIM_LOG | DONE | |
| 6.E2 | Bigint only, no floats, no `Date.now()`, no randomness, no network | `engine/src` | grep: no `Date.now`, `Math.random`, `fetch` | DONE | Clock injected as `ctx.now` |
| 6.E3 | 100% branch coverage | `engine/vitest.config.ts` thresholds 100 | coverage run 586/586 branches; CI step | DONE | |
| 6.L1 | Lock-release Δ formula, BROKEN iff Δ < -τ | `loop.ts` | `loop.test.ts` "absorbs a deficit inside the tolerance", "waits for breach_confirmations consecutive deficit epochs" | DONE | |
| 6.L2 | Burn-and-mint formula with I_net and PoR | `loop.ts` `backingOf` | `loop.test.ts` "loop: burn_mint_multi" | DONE | Engine only; W2 runs `lock_release_home` (kETH's model) |
| 6.L3 | In-flight from message matching keyed by id, never snapshot timing | `junction.ts` `matchAll` | `junction.test.ts` "nets a credit whose matching debit is above the source pin out of F once"; SIM_LOG scenario 2 | DONE | |
| 6.J1 | Same message id and claimed source chain | `junction.ts` condition 1 | `junction.test.ts` "condition 1: id, source and destination" | DONE | |
| 6.J2 | Token and amount match | condition 2 | "condition 2: AMOUNT_MISMATCH", "condition 2 compares canonical units across decimals" | DONE | |
| 6.J3 | Recipient matches when carried | condition 3 | "condition 3: recipient" | DONE | |
| 6.J4 | Debit at or below required confidence | condition 4 | "condition 4: confidence" | DONE | |
| 6.J5 | Debit not already consumed | condition 5 | "condition 5: DOUBLE_CREDIT..." | DONE | |
| 6.J6 | Final source and no debit: BROKEN `DEBIT_NOT_FOUND` at once | `unmatched()` | "is DEBIT_NOT_FOUND at once when the source is final" | DONE | |
| 6.J7 | Non-final source: DRIFT until debit or window end, then BROKEN | `unmatched()` | "is DRIFT inside the match window...", "is BROKEN once the match window ends" | DONE | |
| 6.RC1 | `OK` | `junction`, `loop`, `JC` step 9 | "settles an exact match" | DONE | |
| 6.RC2 | `PENDING_ATTESTATION` | `JC` steps 5, 7, 8, budget | `judge/test/budget.test.ts` "answers 503 at the budget when a provider hangs..." | DONE | HTTP 503, not FAIL (Deviation D1) |
| 6.RC3 | `DEBIT_NOT_FOUND` | `junction` | `scenarios.test.ts` scenario3 | DONE | |
| 6.RC4 | `AMOUNT_MISMATCH` | `junction`, `JC` step 8 | "condition 2: AMOUNT_MISMATCH" | DONE | |
| 6.RC5 | `RECIPIENT_MISMATCH` | `junction` | "is RECIPIENT_MISMATCH when both sides carry different recipients" | DONE | |
| 6.RC6 | `DOUBLE_CREDIT` | `junction` | scenario4 | DONE | |
| 6.RC7 | `LOOP_DEFICIT` | `loop` | scenario5 | DONE | |
| 6.RC8 | `RESERVE_SHORTFALL` | `loop` | "is RESERVE_SHORTFALL when the reserve binds" | DONE | |
| 6.RC9 | `FLOW_LIMIT`: DRIFT, PASS with flag | `loop` | "raises FLOW_LIMIT as DRIFT above the hourly limit only" | DONE | |
| 6.RC10 | `STATUS_STALE`: fail-closed or fail-open | `JC` step 6 | `Jt` "STATUS_STALE under fail_closed", "passes a stale status when the spec says fail_open" | DONE | |
| 6.RC11 | `TOKEN_BROKEN` | `JC` | `Jt` "TOKEN_BROKEN on the destination..." | DONE | |
| 6.RC12 | `TOKEN_QUARANTINED` | `JC` | `Jt` "TOKEN_QUARANTINED status" | DONE | |
| 6.RC13 | `UNKNOWN_TOKEN` | `JC` step 3 | `Jt` "UNKNOWN_TOKEN when the registry has no active spec" | DONE | |
| 6.RC14 | `SPEC_MISMATCH` | `JC` step 3 | `Jt` "SPEC_MISMATCH when the registry activated a different spec, without any ledger read" | DONE | Plus `TOKEN_RECOVERING` (Deviation D2) |
| 6.K1 | YAML spec validated against JSON Schema | `engine/src/spec/schema.ts`, `parse.ts` | `spec.test.ts` "parseSpec" | DONE | |
| 6.K2 | Compiled into the CRE workflow config | `engine/src/compile.ts`, `workflows/scripts/gen-config.ts` | `compile.test.ts` "generates all four workflow configs from specs/kETH.yaml" (golden files) | DONE | |
| 6.K3 | Spec hashed into the onchain Registry | `engine/src/spec/hash.ts`, `judge/src/spec-cache.ts` | `spec.test.ts` "serializes canonically..." | DONE | Hash of the testnet spec is `0x22c75309...5dfe`; not yet proposed on testnet (6.LC4) |
| 6.K4 | Every spec field takes effect | `engine/src/spec/parse.ts`, `engine/src/compile.ts`, `demo/src/spec.ts` `specParameters()` -> `demo/deploy-all.ts` | `spec.test.ts` "parses every optional extension"; deploy-all reads `rules.staleness_seconds` and `response.recovery_timelock_seconds` from the spec | DONE | Contract parameters come from the KIRCH-SPEC; the forge script only receives them as arguments. `replay_requires` is informational (Safe-gated replay plan) |
| 6.LC1 | Draft: issuer YAML or Copilot draft | `ai/src/copilot`, `web/components/onboard` | `copilot.int.test.ts` | DONE | |
| 6.LC2 | Validate: schema plus semantic checks incl. bytecode on chain | `engine/src/spec/validate.ts` | `spec.test.ts` "reports every semantic error", "runs the injected bytecode check on every real address" | DONE | |
| 6.LC3 | Backtest full history; any BROKEN blocks activation | `engine/src/backtest.ts`, `ai/src/backtest.ts`, `wizard.tsx` | `backtest.test.ts` | PENDING | One synthetic Loop epoch at head; the block is a UI gate only |
| 6.LC4 | Propose the spec hash in `KirchhoffRegistry` by issuer multisig | `KirchhoffRegistry.proposeSpec` (`onlyIssuer`), `demo/spec-activate.ts` | `KirchhoffRegistry.t.sol` `test_propose_onlyIssuerAndValidated`; SIM_LOG staging (activated in Sepolia tx `0x43b895d4...0b87`) | DONE | Executed on testnet through the issuer Safe |
| 6.LC5 | Timelock 48 h production, 10 min testnet, visible in UI | `KirchhoffRegistry.sol`, `web/components/onboard/step-timelock.tsx` | `test_proposeActivate_timelock`; onchain `timelockSeconds() = 600` | DONE | |
| 6.LC6 | Activate emits `SpecActivated`; W4 picks it up and workflows load the new config | `activateSpec`, W4 trigger 0, `workflows/src/w4.ts` `runTopology` | `KirchhoffRegistry.t.sol`; `workflows.test.ts` "reloads the active spec: a registry hash different from the running spec is SPEC_MISMATCH, an equal one is clean"; SIM_LOG "W4 on the real SpecActivated log" (`findings=0`) | DONE | Deviation D23: W4 reads `activeSpecHash` on every run and raises DRIFT `SPEC_MISMATCH` when it differs from the compiled spec; the new config is regenerated with `gen-config` |

## 7. Smart contracts

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 7.P0 | CRE receivers follow `ReceiverTemplate`, accept only the KeystoneForwarder and registered workflows | `contracts/src/CREReceiver.sol` | CLt `test_onReport_rejectsWrongForwarder`, `test_onReport_rejectsUnknownWorkflow`, `test_onReport_rejectsReportTypeOutsideWorkflowMask` | DONE | Allowlist instead of one id (Deviation D11) |
| 7.P1 | `KirchhoffRegistry`: spec hash, URI, issuer Safe, timelock, activation | `KirchhoffRegistry.sol` | `KirchhoffRegistry.t.sol` (8 tests) | DONE | |
| 7.P2 | `ConservationLedger` on every chain | `ConservationLedger.sol` | CLt (61 tests) | DONE | |
| 7.P3 | `QuarantineController` on every chain | `QuarantineController.sol` | `QuarantineController.t.sol` (10 tests) | DONE | |
| 7.P4 | `ConservationFeed` AggregatorV3-compatible | `ConservationFeed.sol` | `ConservationFeed.t.sol` `test_metadata`, `test_staleHealthyAnswersUnknown`, `test_staleBrokenStillReportsBroken` | DONE | `decimals() = 0`, `description() = "KIRCHHOFF kETH status"` (Deviation D7) |
| 7.P5 | `KirchhoffGuard` blocks tainted senders | `KirchhoffGuard.sol` | `test_guard_blocksTaintedSender` | DONE | |
| 7.P6 | `KirchhoffTokenPool` fallback enforcement | `KirchhoffTokenPool.sol`, `KirchhoffBurnMintTokenPool.sol`, `KirchhoffLockReleaseTokenPool.sol` | `KirchhoffTokenPool.t.sol` (15 tests) | DONE | |
| 7.I1 | `enum Status` | `src/interfaces/KirchhoffTypes.sol` | used throughout | DONE | |
| 7.I2 | `struct Epoch` 7 fields | `KirchhoffTypes.sol` | CLt `test_epoch_firstConservedFromUnknown` | DONE | |
| 7.I3 | `IConservationLedger` events and functions | `src/interfaces/IConservationLedger.sol` | CLt | DONE | |
| 7.I4 | `IQuarantineController` | `src/interfaces/IQuarantineController.sol` | `QuarantineController.t.sol` | DONE | |
| 7.I5 | `IKirchhoffGuard.check` | `src/interfaces/IKirchhoffGuard.sol` | guard tests | DONE | |
| 7.RT1 | `EPOCH`: ignored while contained, epochId increasing | `CL._applyEpoch` | CLt `test_epoch_ignoredWhileContained`, `test_epoch_rejectsNonIncreasingEpoch` | DONE | |
| 7.RT2 | `BREACH`: BROKEN, evidence, calls QuarantineController | `CL._applyBreach` | CLt `test_breach_fromConservedSetsBrokenAndContains`, `test_rejectsUnregisteredToken` | DONE | Idempotent per incident (Deviation D13) |
| 7.RT3 | `QUARANTINE_APPLIED` only after BROKEN | `CL._applyQuarantine` | CLt `test_quarantine_illegalFromNonBroken` | DONE | |
| 7.RT4 | `RECOVERY_CHECK` only RECOVERING, timelock ended, Δ >= 0 | `CL._applyRecoveryCheck` | CLt `test_recovery_fullPath`, `test_recovery_rejectsNegativeDelta` | DONE | |
| 7.RT5 | Report carries chain selector and ledger address; replay rejected | `CL._processReport` | CLt `test_replay_rejectsWrongChainSelector`, `test_replay_sameReportOnSecondLedgerRejected` | DONE | |
| 7.RT6 | A CRE report alone can never clear BROKEN | `CL.beginRecovery` (controller only) | CLt `test_creReportAloneCanNeverClearBroken` | DONE | |
| 7.D1 | kETH 18 decimals, calls `KirchhoffGuard.check` in `_update` | `src/demo/KETH.sol` | `test_keth_metadata`, `test_guard_blocksTaintedSender` | DONE | |
| 7.D2 | `RemoteKETH` burn-mint; minters CCIP pool and WeakBridge | `src/demo/RemoteKETH.sol`, `Deploy.s.sol` | `WeakBridge.t.sol` `test_remoteKETH_rolesAndEvents` | DONE | |
| 7.D3 | `HomeEscrowAdapter` locks and releases for WeakBridge | `src/demo/HomeEscrowAdapter.sol` | `test_home_creditReleasesFromEscrow` | DONE | |
| 7.D4 | `WeakBridge` 1-of-1 ECDSA, events match the spec | `src/demo/WeakBridge.sol`, `BridgeRegistry.sol` | `test_kelpReplay_forgedCreditDrainsEscrow`, `test_credit_rejectsWrongSigner` | DONE | Adds `debitOf` / `creditOf` (Deviation D3) |
| 7.D5 | `DemoLendingMarket` `borrow()` reverts `CollateralBroken()` | `src/demo/DemoLendingMarket.sol` | `test_lending_borrowRevertsCollateralBroken` | DONE | |
| 7.D6 | Demo contracts clearly labeled | NatSpec `TESTNET SIMULATION ONLY` on every demo file | n/a | DONE | |
| 7.T1 | Unit tests for every report type and illegal transition | `contracts/test/ConservationLedger.t.sol` | 61 tests pass | DONE | |
| 7.T2 | Fuzz: forged credits always flagged, valid never | `test/fuzz/BridgeConservation.t.sol` | `testFuzz_everyForgeryFlagged`, `testFuzz_validSequencesNeverFlagged` (1024 runs) | DONE | Uses an in-test reference evaluator; the TS engine is covered by the 10,000-run property test (17.TL2) |
| 7.T3 | Invariant: BROKEN never to CONSERVED without RECOVERING | `test/invariant/LedgerInvariants.t.sol` | `invariant_brokenNeverHealthyWithoutRecovering`, `invariant_epochIdStrictlyIncreases` (256 x 64) | DONE | |
| 7.T4 | Fork-free with a mock KeystoneForwarder | `src/demo/MockKeystoneForwarder.sol` | `ForwarderIntegration.t.sol` incl. `test_realForwarder_deliversSignedEpoch` | DONE | Also covers the real DON-signature path |
| 7.DEP | Deployed and verified on 3 testnets | `contracts/script/Deploy.s.sol`, `deployments/testnet*.json` | Etherscan V2 `getsourcecode` (2026-10-05) | DONE | Arbitrum `ConservationFeed` verified on Blockscout only |

## 8. CRE workflows

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 8.0 | EVM client `callContract`, `filterLogs`, `getTransactionReceipt`, `headerByNumber`; `writeReport` to the forwarder | `workflows/src/cre-io.ts` | SIM_LOG read-budget lines | DONE | |
| 8.W1.T | EVM Log trigger on every credit event, one per chain | `w1-junction/main.ts`, `w1.ts` `creditTriggerGroups` | `workflows/test/workflows.test.ts` "wires one log trigger per chain..." | DONE | |
| 8.W1.1 | Decode the credit | `w1.ts` `decodeTriggerCredit` | "breaks on a forged credit..." | DONE | |
| 8.W1.2 | `headerByNumber` at the spec confidence on the source | `runJunction` | SIM_LOG scenario 3 reads | DONE | |
| 8.W1.3 | Search the source for the matching debit by message id | `w1.ts` `findDebit` | SIM_LOG scenario 3 | DONE | `debitOf` at the pin plus a 100-block evidence window (Deviation D3) |
| 8.W1.4 | Consumed-debit check via `isConsumed` | `runJunction` | SIM_LOG scenario 4 | DONE | |
| 8.W1.5 | `engine.junction` | `runJunction` | scenarios 3, 4 | DONE | |
| 8.W1.6 | OK: settled marker into the next EPOCH; BROKEN: BREACH to every chain in the same run | `runJunction`, `w2.ts` settled ids | "settles an honest credit without writing anything"; scenario 3 | DONE | W2 writes the settled ids (Deviation D15) |
| 8.W1.L | BREACH lands in the same run as the forged credit | as above | SIM_LOG scenario 3 | DONE | |
| 8.W2.T | Cron every 30 s plus supply-change log triggers | `w2-loop/main.ts` | "subscribes to supply changes only..." | DONE | Only the cron trigger has been simulated |
| 8.W2.1 | Pinned block per chain at confidence | `w2.ts` `runLoop` | SIM_LOG "pinned home= arb= base=" | DONE | |
| 8.W2.2 | One Multicall3 `callContract` per chain at the pin | `runLoop` | SIM_LOG `W2 reads used 12/15` | DONE | |
| 8.W2.3 | In-flight via `filterLogs` matched by id | `runLoop` + `matchAll` | SIM_LOG scenario 2 | DONE | |
| 8.W2.4 | Optional PoR feed read for backed tokens | `workflows/src/w2.ts` (PoR `latestRoundData` inside the pinned Multicall3) | `workflows.test.ts` "reads latestRoundData at the pinned home block...", "breaks with RESERVE_SHORTFALL when claims exceed the reserve", "fails closed on a negative reserve answer and on a burn-and-mint token with no feed" | DONE | kETH has no PoR feed, so its runs skip the read (12 reads) |
| 8.W2.5 | `engine.loop` | `runLoop` | scenarios 5, 6 | DONE | |
| 8.W2.6 | EPOCH or BREACH to every chain with `blocksHash` | `planEpoch`, `epochBody` | SIM_LOG `writes=3` | DONE | |
| 8.W2.D | Determinism from consensus header reads | `runLoop` | SIM_LOG | DONE | |
| 8.W3.T | Trigger on `BreachRecorded` (home) | `w3-responder/main.ts` | SIM_LOG scenario 3 | DONE | |
| 8.W3.1 | Build the incident id | `w3.ts` `incidentId` | SIM_LOG incident `0x6ac8...` | DONE | |
| 8.W3.2 | `QUARANTINE_APPLIED` to every chain with tainted list | `runResponder` | "quarantines only ledgers whose active incident is this one..." | DONE | |
| 8.W3.3 | One notification per channel, idempotency key = incident id | `w3-responder/main.ts` `post`, `buildNotifications` | "decodes BreachRecorded and builds pages keyed by incident id..." | DONE | No webhook secrets configured, so runs log "notified 0" |
| 8.W3.S | Secrets from CRE secrets | `workflows/secrets.yaml`, `runtime.getSecret` | n/a | DONE | |
| 8.W4.T | Triggers `SpecActivated` plus cron 10 min | `w4-topology/main.ts` | `workflows.test.ts` | DONE | Plus `RoleGranted` triggers |
| 8.W4.1 | Reload active specs | `workflows/src/w4.ts` `readState` (`activeSpecHash`) | `workflows.test.ts` "reloads the active spec..."; SIM_LOG staging W4 runs | DONE | See Deviation D23 |
| 8.W4.2 | Scan for new minters, pools or peers | `workflows/src/w4.ts` `grantedMinters`, `checkPools` | `workflows.test.ts` "checks the CCIP pool and its peers from current state; all consistent is clean at 14 reads", "flags a registry pool that is not a spec minter, a rogue peer pool and a peer chain outside the spec"; SIM_LOG staging W4 (14/15 reads) | DONE | Pools via TokenAdminRegistry `getPool`, peers via `getRemotePools` |
| 8.W4.3 | Unlisted minter: DRIFT `SPEC_MISMATCH` and notify the issuer | `runTopology`, `workflows/w4-topology/main.ts` `page` | `workflows.test.ts` "raises EPOCH DRIFT SPEC_MISMATCH for a minter outside the spec, with a page keyed by the drift"; SIM_LOG scenario 5 | DONE | Issuer paged through the CRE HTTP capability, idempotency key = drift key; no live delivery yet (no secrets) |
| 8.RL | Repository layout incl. `config.staging.json` and `config.production.json` per workflow | `workflows/w*-*/` | `ls` | FALLBACK | No production config: there is no production deploy (deploy access not enabled) |
| 8.C1a | `cre workflow simulate` against local chains | `workflows/project.yaml` `local` | SIM_LOG 7/7 | DONE | |
| 8.C1b | `cre workflow simulate --target staging` against public testnets | `project.yaml` `staging`, generated `config.staging.json` | SIM_LOG "Staging (public testnets), 2026-10-06": W2 cron `--broadcast` EPOCH on 3 testnets; W4 cron and SpecActivated `findings=0` | DONE | W1 and W3 staging runs belong to the testnet e2e (1.R6) |
| 8.C2 | `cre workflow deploy` once access is confirmed | n/a | `cre whoami` | FALLBACK | Deploy access not enabled; PRD sanctions simulation |
| 8.CF | Config generated from the spec by `engine/compile.ts`, never hand edited | `engine/src/compile.ts`, `gen-config.ts`, `demo/src/cre.ts` | `workflows/test/core.test.ts` "generated configs parse with the workflow schemas..." | DONE | |

## 9. CCIP 2.0 CCV integration

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 9.0 | Real CCV from the Starter Kit; only custom code is the Judge | `ccv/values/*`, `judge/` | `ccv/STATUS.md` | FALLBACK | Cannot attest until the resolver exists (9.D2) |
| 9.H1 | Cell = verifier + aggregator + Postgres via Helm in Kubernetes | `ccv/scripts/up.sh`, `ccv/k8s/postgres.yaml` | STATUS.md pod listing | DONE | Local k3d |
| 9.H2 | Four cells, threshold three | `ccv/values/cell-1..4.yaml` | n/a | CUT | Cut list item 5: one cell, threshold 1 |
| 9.H3 | POST `/v1/evaluate`, PASS or FAIL, HMAC-SHA256 | `judge/src/server.ts`, `hmac.ts` | `judge/test/hmac.test.ts` (vectors from chainlink-ccv's Go signer) | DONE | |
| 9.H4 | FAIL withholds a signature; replay after review | `ccv/README.md` replay command | STATUS.md (`reschedule --help` only) | FALLBACK | Never exercised: the verifier has not called the Judge yet |
| 9.H5 | Fee token, fee amount, source block timestamp, Finality object | `judge/openapi/*`, `judge/src/schema.ts` | `schema.test.ts` "matches the hand-written request types field for field" | PENDING | Validated by schema; not parsed into the engine or used in any decision |
| 9.H6 | Every cell runs the identical Judge | `ccv/k8s/judge.yaml` | n/a | DONE | One shared Judge Deployment (testnet shortcut) |
| 9.J1 | HMAC verify, bad signature 401 | `server.ts`, `hmac.ts` | `hmac.test.ts` "answers 401 when the body changes after signing" | DONE | |
| 9.J2 | Parse selectors, message id, transfers, sender, receiver, finality, timestamp | `JC` `parseHookRequest` | `engine/test/judge.test.ts` "keeps selectors above 2^63 exact" | DONE | Finality and timestamp schema-checked only (9.H5) |
| 9.J3 | Token to tokenId via spec cache synced every 60 s; hash differs: FAIL `SPEC_MISMATCH` | `judge/src/spec-cache.ts` | `Jt` "SPEC_MISMATCH when the registry activated a different spec..." | DONE | |
| 9.J4 | No protected token: PASS | `JC` | `Jt` "passes a data-only message without touching RPC" | DONE | |
| 9.J5 | `statusOf` on source and destination via two providers; disagreement: `PENDING_ATTESTATION` | `evaluate.ts`, `rpc.ts` `readBoth` | `Jt` "providers disagree on status" | DONE | HTTP 503 (Deviation D1); provider-paired reads (Deviation D6) |
| 9.J6 | BROKEN, QUARANTINED, RECOVERING: FAIL; stale: `on_stale` | `JC` step 6 | `Jt` "TOKEN_RECOVERING status", "STATUS_STALE under fail_closed" | DONE | |
| 9.J7 | Frozen or tainted sender: FAIL `TOKEN_QUARANTINED` | `JC` step 7 | `Jt` "TOKEN_QUARANTINED when the sender is tainted on the source chain" | DONE | |
| 9.J8 | Confirm source pool debit and amount | `evaluate.ts` `lookupDebit` | `Jt` "AMOUNT_MISMATCH when the pool debit differs from the transfer" | DONE | Deviation D8 |
| 9.J9 | All pass: PASS `OK` | `JC` | `Jt` "passes a conserved, debited kETH transfer with the PRD reason format" | DONE | |
| 9.JR1 | Stateless except the spec cache | `spec-cache.ts` | n/a | DONE | |
| 9.JR2 | 2 s total budget | `server.ts` `budget` | `budget.test.ts` | DONE | |
| 9.JR3 | Every FAIL logs reason code, message id and evidence | `server.ts` logger | `Jt` FAIL paths assert the log line | DONE | |
| 9.JR4 | Reason string = code plus short note | `JC` `decide` (max 256) | "caps the reason string at 256 characters" | DONE | |
| 9.JR5 | Outcomes visible on `verifier_message_transitions_total{stage="policy"}` | `judge/src/metrics.ts` (Judge side) | `Jt` "exports latency and decisions by reason on /metrics..." | DONE | Cell-side metric not observed (no message reached the hook) |
| 9.JE | Response examples | `JC` `hookResponse` | `Jt` | DONE | PENDING example is a 503 body (Deviation D1) |
| 9.D1 | Ask mentors for testnet CCV steps and indexer onboarding | `HUMAN_TASKS.md` | n/a | PENDING | Human task; self-serve parts answered in `docs/research/ccv.md` section 5 |
| 9.D2 | Deploy the onchain CCV contracts kit on 3 testnets | none | `ccv/STATUS.md` item 1 | PENDING | Resolver and committee verifier not deployed; values hold `0x...cc01` |
| 9.D3 | One k3s cluster on a cloud VM, in-cluster Postgres, keys in k8s secrets | `ccv/scripts/up.sh` | STATUS.md | FALLBACK | Local k3d on a laptop; aggregator not publicly reachable |
| 9.D4 | Deploy 1 cell, wire the Judge, run "test your setup" transfer | `up.sh`, `judge-deploy.sh` | STATUS.md smoke checks (200 / 401 from an in-cluster pod) | PENDING | Test transfer not run |
| 9.D5 | Scale to 4 cells, threshold 3 | values exist | n/a | CUT | Cut list item 5 |
| 9.FB | Fallback B: pools check ledger and quarantine in `releaseOrMint` / `lockOrBurn` | `KirchhoffTokenPool.sol` and subclasses; CCT registration in `Deploy.s.sol` | `KirchhoffTokenPool.t.sol`; onchain `TokenAdminRegistry.getPool(kETH)` = our pools; `getSupportedChains` = both remotes | DONE | |
| 9.FB2 | Same pools make kETH require our CCV (`applyCCVConfigUpdates`) | none | none | PENDING | Not wired (`advancedPoolHooks = address(0)`) |
| 9.FC | Fallback C: Judge replay of real CCIP payloads | `judge/scripts/capture-real.ts`, `judge/test/fixtures/real/*` | `judge/test/replay.test.ts` | DONE | Real Sepolia CCIP 2.0 sends (not kETH), derived from tx data |

## 10. Multi-bridge supply indexing and adapters

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 10.A0 | `BridgeAdapter` interface, `Debit` / `Credit` types | `engine/src/adapters/types.ts`, `types.ts` | `adapters.test.ts` "exposes the PRD adapter contract" | DONE | |
| 10.A1 | Normalize to canonical base units by per-chain decimals | `engine/src/units.ts` | `units.test.ts` | DONE | |
| 10.AD1 | `weakbridge` adapter | `adapters/weakbridge.ts` | "weakbridge adapter" block | DONE | |
| 10.AD2 | `ccip_v2` adapter keyed by CCIP message id | `adapters/ccip.ts` | "pairs LockedOrBurned with CCIPMessageSent in the same transaction" | DONE | Deviation D8 |
| 10.AD3 | `layerzero_oft` (stretch) | none | none | CUT | Cut list item 4; roadmap slide |
| 10.AD4 | `wormhole_ntt` (v1) | none | none | PENDING | Roadmap (v1) |
| 10.AD5 | `op_standard_bridge`, `arbitrum_gateway` (v1) | none | none | PENDING | Roadmap (v1) |
| 10.AD6 | `issuer_mint` (v1) | none | none | PENDING | Roadmap (v1) |
| 10.SR1 | Rebasing tokens compare shares (`unit: shares`) | `compile.ts` share read selectors | `compile.test.ts` "reads shares for rebasing tokens..." | PENDING | Only W2 reads switch; adapter and junction amounts are not converted |
| 10.SR2 | Fee-on-transfer: match on amount received from the bridge event | `adapters/ccip.ts` (pool amount), weakbridge event amount | none | DONE | By design; no dedicated test |
| 10.SR3 | Escrow donations raise Δ only, shown as surplus | `loop.ts` `surplus`; `web/components/mission/conservation-meter.tsx` | `loop.test.ts` "counts an escrow donation as surplus, never as a breach"; SIM_LOG scenario 6 | DONE | |
| 10.SR4 | W4 flags unlisted minter role grants | `w4.ts` | SIM_LOG scenario 5 | DONE | |
| 10.RM1 | Indexer writes tokens, chains, debits, credits, matches, epochs, verdicts, incidents, taints, specs | `indexer/migrations/001_read_model.sql`, `indexer/src/store.ts` | `indexer.int.test.ts` "records the Kelp-style forgery as a forged credit, a BREACH on all chains, one incident, and quarantine" | DONE | |
| 10.RM2 | UI reads only the mirror; every row links to its explorer tx | `api/src/readmodel.ts`, `web/lib/explorer.ts` | APIt | DONE | Coverage of links: 17.DOD3 |

## 11. AI layer

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 11.P1 | No AI in the veto path | `scripts/no-ai-in-veto-path.sh` | CI step; script OK | DONE | |
| 11.P2 | Provenance on every claim; lines without it render red and block approval | `ai/src/copilot/draft.ts`, `web/components/onboard/provenance.ts`, `spec-review.tsx` | `copilot.int.test.ts` "streams the tool trace and renders YAML whose provenance is verified against tool results" | DONE | |
| 11.P3 | Untrusted inputs stay untrusted | `ai/src/guard.ts` | `ask.test.ts` "untrusted() strips control characters and caps size"; eval INJ-01..10 | DONE | |
| 11.P4 | No write powers | `ai/src/copilot/tools.ts` | `copilot.int.test.ts` "refuses unknown and write-like tools as data, and validates arguments" | DONE | |
| 11.P5 | Structured outputs with JSON Schema | `draft.ts`, `narrator.ts`, `guard.ts` | `provider.test.ts` | DONE | |
| 11.P6 | Claude via API, model by env var, temperature 0 | `ai/src/provider.ts` | `provider.test.ts`; `narrator.test.ts` "...sends temperature 0 with a JSON schema" | DONE | Deviation D17 |
| 11.SC.T1 | `get_contract` | `copilot/tools.ts` | "get_contract identifies verified contracts..." | DONE | |
| 11.SC.T2 | `list_role_grants` | `tools.ts` | "list_role_grants surfaces both active minters on a remote..." | DONE | |
| 11.SC.T3 | `list_ccip_pools` | `tools.ts` | same test | DONE | |
| 11.SC.T4 | `list_oft_peers` | `tools.ts` `listOftPeers` | none | DONE | Implemented; not exercised by a test |
| 11.SC.T5 | `sample_events` | `tools.ts` `sampleEvents` | none | DONE | Implemented; not exercised by a test |
| 11.SC.T6 | `validate_spec` | `tools.ts` | `copilot.int.test.ts` agent loop | DONE | |
| 11.SC.T7 | `backtest_spec` | `tools.ts`, `ai/src/backtest.ts` | APIt "backtests a resolved spec..." | DONE | |
| 11.SC.F1 | Validation runs automatically after the draft | `copilot/agent.ts` | `copilot.int.test.ts` | DONE | |
| 11.SC.F2 | Backtest runs automatically | `wizard.tsx` (backtest effect once every line has evidence), `step-backtest.tsx` `AutoBacktestSummary` | `web/e2e/onboard.spec.ts` (`auto-backtest`) | DONE | |
| 11.SC.F3 | Provenance chip on every line and a plain-English why per minter | `spec-review.tsx` | `copilot.int.test.ts` | DONE | |
| 11.SC.F4 | Approval opens a Safe transaction proposing the spec hash | `step-propose.tsx` | none | DONE | Opens the Safe Transaction Builder with a copyable hash; calldata is not prefilled |
| 11.N1 | Narrator input: deterministic evidence bundle | `api/src/incident.ts` | `narrator.test.ts` | DONE | |
| 11.N2 | 120-word summary, timeline, blast radius per chain, next steps from a fixed playbook | `narrator.ts` schema and `PLAYBOOK` | "drops sentences citing unknown evidence and rejects off-playbook steps" | DONE | Word limit is a prompt hint; blast radius is deterministic |
| 11.N3 | Every sentence cites evidence; label "AI summary. Verify against evidence." | `narrator.ts` `NARRATIVE_LABEL` | `ai/eval/RESULTS.md` section 3 (100%) | DONE | |
| 11.N4 | Narrative posted to Slack and Telegram with the incident link | `indexer/src/notifier.ts`, `api/src/pager.ts` | `indexer/test/unit.test.ts` "every page carries deficit, offending tx link, containment, Incident Room link and narrative"; APIt "pages once with deficit..." | DONE | No live delivery yet (no channel secrets configured) |
| 11.TS | Topology Scout crawls for forgotten supply paths and files proposals in Onboarding | `ai/src/scout.ts`, `POST /v1/specs/scout`, `GET /v1/specs/proposals`, `web/components/onboard/step-scout.tsx` | `scout.test.ts`; APIt "POST /v1/specs/scout files a same-symbol deployment the spec does not list; GET /v1/specs/proposals lists it"; `web/e2e/onboard.spec.ts` (`scout-panel`) | DONE | Searches Blockscout for same-name and same-symbol deployments the spec does not list; proposals are drafts |
| 11.AK | Ask KIRCHHOFF over the read model with read-only SQL, citing rows | `ai/src/ask.ts`, `indexer/migrations/002_ask_readonly.sql`, `api/src/ai.ts`, `web/components/ask/ask-palette.tsx` | `ask.test.ts` "returns forbidden SQL to the model as an error and never runs it" | DONE | |
| 11.MCP | Agent access through MCP | `mcp/` | `mcp.test.ts` | DONE | |
| 11.EV1 | Copilot provenance coverage 100% on the demo token | `ai/eval/run.ts` | RESULTS.md section 1: 15 / 15 lines, 100.0% | DONE | |
| 11.EV2 | Copilot field accuracy: demo token exact | same | RESULTS.md section 2: 19 / 19 | DONE | CCIP ramps excluded locally |
| 11.EV3 | Narrator citation coverage: every sentence | same | RESULTS.md section 3: 100.0% | DONE | |
| 11.EV4 | Prompt-injection suite: 10 cases, 0 tool misuse | same | RESULTS.md section 4: 0 of 10 | DONE | |

## 12. Frontend UI/UX

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 12.DD1 | Circuit metaphor | `web/components/mission/circuit-map.tsx` (React Flow) | MCs "shows a conserved token with live verdicts" | DONE | |
| 12.DD2 | Dark-first, full light theme | `web/app/globals.css`, `web/lib/prefs.tsx` | `stage.spec.ts` dark and light snapshots | DONE | |
| 12.DD3 | Calm teal by default; red, motion and sound only on breach | `breach-effects.tsx`, `prefs.tsx` (sound off) | MCs "breach state frames the app in red..." | DONE | A subtle teal wire flow runs while CONSERVED |
| 12.DD4 | Every number verifiable, one click away | `web/components/kh/links.tsx`, `web/lib/explorer.ts` | MCs "every number links to an explorer or an onchain read" | DONE | Gaps tracked in 17.DOD3 |
| 12.TK1 | `bg/base` #0B0D10 / #FAFAF9 | `globals.css` | snapshots | DONE | |
| 12.TK2 | `bg/panel` #12151A / #FFFFFF | `globals.css` | snapshots | DONE | |
| 12.TK3 | `line/wire` #2A313B / #D6D9DE | `globals.css` | snapshots | DONE | |
| 12.TK4 | `status/conserved` #2DD4BF / #0F766E | `globals.css` | snapshots | DONE | |
| 12.TK5 | `status/drift` #FBBF24 / #B45309 | `globals.css` | snapshots | DONE | |
| 12.TK6 | `status/broken` #F43F5E / #BE123C | `globals.css` | snapshots | DONE | |
| 12.TK7 | `status/quarantined` #A78BFA / #6D28D9 | `globals.css` | snapshots | DONE | |
| 12.TK8 | `status/recovering` #60A5FA / #1D4ED8 | `globals.css` | snapshots | DONE | |
| 12.TK9 | `status/unknown` #6B7280 | `globals.css` | snapshots | DONE | Extra `--status-unknown-text` #8B93A0 for AA text in dark |
| 12.TY1 | Inter 14 px / 1.5; JetBrains Mono with tabular figures | `web/app/layout.tsx`, `globals.css` `.tnum` | n/a | DONE | |
| 12.TY2 | Scale 12/14/16/20/28/48/72; Δ readout 72 px | `globals.css` `@theme`, `conservation-meter.tsx` | n/a | DONE | |
| 12.TY3 | 4 px grid, 16 px panel padding, 8 px radius, 1 px borders | `globals.css` `.panel` | n/a | DONE | |
| 12.TY4 | Lucide icons; status = color + icon + word | `web/components/kh/status.tsx` | n/a | DONE | |
| 12.TY5 | shadcn/ui, Monaco, Recharts, React Flow, Framer Motion | `web/package.json`, `components/ui/*`, `spec-review.tsx`, `delta-history.tsx` | n/a | DONE | `motion` package (Framer Motion's successor) |
| 12.MO1 | 6 px dot, 600 ms per settled transfer | `circuit-map.tsx` `PULSE_MS = 600` | n/a | DONE | |
| 12.MO2 | Breach: red wire, Δ counts over 800 ms, 2 px red frame, title "BROKEN · kETH" | `circuit-map.tsx`, `conservation-meter.tsx` `COUNT_MS = 800`, `breach-effects.tsx` | MCs `toHaveTitle("BROKEN · kETH")` | DONE | |
| 12.MO3 | Quarantine: violet lock glyph, dashed wire | `circuit-map.tsx` | n/a | DONE | |
| 12.MO4 | Reduced motion: no pulses, no counting | `prefs.tsx` `useReducedMotion`, `useDuration` | none | DONE | No assertion in tests |
| 12.SC1 | `/t/[token]` status page: badge, Δ, per-chain table, epoch age, verify links, SVG badge | `web/app/t/[token]`, `status-page.tsx`, `badge.svg/route.ts` | console-errors and responsive smoke on `/t/kETH` | DONE | |
| 12.SC2 | `/app/tokens/[token]` Mission Control: map, meter, stream, ledger, Δ chart | `mission-control.tsx` | MCs (10 tests) | DONE | |
| 12.SC3 | `/app/incidents/[id]`: timeline, blast radius, narrative, actions, held messages, Resolve via Safe, postmortem | `incident-room.tsx`, `side-cards.tsx` | IRs (3 tests) | DONE | |
| 12.SC4 | `/app/onboard`: 6 steps | `onboard/wizard.tsx`, `model.ts` | smoke only | DONE | |
| 12.SC5 | `/app/ops`: cell health, Judge p50/p99, PASS/FAIL, RPC agreement, CRE runs | `verifier-ops.tsx`, `api/src/ops.ts` | `api/test/lab-ops.test.ts`; APIt "GET /v1/ops reports..." | DONE | |
| 12.SC6 | `/app/integrate`: feeds, Solidity snippet, API keys, MCP config | `integrations.tsx` | smoke only | DONE | |
| 12.SC7 | `/lab` Attack Lab labeled "Testnet simulation" | `attack-lab.tsx`, `api/src/lab.ts` | ALs "Kelp Replay runs all 7 steps and Mission Control breaks" | DONE | |
| 12.ML1 | Top bar: switcher, TESTNET badge, status pill, epoch, staleness timer, Cmd+K | `top-bar.tsx`, `ask-palette.tsx` | MCs | DONE | |
| 12.ML2 | Circuit Map: escrow center, chain nodes, wires; hover last 10 transfers; node opens ledger drawer | `circuit-map.tsx`, `ledger-drawer.tsx` | MCs "wire hover lists recent transfers and a chain opens its ledger drawer" | DONE | |
| 12.ML3 | Conservation Meter: two bars, 72 px Δ, claims overflow red | `conservation-meter.tsx` | MCs breach test (`claims-overflow`) | DONE | |
| 12.ML4 | Verdict Stream virtualized, newest first, all columns | `verdict-stream.tsx` | MCs | DONE | |
| 12.ML5 | Ledger table and 24 h Δ chart with incident markers | `ledger-table.tsx`, `delta-history.tsx` | MCs "Δ history has a data table toggle" | DONE | |
| 12.IR1 | Header: severity, Δ, offending block to BROKEN, incident id | `incident-room.tsx` | IRs | DONE | |
| 12.IR2 | Evidence timeline | `evidence-timeline.tsx` | IRs | DONE | |
| 12.IR3 | Narrative with citation chips; actions checklist; held messages, replay disabled until CONSERVED | `side-cards.tsx` | IRs | DONE | |
| 12.IR4 | Resolve opens a Safe transaction; export Markdown and PDF | `resolve-dialog.tsx`, `postmortem.ts` | IRs "Resolve via Safe prepares...", "exports a Markdown postmortem" | DONE | Safe Tx Builder with calldata; PDF export untested |
| 12.ST1 | Loading skeletons; never a spinner on Δ | `mission-control.tsx` skeletons | MCs "loading state uses skeletons, never a spinner on Δ" | DONE | |
| 12.ST2 | Empty: one sentence plus one action | `web/app/app/page.tsx` | MCs "empty state invites onboarding" | DONE | |
| 12.ST3 | Stale: dim to 60%, banner text | `StaleBanner`, `.is-stale` | MCs "stale state dims panels and names the stale policy" | DONE | |
| 12.ST4 | RPC or API error: inline banner naming the chain | `StateBanners` | MCs "RPC error names the failing chain and the rest stays live" | DONE | |
| 12.ST5 | Breach: red frame, toast, Incident Room link, optional sound off by default | `breach-effects.tsx` | MCs breach test; `breach-toast.spec.ts` | DONE | |
| 12.A1 | WCAG 2.2 AA contrast in both themes | `globals.css` | `web/e2e/a11y.spec.ts` (axe, WCAG 2.2 AA, 11 routes in both themes) | DONE | |
| 12.A2 | Full keyboard navigation, visible focus rings | `globals.css` `:focus-visible` | `web/e2e/keyboard.spec.ts` (6 tests) | DONE | |
| 12.A3 | Verdict Stream polite live region; breach assertive | `verdict-stream.tsx`, `BreachToast` | none | DONE | |
| 12.A4 | Every chart has a data table toggle | `delta-history.tsx`, `verifier-ops.tsx` | MCs "Δ history has a data table toggle" | DONE | |
| 12.SM | Stage mode `?stage=1`: 1920x1080, type 120%, big cursor, no dev controls, motion 1.3x | `prefs.tsx`, `globals.css`, `stage-frame.tsx` | `stage.spec.ts` (4 snapshots) | DONE | |
| 12.MC1 | Breach toast microcopy | `breach-effects.tsx` `breachCause` | ALs asserts the exact string | DONE | |
| 12.MC2 | FAIL row "Refused · TOKEN_BROKEN · attacker transfer to Base Sepolia" | `verdict-stream.tsx` | MCs, ALs | DONE | |
| 12.MC3 | Status hero "kETH adds up across 3 chains. Last checked 12 seconds ago." | `status-page.tsx` | none | DONE | Built dynamically |

## 13. Public API, SDK, MCP server

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 13.ON1 | `KirchhoffProtected` (MAX_AGE 300, accepts 1 and 2) | `contracts/src/KirchhoffProtected.sol` | via `DemoLendingMarket`: `test_lending_borrowRevertsStale`, `test_lending_borrowWhenDrift` | DONE | |
| 13.REST1 | GET `/tokens` | `api/src/app.ts` | APIt "GET /v1/tokens lists kETH with mirrored status" | DONE | |
| 13.REST2 | GET `/tokens/{token}/status` | `app.ts` | APIt "GET /v1/tokens/kETH/status returns Loop Rule terms, chains, bridges and lanes" | DONE | |
| 13.REST3 | GET `/tokens/{token}/epochs?limit&cursor` | `app.ts` | APIt "GET epochs paginates the home ledger history, newest first" | DONE | |
| 13.REST4 | GET `/tokens/{token}/verdicts?cursor` | `app.ts` | APIt "ingests Judge verdicts from the internal sink and serves the committee view" | DONE | Cursor paging untested |
| 13.REST5 | GET `/incidents/{id}` | `app.ts`, `api/src/incident.ts` | APIt "GET /v1/incidents/{id} returns evidence, containment, blast radius and a cited template narrative" | DONE | |
| 13.REST6 | POST `/check-transfer`, rate-limited | `app.ts` (30/min), `api/src/onchain.ts` | APIt "refuses with TOKEN_QUARANTINED and the reading block" | DONE | |
| 13.REST7 | POST `/specs/draft`, issuer key, SSE tool trace | `app.ts` | APIt "requires the issuer key for /specs/* and /keys..." | DONE | |
| 13.REST8 | POST `/specs/backtest`, issuer key | `app.ts` | APIt "backtests a resolved spec..." | DONE | |
| 13.REST9 | WS `/stream?token=` with status, epoch, verdict, incident | `app.ts`, `api/src/stream.ts` | APIt "WS /v1/stream sends status on connect and pushes new outbox events" | DONE | On Vercel the API serves SSE `/v1/stream/sse` instead (Deviation D21) |
| 13.REST10 | Responses carry `source: "onchain-mirror"`, ledger address and block | `api/src/readmodel.ts` `meta` | APIt `expectMeta` helper | DONE | |
| 13.MCP0 | Stdio and Streamable HTTP; all tools read-only | `mcp/src/stdio.ts`, `http.ts`, `api/src/mcp.ts` | `mcp.test.ts` "stdio: the bin speaks MCP over stdin/stdout" | DONE | |
| 13.MCP1 | `kirchhoff_status` | `mcp/src/server.ts` | `mcp.test.ts` | DONE | |
| 13.MCP2 | `kirchhoff_check_transfer` | `server.ts` | `mcp.test.ts` | DONE | |
| 13.MCP3 | `kirchhoff_explain_verdict` | `server.ts` | `mcp.test.ts` | DONE | |
| 13.MCP4 | `kirchhoff_incident` | `server.ts` | `mcp.test.ts`, APIt | DONE | |
| 13.MCP5 | `kirchhoff_list_tokens` | `server.ts` | `mcp.test.ts` | DONE | |
| 13.MCP6 | Descriptions tell agents to check before moving and stop on false | `server.ts` | `mcp.test.ts` "exposes exactly the five read-only PRD tools with the check-before-move instruction" | DONE | |
| 13.SDK1 | `new Kirchhoff({network})`, `status()` | `sdk/src/kirchhoff.ts` | `sdk.test.ts` "status() parses delta and epoch to bigint and computes age" | DONE | |
| 13.SDK2 | `subscribe()` | `kirchhoff.ts` | `sdk.test.ts` "subscribe() falls back to SSE and resumes with Last-Event-ID" | DONE | WebSocket path untested |
| 13.SDK3 | `verifyOnchain()` reads the ledger via viem | `kirchhoff.ts` | `sdk.test.ts` "returns UNKNOWN before any epoch and CONSERVED after one, without trusting the API" | DONE | |

## 14. Security model and threat model

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 14.T1 | Forged message on a non-CCIP bridge | W1, W3 | SIM_LOG scenario 3 | DONE | |
| 14.T2 | Forged or buggy CCIP message: Judge checks the source debit independently | `evaluate.ts` `lookupDebit` | `Jt` "the debit belongs to another message id"; `replay.test.ts` | DONE | Live path via Fallback B (1.R2) |
| 14.T3 | Compromised mint key: Loop Rule and unlisted-minter alert | W2, W4 | SIM_LOG scenario 5 | DONE | |
| 14.T4 | Replay or double credit: consumed set, `DOUBLE_CREDIT` | `junction.ts`, `CL.isConsumed` | SIM_LOG scenario 4 | DONE | |
| 14.T5 | Lying or eclipsed RPC: two providers per Judge | `rpc.ts`, `config.ts` | `Jt` PENDING paths; `judge/CHAOS.md` | DONE | |
| 14.T6 | Reorg: finalized confidence by default | `engine/specs/kETH.yaml` `confidence.default: finalized` | `junction.test.ts` "condition 4: confidence" | DONE | |
| 14.T7 | Spec poisoning: Safe plus timelock; UI diff alert on every proposal | `KirchhoffRegistry.sol`, `api/src/specs.ts`, `web/components/kh/spec-proposal-alert.tsx` | `KirchhoffRegistry.t.sol`; APIt "diffs a pending registry proposal against the active spec field by field, flagging loosened rules"; MCs (`spec-diff`) | DONE | |
| 14.T8 | Report replay across chains or ledgers | `CL._processReport` | CLt `test_replay_*` | DONE | |
| 14.T9 | Operator compromise cannot sign alone | issuer-only release paths | `test_resolve_onlyIssuer`, `test_creReportAloneCanNeverClearBroken` | DONE | 3-of-4 cells cut (9.H2); ledger owner should hand off to the Safe (`HANDOFF_TO_SAFE`) |
| 14.T10 | Malicious AI suggestion: provenance, no write tools | `ai/src/copilot` | `copilot.int.test.ts` | DONE | |
| 14.T11 | Prompt injection through contract metadata | `ai/src/guard.ts` | RESULTS.md section 4 (0 of 10) | DONE | |
| 14.F1 | Judge unreachable: message fails, replayed later | verifier behavior | `judge/CHAOS.md` "kill the Judge" | DONE | Cell-side retry quoted from the spec, not observed |
| 14.F2 | CRE workflow stops: stale, `on_stale` applies | `JC` | CHAOS.md "pause W2" (stubbed) | DONE | |
| 14.F3 | Indexer or UI down: no effect on verdicts | Judge independent of API | `judge/test/sink.test.ts` | DONE | |
| 14.F4 | Adapter bug false BROKEN: frozen until issuer recovery; prevented by backtest and fuzzing | recovery path in contracts | `property.test.ts`; `test_recovery_fullPath` | DONE | |
| 14.NP1 | State: conserved-supply theft not covered | `README.md` | n/a | DONE | |
| 14.NP2 | State: DEX manipulation, phishing, lending bugs not covered | `README.md` | n/a | DONE | |
| 14.NP3 | State: same-block swaps not covered unless Guard | `README.md` | n/a | DONE | |

## 15. Demo script and stage deck

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 15.W | Design against judging weights | `SUBMISSION.md` mapping | n/a | DONE | |
| 15.DS1 | 0:00 headline numbers | deck | none | PENDING | Deferred by product owner (demo video work paused until the owner asks) |
| 15.DS2 | 0:15 Mission Control idle, normal CCIP transfer PASS | `mission-control.tsx` | MCs | PENDING | Deferred by product owner (demo video work paused until the owner asks); live testnet data exists (5.C8) |
| 15.DS3 | 0:35 Attack Lab, 116,500 kETH released, explorer tx | `attack-lab.tsx` | ALs | PENDING | Deferred by product owner (demo video work paused until the owner asks) |
| 15.DS4 | 1:05 red wire, Δ to -116,500, BREACH txs on 3 chains | `breach-effects.tsx` | MCs breach test | PENDING | Deferred by product owner (demo video work paused until the owner asks); the BREACH txs on 3 chains exist (README "Testnet transactions") |
| 15.DS5 | 1:25 attacker CCIP send refused (Judge FAIL TOKEN_BROKEN), CCIP explorer | Fallback B | none | PENDING | Deferred by product owner (demo video work paused until the owner asks); also needs a recorded testnet `ccipSend` refusal (5.B5) |
| 15.DS6 | 1:50 Guard revert and `borrow()` revert | `attack.ts` `attemptRefusals` | none | PENDING | Deferred by product owner (demo video work paused until the owner asks) |
| 15.DS7 | 2:05 Incident Room narrative and checklist | `incident-room.tsx` | IRs | PENDING | Deferred by product owner (demo video work paused until the owner asks) |
| 15.DS8 | 2:20 title slide tagline | deck | none | PENDING | Deferred by product owner (demo video work paused until the owner asks) |
| 15.DK1 | Slide 1 title | `media/deck/build.cjs` `slideTitle` | `media/deck/KIRCHHOFF.pptx` | DONE | |
| 15.DK2 | Slide 2 problem | `media/deck/build.cjs` `slideProblem` | `media/deck/KIRCHHOFF.pptx` | DONE | |
| 15.DK3 | Slide 3 two rules | `media/deck/build.cjs` `slideInsight` | `media/deck/KIRCHHOFF.pptx` | DONE | |
| 15.DK4 | Slide 4 embedded video | `media/deck/build.cjs` `slideDemo` | `media/deck/KIRCHHOFF.pptx` | PENDING | Deferred by product owner (demo video work paused until the owner asks); the slide shows a placeholder frame until `media/video/kirchhoff-demo.mp4` exists |
| 15.DK5 | Slide 5 architecture | `media/deck/build.cjs` `slideArchitecture` | `media/deck/KIRCHHOFF.pptx` | DONE | |
| 15.DK6 | Slide 6 why Chainlink | `media/deck/build.cjs` `slideWhyChainlink` | `media/deck/KIRCHHOFF.pptx` | DONE | |
| 15.DK7 | Slide 7 business | `media/deck/build.cjs` `slideBusiness` | `media/deck/KIRCHHOFF.pptx` | DONE | |
| 15.DK8 | Slide 8 limits and roadmap | `media/deck/build.cjs` `slideRoadmap` | `media/deck/KIRCHHOFF.pptx` | DONE | |
| 15.SUB1 | Public repo with README, diagram, addresses, workflow ids, Kelp Replay how-to | `README.md` | https://github.com/Adwaitbytes/kirchhoff (public, `main` in sync with origin) | DONE | Workflow ids are the CRE simulation ids; DON ids need deploy access (8.C2) |
| 15.SUB2 | Live URL: read-only Mission Control with "Replay last incident" | `web/components/mission/incident-replay.tsx`, `web/vercel.json`, `api/vercel.json` | https://kirchhoff-two.vercel.app (live, sin1) | PENDING | Deployed read-only. The live read model was last indexed at Sepolia block 11850609, before the testnet incidents, so "Replay last incident" has no testnet incident yet |
| 15.SUB3 | Deck .pptx with the video on Google Drive | `media/deck/KIRCHHOFF.pptx` | none | PENDING | Deferred by product owner (demo video work paused until the owner asks); deck exists without the video and is not uploaded |
| 15.SUB4 | Main and Chainlink track submissions with the CRE and CCIP paragraph | `SUBMISSION.md` | n/a | PENDING | Paragraphs drafted |
| 15.SUB5 | Submitted before 11:59 pm, October 7 | n/a | n/a | PENDING | |
| 15.REC1 | `demo/reset.ts` restores 3 chains in under 3 minutes | `demo/src/reset.ts` (`elapsedMs`, `underThreeMinutes`) | `demo/logs/testnet-reset0.log` | PENDING | Measured on testnets: 1426.5 s (`underThreeMinutes: false`), mostly waiting for Sepolia, Arbitrum and Base finality before RECOVERY_CHECK; under 180 s asserted on local only |
| 15.REC2 | Three full takes, best kept unedited | n/a | n/a | PENDING | Deferred by product owner (demo video work paused until the owner asks) |
| 15.REC3 | Explorer tabs pre-opened, clock visible | n/a | n/a | PENDING | Deferred by product owner (demo video work paused until the owner asks) |
| 15.REC4 | Second machine records a backup take | n/a | n/a | PENDING | Deferred by product owner (demo video work paused until the owner asks); human task |

## 16. 36-hour build plan

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 16.PR1 | CRE account and CLI login | n/a | `cre whoami` logged in | DONE | |
| 16.PR2 | Testnet ETH (and LINK) on 3 chains | n/a | `HUMAN_TASKS.md`; contracts deployed | DONE | CCIP fees in native ETH, LINK optional |
| 16.PR3 | Two independent RPC providers per chain | `.env` `RPC_*_1/_2` | `judge/README.md` live check (both providers synced) | DONE | Tenderly gateway plus publicnode |
| 16.PR4 | Cloud VM for k3s, Vercel project, Postgres | `ccv/`, Neon Postgres | `CREDENTIALS_NEEDED.md` | FALLBACK | Local k3d instead of a cloud VM |
| 16.PR5 | Anthropic API key, explorer API keys | `.env` | `ai/eval/RESULTS.md` (OpenRouter); Etherscan V2 verification | FALLBACK | Claude through OpenRouter instead of a direct Anthropic key (Deviation D17) |
| 16.PR6 | Team reads PRD 4-9 and Starter Kit docs | `docs/research/*` | n/a | DONE | |
| 16.TM1 | Lead: mentor answers, cut decisions, video, deck | `HUMAN_TASKS.md` | n/a | PENDING | Deferred by product owner (demo video work paused until the owner asks); deck generator at `media/deck` |
| 16.TM2 | Contracts lead: deployed and verified on 3 testnets | `deployments/testnet*.json` | Etherscan V2 | DONE | |
| 16.TM3 | Contracts 2: demo contracts, Guard, TokenPool, deploy and reset scripts | `contracts/src/demo`, `demo/` | `forge test`, `demo` tests | DONE | |
| 16.TM4 | CRE lead: W1 and W2 simulating green against testnets | `workflows/` | SIM_LOG staging section (W2 `--broadcast`, W4); `workflows/runner.log.jsonl` | PENDING | W2 green on all 3 testnets (first EPOCH, Loop BREACH, RECOVERY_CHECK); W1 has no recorded green staging run yet (the runner hit RPC 429s) |
| 16.TM5 | Engine at 100% branch coverage | `engine/` | coverage run | DONE | |
| 16.TM6 | CCV/infra: Judge live in a cell, or Fallback B | `ccv/`, `judge/` | STATUS.md | FALLBACK | Fallback B primary |
| 16.TM7 | Frontend lead: hero screen on live data | `web/` | https://kirchhoff-two.vercel.app; Playwright on fixtures | PENDING | Live on the testnet read model, but the indexer is not running continuously (last indexed Sepolia block 11850609) |
| 16.TM8 | Frontend 2: all screens with real states | `web/` | MCs, IRs | DONE | |
| 16.TM9 | AI + API: indexer, Copilot, Narrator | `indexer/`, `ai/`, `api/` | package tests | DONE | |
| 16.HG1 | Hour 4: ABI freeze | `docs/INTERFACES.md`, `contracts/src/interfaces/` | commit `d8aebf6` | DONE | |
| 16.HG2 | Hour 10: CCV path decision | `HUMAN_TASKS.md`, `ccv/STATUS.md` | n/a | DONE | Fallback B is primary |
| 16.HG3 | Hour 22: first full Kelp Replay on testnets | `demo/e2e.ts` | none | PENDING | 2.G4 |
| 16.HG4 | Hour 28: code freeze | n/a | n/a | PENDING | |
| 16.HG5 | Hour 35: submitted | n/a | n/a | PENDING | |
| 16.CL1 | Cut list 1: Topology Scout | `ai/src/scout.ts` | `scout.test.ts`; APIt scout tests; `onboard.spec.ts` | DONE | Not cut: built and wired (11.TS) |
| 16.CL2 | Cut list 2: Ask KIRCHHOFF | `ai/src/ask.ts` | `ask.test.ts` | DONE | Not cut |
| 16.CL3 | Cut list 3: MCP server | `mcp/` | `mcp.test.ts` | DONE | Not cut |
| 16.CL4 | Cut list 4: LayerZero adapter | none | n/a | CUT | Fallback: roadmap slide |
| 16.CL5 | Cut list 5: 4-cell committee | `ccv/values/cell-2..4.yaml` (unused) | n/a | CUT | Fallback: 1 cell, committee in the architecture |
| 16.CL6 | Cut list 6: full Spec Copilot | `ai/src/copilot` | eval | DONE | Not cut |
| 16.CL7 | Cut list 7: AI Narrator | `ai/src/narrator.ts` (+ template fallback) | `narrator.test.ts` | DONE | Not cut |
| 16.NC1 | Never cut: W1 | `workflows/w1-junction` | SIM_LOG | DONE | |
| 16.NC2 | Never cut: W2 | `workflows/w2-loop` | SIM_LOG | DONE | |
| 16.NC3 | Never cut: ledger | `ConservationLedger.sol` | CLt | DONE | |
| 16.NC4 | Never cut: Judge or Fallback B | `judge/`, pools | tests | DONE | |
| 16.NC5 | Never cut: Circuit Map | `circuit-map.tsx` | MCs | DONE | |
| 16.NC6 | Never cut: Verdict Stream | `verdict-stream.tsx` | MCs | DONE | |
| 16.NC7 | Never cut: Kelp Replay | `demo/attack-kelp-replay.ts` | SIM_LOG scenario 3 | PENDING | Testnet run (2.G4) |

## 17. Testing and QA

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 17.TL1 | Engine unit: every reason code and branch, 100% branches | `engine/test/*` | 251 passed (CI run 37393797827), 100% branches | DONE | |
| 17.TL2 | Engine property: 10,000 random sequences, every forgery flagged, zero false flags | `engine/test/property.test.ts` | "holds over 10,000 random histories" (`numRuns: 10_000`, seed 20261006) | DONE | |
| 17.TL3 | Contracts unit: every report type, illegal transition, replay rejection | `contracts/test/*` | 150 passed | DONE | |
| 17.TL4 | Contracts invariant: BROKEN never to CONSERVED without RECOVERING; epochId increases | `test/invariant/LedgerInvariants.t.sol` | 3 invariants pass | DONE | |
| 17.TL5 | Workflows: `cre workflow simulate` on 3 Anvil chains with a mock forwarder, 6 scenarios | `workflows/scripts/scenarios.ts` | SIM_LOG 7/7 PASS (run 2026-10-05; scenario 7 is the 2.M2 latency run) | DONE | |
| 17.TL6 | Judge: HMAC rejection, every FAIL path, 2 s budget, RPC disagreement, recorded payloads | `judge/test/*` | 96 passed | DONE | |
| 17.TL7 | End to end `demo/e2e.ts` on public testnets, run 3 times | `demo/e2e.ts` | none | PENDING | Never run on testnets; no local run artifact either |
| 17.TL8 | Chaos: kill one RPC, kill the Judge, pause W2 | `judge/scripts/chaos.sh` | `judge/CHAOS.md` | DONE | Light, as scoped; stub chains |
| 17.TL9 | Playwright: Mission Control, Incident Room, Attack Lab, stage snapshot | `web/e2e/*` | 124 / 124 passed (`web/playwright-report`, local run 2026-10-06 after commit `230054a`; commit message) | DONE | Not in CI (CI runs the TypeScript and contracts jobs) |
| 17.TL10 | AI eval scripts per section 11 | `ai/eval/run.ts` | RESULTS.md | DONE | |
| 17.TL11 | Load: k6 100 rps, p99 under 300 ms | `judge/load/k6.js` | RESULTS.md run A: p99 6.13 ms, 0 / 6001 failed | DONE | Run B on Anvil misses (485.9 ms); see 2.M4 |
| 17.SC1 | Normal round trip: CONSERVED throughout | `scenarios.ts`; `engine/test/scenarios.test.ts` | SIM_LOG scenario 1 PASS | DONE | |
| 17.SC2 | In flight across an epoch boundary: no false DRIFT or BROKEN | same | scenario 2 PASS | DONE | |
| 17.SC3 | Forged WeakBridge release: BROKEN `DEBIT_NOT_FOUND` | same | scenario 3 PASS | DONE | |
| 17.SC4 | Double credit: BROKEN `DOUBLE_CREDIT` | same | scenario 4 PASS | DONE | |
| 17.SC5 | Direct mint: BROKEN `LOOP_DEFICIT` | same | scenario 5 PASS | DONE | |
| 17.SC6 | Donation: Δ rises, CONSERVED, UI shows surplus | same; `conservation-meter.tsx` | scenario 6 PASS | DONE | |
| 17.DOD1 | Tests written and green | all packages | baseline table above | DONE | |
| 17.DOD2 | Works on the 3 public testnets, not just Anvil | `deployments/testnet.json` | Ledgers written by CRE simulation on all 3 testnets (README "Testnet transactions") | PENDING | EPOCH, Loop BREACH, W3 quarantine, Safe resolution and RECOVERY_CHECK ran on testnets; a passing full e2e is pending (1.R6) |
| 17.DOD3 | Every number links to an explorer tx or onchain read | `links.tsx`, `explorer.ts` | `web/e2e/ops-links.spec.ts` sweeps every Verifier Ops figure; MCs checks Δ and status pill | PENDING | Ops figures link to their source or are marked not public; no sweep yet over every Mission Control and Incident Room number |
| 17.DOD4 | Loading, empty, stale, error, breach states | 12.ST1-5 | MCs | DONE | |
| 17.DOD5 | No em dashes in user-facing copy | `web/` | `grep -rn` for U+2014 in `web/app web/components web/lib`: 0 | DONE | |

## 18. Production roadmap, business model, go-to-market

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 18.RM0 | Phase 0 Harden | n/a | n/a | PENDING | Roadmap |
| 18.RM1 | Phase 1 Shadow | n/a | n/a | PENDING | Roadmap |
| 18.RM2 | Phase 2 Enforce | n/a | n/a | PENDING | Roadmap |
| 18.RM3 | Phase 3 Feed | n/a | n/a | PENDING | Roadmap |
| 18.RM4 | Phase 4 Institutional | n/a | n/a | PENDING | Roadmap |
| 18.BM1 | CCV verification fee | n/a | n/a | PENDING | Roadmap |
| 18.BM2 | Issuer subscription | n/a | n/a | PENDING | Roadmap |
| 18.BM3 | Feed SLA | n/a | n/a | PENDING | Roadmap |
| 18.BM4 | Dedicated cells | n/a | n/a | PENDING | Roadmap |
| 18.CP | Competitive landscape, GTM and moat on the business slide | deck | n/a | PENDING | Roadmap (deck slide 7) |

## 19. Risks and open questions

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 19.RK1 | CCV registration not ready: Fallback B from hour 4 | pools | `KirchhoffTokenPool.t.sol`; deployed | DONE | |
| 19.RK2 | CRE live deploy not granted: simulate, labeled honestly | README, SIM_LOG | n/a | DONE | |
| 19.RK3 | False DRIFT or BROKEN from in-flight: matching, scenario 2 | `matchAll` | scenario 2 PASS | DONE | |
| 19.RK4 | Testnet congestion: reset script, three takes, backup recorder | `demo/reset.ts` | n/a | PENDING | Deferred by product owner (demo video work paused until the owner asks); reset measured at 1426.5 s on testnets (15.REC1) |
| 19.RK5 | "Just monitoring": hero shot is a refused CCIP message | Attack Lab | n/a | PENDING | Real `ccipSend` refusal is coded in `demo/src/attack.ts`; not yet recorded on testnet (5.B5, 15.DS5) |
| 19.RK6 | Someone ships the same idea: ship first, publish the spec | n/a | n/a | PENDING | Submission |
| 19.RK7 | Team split with another build: decide before hour 0 | n/a | one repo, one project | DONE | |
| 19.OQ1 | Steps to require our CCV on lanes; aggregator onboarding | `docs/research/ccv.md` section 5, `ccv/STATUS.md` | n/a | DONE | Answered from docs: onchain steps self-serve, indexer onboarding by email; mentor confirmation still in HUMAN_TASKS |
| 19.OQ2 | Hook request carries amounts and source tx hash | `docs/research/ccv.md` TL;DR item 2 | n/a | DONE | Yes |
| 19.OQ3 | CRE live deployment during the event | `docs/research/cre.md` section 4 | `cre whoami` | DONE | Answered: not enabled for our org |
| 19.OQ4 | Log trigger confidence options | `docs/research/cre.md` TL;DR item 5 | n/a | DONE | LATEST, SAFE, FINALIZED; reads have no SAFE |
| 19.OQ5 | CRE per-run limits on `filterLogs` and calls | `docs/research/cre.md` section 8 | n/a | DONE | 100 blocks, 15 reads |
| 19.OQ6 | Token pool interface version on the lanes | `docs/research/ccip.md` TL;DR item 1 | n/a | DONE | CCIP 2.0.0 pools |
| 19.OQ7 | Finality time on each testnet | `docs/research/ccip.md` section 8 | n/a | DONE | Sepolia 13 to 17 min to the verifier |

## 20. References

| ID | Requirement | Code | Test / evidence | Status | Note |
| --- | --- | --- | --- | --- | --- |
| 20.REF | Chainlink, hackathon and incident references used and cited | `docs/research/*`, `README.md` | n/a | DONE | |

---

## Deviations from the PRD

Each is deliberate and documented in the linked source.

| # | Deviation | Reason | Source |
| --- | --- | --- | --- |
| D1 | `PENDING_ATTESTATION` is returned as HTTP 503 `{"error":"PENDING_ATTESTATION ..."}`, not `{"decision":"FAIL"}` | chainlink-ccv drops a FAILed message permanently and retries non-2xx for up to 7 days; a FAIL would lose a valid message | INTERFACES.md Revision 2 item 1; `docs/research/ccv.md` |
| D2 | Extra reason code `TOKEN_RECOVERING` (14) | PRD step 6 says "FAIL with that reason" for RECOVERING but its table had no code | INTERFACES.md "Enums" |
| D3 | WeakBridge and HomeEscrowAdapter expose `debitOf` / `creditOf`; W1 confirms the debit with one `callContract` at the pinned block and uses `filterLogs` over 100 blocks only for evidence | CRE limits `filterLogs` to 100 blocks per query and 15 reads per execution | INTERFACES.md Revision 2 item 3 |
| D4 | All 4 workflows simulate; for a live deploy W4's handlers merge into W2 | CRE allows 3 deployed workflows per org | Revision 2 item 6; `workflows/README.md` |
| D5 | `engine/specs/kETH.yaml` lists `weakbridge_base` as a Base minter (the PRD example listed only `ccip_pool_base`) | `Deploy.s.sol` grants the Base WeakBridge the minter role, so the spec must declare it or W4 correctly flags it | `engine/specs/kETH.yaml`; `workflows/README.md` "Known limitations" |
| D6 | Judge reads are provider-paired: one Multicall3 `aggregate3` per chain per provider, and the engine receives each read as a pair | Both values come from the same block per provider; disagreement handling is deterministic engine logic | `judge/README.md`; commit `c816610` |
| D7 | `ConservationFeed.decimals() = 0`; answer is the status enum; `roundId` is the ledger revision; when stale only CONSERVED and DRIFT degrade to 0 | Status is an integer code, not a price; a stalled engine must never hide a breach | INTERFACES.md "Staleness"; `contracts/README.md` decision 9 |
| D8 | CCIP debits matched through the OnRamp `CCIPMessageSent` in the same tx, credits through the OffRamp `ExecutionStateChanged`; Judge filters `eth_getLogs` by block and address, pairs in the client | CCIP 2.0.0 pool events carry no message id | Revision 2 item 2; `docs/research/ccip.md` |
| D9 | Spec `safe` confidence reads at finalized | CRE chain reads have no SAFE option | Revision 2 item 4 |
| D10 | Fallback B is pool subclasses overriding `_validateLockOrBurn` / `_validateReleaseOrMint`, not an `AdvancedPoolHooks` subclass; CCV requirement not wired | `LockReleaseTokenPool` marks the internal hooks non-virtual; every V1 and V2 entry point passes the validators | `contracts/README.md` decision 2 |
| D11 | `CREReceiver` allowlists `workflowId -> (owner, name, report types)` instead of one expected id; simulation ledgers pin id `0x11..11`, owner `0xaa..aa` | Three workflows write one ledger; simulation uses fixed metadata | `contracts/README.md` decision 1; Revision 2 item 7 |
| D12 | Home backing = `HomeEscrowAdapter` balance + CCIP `ERC20LockBox` balance | CCIP 2.0 lock-release liquidity sits in the LockBox | `contracts/README.md` decision 3 |
| D13 | EPOCH from UNKNOWN must be CONSERVED; BREACH idempotent per incident; per-token epoch high-water mark | Safe redelivery and no replay of an old RECOVERY_CHECK | `contracts/README.md` decisions 4, 5, 7 |
| D14 | BROKEN to QUARANTINED is applied by W3 in the run triggered by `BreachRecorded`, right after W1, not inside W1's run | W1 is authorized for BREACH only; containment stays a separate least-privilege workflow | `workflows/README.md` |
| D15 | W1's OK path writes nothing; W2 re-derives the match and marks the id consumed in its next EPOCH | Keeps W1 BREACH-only and avoids a second writer of EPOCH | `workflows/README.md` "W1 OK path" |
| D16 | Epoch ids are `max(latest + 1, now seconds)` | Ignored EPOCHs raise an unreadable high-water mark | `workflows/README.md` "Epoch ids" |
| D17 | Claude is reached through OpenRouter by default (Anthropic direct supported) | Credential available within the budget | `ai/src/provider.ts`; `HUMAN_TASKS.md` |
| D18 | CCV cell on local k3d with one shared Judge; HMAC credentials via the chart's `existingSecret` path (`JUDGE_AUTH=hmac`), default insecure behind a NetworkPolicy | Chart v0.8.0 does not template the policy hook credential; no cloud VM | `ccv/STATUS.md`; `judge/README.md` "insecure mode" |
| D19 | On Vercel the API streams over SSE (`/v1/stream/sse`); WebSocket on the long-running server | Serverless functions do not hold WebSockets | `api/src/app.ts` |
| D20 | Testnet ledgers are in `simulation` forwarder mode (Chainlink `MockKeystoneForwarder`) | CRE deploy access not enabled; simulation broadcasts through the mock | `deployments/testnet-*.raw.json` `forwarderMode` |
| D21 | Registry timelock 600 s on testnet | PRD allows 10 minutes for the testnet demo | onchain `timelockSeconds() = 600` |
| D22 | Cut list applied out of top-down order: items 4 (LayerZero adapter) and 5 (4-cell committee) are cut while items 1 to 3 shipped | Items 1 to 3 were cheap and already built; items 4 and 5 were stretch goals in the PRD itself (adapter table "Stretch at hackathon", deployment plan step 5 "if time allows") | PRD sections 9, 10, 16 |
| D23 | W4 "reload active specs" checks the registry's `activeSpecHash` on every run and raises DRIFT `SPEC_MISMATCH` when it differs from the compiled spec; it does not hot-swap configs, which `gen-config` regenerates from the active spec | CRE workflow configs are fixed per deployment, and a workflow that silently changed its own rules would defeat the Safe plus timelock | `workflows/src/w4.ts`; commit `89f8e2e` |

## Pending work (hackathon scope)

Ordered by impact on the demo. Done since 2026-10-05: spec activation on testnet, staging simulation, Vercel deploys,
the full Playwright run, axe and keyboard suites, sourced Ops figures, W4 gaps, PoR read, automatic backtest, notifier
(PagerDuty, deficit, offending tx, narrative), Topology Scout wiring, spec diff alert, the 2.M2 latency measurement.

1. **Kelp Replay on testnets**: a passing `demo e2e --network testnet`, three times, with explorer links (1.R6, 2.G4,
   16.HG3, 16.NC7, 17.TL7, 17.DOD2). The pipeline pieces already ran on testnets (Loop BREACH, W3 quarantine, Safe
   resolution, RECOVERY_CHECK); a 3-run series was in progress at audit time (`demo/logs/series.txt`).
2. **Real CCIP refusal recorded**: the coded `Router.ccipSend` refusal run on testnet (5.B5 note, 15.DS5, 19.RK5).
3. **Flow A on testnet**: a real kETH CCIP transfer with PASS (5.A1).
4. **Live read model**: keep the indexer running against testnets so the live Mission Control and "Replay last
   incident" show the testnet incidents (15.SUB2, 16.TM7).
5. **W1 green on staging** recorded in SIM_LOG (16.TM4).
6. **Reset under 3 minutes on testnets**: measured 1426.5 s, dominated by finality waits (15.REC1).
7. **Every number linked**: extend the Ops sweep to Mission Control and Incident Room (17.DOD3).
8. **CCV attestation path** (only if time allows): deploy the CCV kit resolver and verifier, register the signer,
   `applyCCVConfigUpdates` on the kETH pools, expose the aggregator over TLS, run "test your setup" (9.D1, 9.D2, 9.D4,
   9.FB2, 9.H5).
9. **Measurements**: real-history backtest with zero false BROKEN (2.M3, 3.S1, 6.LC3), Judge latency with keyed RPCs
   (2.M4), onboarding time (2.M6).
10. **Engine gaps**: spec fields wired into deploy (6.K4); rebasing shares end to end (10.SR1).
11. **Nice-to-have**: held-message replay execution with Safe approval (3.N1); holder Telegram subscription (3.N2).
12. **Deferred by product owner**: demo video and its use in the deck (2.G5, 15.DS1-8, 15.DK4, 15.SUB3, 15.REC2-4,
    16.TM1, 19.RK4). The deck generator and an 8-slide `media/deck/KIRCHHOFF.pptx` exist.
13. **Submission**: both track submissions before the deadline (2.G1, 15.SUB4, 15.SUB5, 16.HG4, 16.HG5, 19.RK6).

## Pending measurement

- Zero false BROKEN over the real kETH history (2.M3)
- Policy hook p99 with real RPC providers under load (2.M4)
- Spec Copilot onboarding time for kETH (2.M6)
- Loop Rule breach to BROKEN on public testnets (measured on Anvil only: 2 to 4 s after confidence, 2.M2)

## Counting

```bash
for s in DONE FALLBACK CUT; do printf '%s ' $s; grep -cE "^\| [0-9]+\.[A-Za-z0-9.]+ \|.*\| $s \|" PRD_TRACEABILITY.md; done
grep -cE '^\| [0-9]+\.[A-Za-z0-9.]+ \|.*\| PENDING \| Roadmap' PRD_TRACEABILITY.md
grep -cE '^\| [0-9]+\.[A-Za-z0-9.]+ \|.*\| PENDING \|' PRD_TRACEABILITY.md
```
