# KIRCHHOFF submission (TOKEN2049 Origins)

Status as of 2026-10-06. Deadline: 11:59 pm, October 7, 2026. Every demo element is a **Testnet simulation**.
Requirement-level detail: [PRD_TRACEABILITY.md](PRD_TRACEABILITY.md).

## Submission checklist (PRD section 15)

| # | Item | Status | Evidence / what remains |
| --- | --- | --- | --- |
| 1 | Public GitHub repo with README, architecture diagram, deployed addresses per chain, CRE workflow ids, and how to reproduce the Kelp Replay | PENDING | [README.md](README.md) has all of it (diagram, verified addresses on 3 testnets, workflow names and simulation ids, local and testnet replay steps). The repo has no git remote yet and nothing is pushed. Live DON workflow ids do not exist: CRE deploy access is not enabled |
| 2 | Live URL: public Mission Control in read-only mode with a "Replay last incident" timeline | PENDING | Built (`web/components/mission/incident-replay.tsx`, `web/vercel.json`, `api/vercel.json` in `sin1`); not deployed. Needs a real incident on testnet first |
| 3 | Deck uploaded to Google Drive as .pptx with the video embedded | PENDING | No deck or video in the repo yet |
| 4 | Main track plus Chainlink track submissions, with a paragraph on exactly how CRE and CCIP are used | PENDING | Paragraphs drafted below |
| 5 | Submitted before 11:59 pm on October 7 | PENDING | Human task |

## Recording checklist (PRD section 15)

| # | Item | Status | Evidence / what remains |
| --- | --- | --- | --- |
| 1 | `demo/reset.ts` restores all three chains to a clean, conserved state in under 3 minutes | PENDING | `demo/src/reset.ts` measures `elapsedMs`; `demo/e2e.ts` asserts under 180 s on local only. No recorded timing; pending measurement on testnets |
| 2 | At least three full takes; keep the best one unedited apart from trimming | PENDING | Needs the testnet Kelp Replay first |
| 3 | Explorer tabs pre-opened for each transaction; clock and timestamps visible | PENDING | Every demo step emits its explorer link (`demo/src/attack.ts`); CCIP explorer link is still a placeholder |
| 4 | A second machine records a backup take in parallel | PENDING | Human task |

## Chainlink track: how we use CRE and CCIP

KIRCHHOFF is an economic Cross-Chain Verifier: it refuses a transfer when a token's supply stops adding up across
chains. The Conservation Engine is four TypeScript CRE workflows (`@chainlink/cre-sdk` 1.23.0). W1 Junction Watch
fires on an EVM Log trigger for every bridge credit, pins the claimed source chain with `headerByNumber`
(finalized), confirms the debit with `callContract` at that block, attaches `filterLogs` evidence, and if no debit
exists writes a BREACH report to the ConservationLedger on Ethereum, Arbitrum and Base Sepolia in the same run via
`writeReport` and the KeystoneForwarder. W2 Loop Ledger runs on a 30 second cron plus supply log triggers, makes one
Multicall3 `callContract` per chain at pinned blocks and writes signed EPOCH reports with Δ. W3 Responder triggers
on `BreachRecorded`, writes QUARANTINE_APPLIED and pages through the HTTP capability with CRE secrets. W4 watches
`SpecActivated` and minter grants. Our ledgers inherit the ReceiverTemplate pattern and accept only allowlisted
workflows. On CCIP 2.0, kETH is a Cross-Chain Token whose CCIP 2.0.0 pools enforce the ledger status in
`lockOrBurn` / `releaseOrMint` (Fallback B, live), and our Judge is the policy hook of a CCV Starter Kit cell. Honest
status: CRE deploy access is not enabled, so workflows run with `cre workflow simulate`; our CCV is not yet onboarded
for live attestation.

## Main track summary

Every bridge checks who signed. KIRCHHOFF checks if the money adds up. In April 2026 one forged message released
about $292M of rsETH from a bridge configured with a single verifier, and holders on 20 chains lost value. A simple
sum would have caught it. KIRCHHOFF enforces two rules borrowed from Kirchhoff's circuit laws: every credit on any
chain must match a finalized debit with the same message id, amount and recipient (Junction Rule), and backing must
cover every claim across all chains and bridges (Loop Rule). The rules live in one deterministic engine shared by
Chainlink CRE workflows, a CCIP 2.0 CCV policy hook and a backtester, so they always agree, and AI never sits in the
veto path. When the Kelp pattern is replayed on our Testnet simulation, the breach is written to all three ledgers
in the same CRE run, CCIP lanes freeze, the attacker's tokens cannot move, and a lending market refuses to lend
against them. Mission Control shows it as a circuit that turns red; an AI Incident Narrator explains it with
citations; agents query it through MCP before moving funds.

## Judging weights mapped to evidence

| Criterion (weight) | Evidence |
| --- | --- |
| Functionality (30%) | 150 Foundry tests and 463 TypeScript tests passing (`forge test`, `pnpm -r test`, 2026-10-05); six PRD scenarios pass through `cre workflow simulate --broadcast` on 3 chains (`workflows/SIMULATION_LOG.md`); full contract suite deployed and source-verified on 3 testnets with kETH registered as a CCIP Cross-Chain Token. Pending: the Kelp Replay run on testnets |
| Technical implementation (25%) | Engine at 100% branch coverage (586/586) with a 10,000-run property test; four CRE workflows inside the 15-read / 100-block per-run limits; Judge built to the chainlink-ccv OpenAPI spec with HMAC, two-provider agreement and a 2 s budget; CCIP 2.0.0 pool subclasses; real KeystoneForwarder signature path tested |
| Innovation (20%) | We found no public CCV that checks economic conservation; KIRCHHOFF verifies whether a message is economically possible, across bridges it does not sit on, and uses the CCV slot CCIP 2.0 opened on September 28 |
| Usefulness (15%) | Additive to the Committee Verifier; AggregatorV3-compatible Conservation Feed that lending markets read (`DemoLendingMarket` freezes borrowing); REST, SDK and MCP for apps and agents; Spec Copilot onboards a token (eval: 19/19 fields, 100% provenance, 0 of 10 injection misuse) |
| Demo (10%) | Attack Lab plus stage mode (`?stage=1`, 1920x1080) with Playwright stage snapshots in dark and light. Pending: recording and deck |
