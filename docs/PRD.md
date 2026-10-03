# KIRCHHOFF PRD: Conservation Verifier for Cross-Chain Value

Oct 4, 2026 · @yathu don

## 1. Overview

**KIRCHHOFF is a Cross-Chain Verifier (CCV) for Chainlink CCIP 2.0 that refuses to sign any transfer when a token's money stops adding up across chains.**

Every bridge today verifies who signed a message. None verifies whether the message is economically possible. KIRCHHOFF enforces one law, named after Kirchhoff's current law: what flows out of a junction must equal what flows in. For tokens, total supply on every chain and every bridge can never exceed what is locked or backed at the source.

### Problem

- On April 18, 2026, attackers forged a LayerZero message and released about 116,500 rsETH, worth about $292M, from Kelp DAO's bridge. ([Crypto Times](https://www.cryptotimes.io/2026/05/18/crypto-bridge-hacks-top-328m-in-2026-as-cross-chain-exploits-accelerate/))
- The forged message passed because the bridge was configured with a single verifier. ([Decrypt](https://decrypt.co/379463))
- rsETH holders on 20 chains lost value without ever touching Kelp. ([Phemex](https://phemex.com/blogs/defi-hacks-2026-bridge-exploits-explained))
- Bridge exploits drained over $340M across 14 incidents in 2026. ([DexTools / PeckShield](https://www.dextools.io/news/crypto-bridge-hacks-340-million-2026-peckshield-alert-june-2026-de))
- In every one of these cases, a simple sum would have exposed the fake supply the moment it appeared.

### Why now

- Chainlink launched CCIP 2.0 on September 28, 2026. Issuers can require their own CCV, and both the default Committee Verifier and that CCV must sign before execution. ([Chainlink](https://chain.link/blog/introducing-ccip-2-0))
- An open CCV marketplace lets third-party verifiers charge their own fees on top of the CCIP base fee. ([Chainlink](https://chain.link/blog/introducing-ccip-2-0))
- Infosys and Nethermind are already building CCVs for clients, and Kelp said in May it was moving rsETH to CCIP. ([Unchained](https://unchainedcrypto.com/?p=47980))
- We found no public CCV that checks economic conservation. The category is open, and it is days old.

### What we ship at TOKEN2049 (Singapore, Oct 6 to 8, 2026)

1. **Conservation Engine:** a CRE workflow that reads supply, locks and reserves on 3+ chains with DON consensus.
2. **KIRCHHOFF CCV:** a policy hook plus onchain verifier that signs PASS or FAIL for every CCIP message of a protected token.
3. **Quarantine:** the excess on an infected chain is frozen; clean chains keep working.
4. **Mission Control:** a live ledger UI of every chain, the invariant, and every verdict.
5. **Spec Copilot (AI):** turns a plain-English token description into a machine-checked invariant spec. AI never sits in the veto path.
6. **Kelp Replay:** a scripted forged-message attack that the room watches fail.

**The line we sell:** "Every bridge checks who signed. KIRCHHOFF checks if the money adds up."

## 2. Goals, non-goals, success metrics

**We win if a judge watches a $292M-class forged message get refused live, and understands why in 10 seconds.**

### Hackathon goals (TOKEN2049 Origins, 36h)

1. Win the Chainlink track ("Best workflow with CRE") and place in the main-track Top 5.
2. Ship a working CRE workflow that is the core of the product, not a side call.
3. Ship a real CCV policy hook running inside the CCV Starter Kit cell, with a working fallback path.
4. Demonstrate the Kelp Replay end to end on public testnets, with real transactions and explorer links.
5. Deliver a UI good enough to screen-record for the stage video without edits.

### Product goals (12 months)

1. Become the default economic CCV in the CCIP 2.0 marketplace for multi-chain LST, LRT, wrapped BTC and stablecoin issuers.
2. Cover tokens that use several bridges at once (CCIP plus LayerZero, Wormhole, native bridges).
3. Publish a public conservation status feed that lending protocols consume to auto-freeze broken assets.

### Non-goals

- We do not replace the CCIP Committee Verifier. KIRCHHOFF is additive defense in depth, exactly as Chainlink recommends.
- We do not run a bridge, custody funds, or move user tokens.
- AI never makes a PASS or FAIL decision. Verdicts come only from deterministic math over consensus data.
- No AI agent trading, no yield, no wallet. Out of scope.
- No price-based anomaly detection in the veto path. Prices are irrelevant to conservation.

### Success metrics

| Metric | Hackathon target | Production target |
| --- | --- | --- |
| Forged-credit detection (Junction Rule) | Same CRE run as the credit event | Before destination execution on CCIP lanes |
| Loop Rule breach to BROKEN status onchain | Under 60s after the breach block reaches the configured confidence | Under 1 CRE cycle after confidence |
| False BROKEN verdicts in backtest | 0 over the demo token's full history | 0 over 90 days of real token history per onboarded token |
| Policy hook latency (p99) | Under 300 ms | Under 150 ms |
| Chains covered in demo | 3 testnets, 2 bridges | 10+ chains, 4 bridge families |
| Time to onboard a token with Spec Copilot | Under 10 min for the demo token | Under 1 day including backtest and issuer sign-off |

All latency targets are design targets. We measure them during the build and report real numbers in the deck.

## 3. Users, personas, jobs to be done

**The buyer is the token issuer; the beneficiaries are every holder and every protocol that accepts the token as collateral.**

| Persona | Who, concretely | Job to be done | What they see in KIRCHHOFF |
| --- | --- | --- | --- |
| Issuer security lead (buyer) | Security or protocol lead at a multi-chain LRT, LST, wrapped BTC or stablecoin issuer | "Make it impossible for a forged message to mint or release my token anywhere." | Onboarding wizard, Spec Copilot, Incident Room, quarantine controls |
| Issuer ops / on-call | The engineer paged at 3am | "Tell me in one screen what broke, where, by how much, and what is already contained." | Incident Room with AI narrative and evidence links |
| Lending protocol risk steward | Risk team at a money market or vault curator | "Freeze a collateral asset automatically the moment its backing breaks." | Conservation Feed (AggregatorV3-compatible), public status page |
| Token holder | Anyone holding the token on any chain | "Is my token on this chain fully backed right now?" | Public status page with a single CONSERVED / BROKEN badge |
| CCV operator | Infra firm running cells (e.g. Infosys, Nethermind class) or the issuer itself | "Run an economic verifier without building the math myself." | Verifier Ops screen, Helm values, policy hook image |
| AI agent | Autonomous agent moving funds across chains | "Before I bridge, is this token safe to move?" | MCP tool `kirchhoff.status` and the public API |
| Judge (hackathon) | Chainlink engineer, VC, TOKEN2049 judge | "Is this new, real, and does it need Chainlink?" | Kelp Replay in Mission Control, architecture slide |

### Top user stories (must ship)

1. As an issuer, I describe my token in plain English and get a spec I can approve, with a backtest proving it never false-alarms on my history.
2. As an issuer, every CCIP transfer of my token is signed by KIRCHHOFF only if the money adds up.
3. As an issuer, when another bridge is exploited, my CCIP lanes stop the attacker from spreading the fake supply.
4. As a risk steward, my market reads one feed and freezes the asset when it breaks.
5. As on-call, I get a page with the exact deficit, the offending transaction, and what is already quarantined.
6. As an agent, I query one MCP tool before moving funds.

### Nice-to-have stories (ship if time allows)

- As an issuer, I replay held messages after an incident is resolved, with multisig approval.
- As a holder, I subscribe to a Telegram alert for my token's status.

## 4. Core concepts and glossary

**KIRCHHOFF enforces two rules, borrowed from Kirchhoff's two circuit laws: the Junction Rule per message, and the Loop Rule across all chains.**

### The two rules

- **Junction Rule (per message, exact).** Every credit on a destination chain (a mint or a release) must match a finalized debit on a source chain (a burn or a lock) with the same message id, token, amount and recipient. A credit with no matching debit is forged. This catches the Kelp attack on the first transaction.
- **Loop Rule (global, per epoch).** Across all chains and all bridges, backing must cover everything that claims it. For a lock-and-release token: escrow on the home chain must be at least the supply on every remote chain plus everything in flight. A deficit means value was created from nothing, whichever path created it.

The Junction Rule is fast and precise. The Loop Rule is the safety net that catches what the Junction Rule cannot see, such as a compromised mint key minting with no message at all.

### Glossary

| Term | Meaning |
| --- | --- |
| Protected token | A token onboarded to KIRCHHOFF with an approved spec |
| KIRCH-SPEC | The declarative spec of a token: chains, contracts, bridges, debit and credit events, rules, responses |
| Home chain | Chain holding the canonical token and the escrow in a lock-and-release model |
| Remote chain | Chain holding a minted representation of the token |
| Debit | A source-side event that removes value: lock into escrow, or burn |
| Credit | A destination-side event that adds value: release from escrow, or mint |
| In flight | Debited on the source, not yet credited on the destination |
| Epoch | One Conservation Engine evaluation, keyed to a set of pinned block numbers, one per chain |
| Deficit (Δ) | Backing minus claims. Negative Δ is a breach |
| Confidence | The block confidence a chain read requires: latest, safe or finalized, set per chain in the spec |
| Verdict | PASS or FAIL for one CCIP message, plus a reason code |
| Quarantine | Containment after a breach: CCIP lanes for the token freeze, offending recipients are tainted, the feed flips to BROKEN |
| Conservation Feed | Onchain, AggregatorV3-compatible feed of status and Δ, one per token per chain |
| Cell | One CCV verifier plus aggregator plus Postgres, run from the CCV Starter Kit |
| Policy hook | The HTTPS endpoint the CCV verifier calls before signing; returns PASS or FAIL |

### Token status machine

| Status | Meaning | CCIP verdicts | Feed answer |
| --- | --- | --- | --- |
| UNKNOWN | No fresh epoch within the staleness window | Per-token policy: fail-closed (default) or fail-open | 0 |
| CONSERVED | Both rules hold | PASS if the message passes the Junction Rule | 1 |
| DRIFT | A soft rule tripped (flow rate, unmatched credit still inside its match window). No breach | PASS, flagged in the UI | 2 |
| BROKEN | Junction or Loop Rule breached | FAIL for all messages of the token | 3 |
| QUARANTINED | BROKEN plus containment actions applied | FAIL; held messages kept for replay | 4 |
| RECOVERING | Issuer multisig resolved the incident; timelock running | FAIL until the timelock ends, then CONSERVED | 5 |

Allowed transitions: UNKNOWN to CONSERVED; CONSERVED to DRIFT, BROKEN or UNKNOWN; DRIFT to CONSERVED or BROKEN; BROKEN to QUARANTINED (automatic, same run); QUARANTINED to RECOVERING (issuer multisig only); RECOVERING to CONSERVED (after the timelock, and only if a fresh epoch shows Δ of zero or more).

## 5. System architecture

**Design law: nothing we operate alone can produce a verdict. Verdicts come only from CRE DON consensus data, onchain state, and a deterministic Judge that each CCV cell runs independently.**

The UI, the AI services and the API can all be offline, and every verdict still works.

&#91;embedded content: KIRCHHOFF architecture · 4 layers\]

The CRE engine reads every chain and writes signed reports back; CCIP executes only when both our cells and the Chainlink committee sign; the control plane only mirrors onchain state.

### Components

| # | Component | Runs where | Built with | In the veto path? |
| --- | --- | --- | --- | --- |
| 1 | Protected token contracts (canonical, escrow adapter, remote tokens) | Each chain | Solidity, Foundry | Data source only |
| 2 | KIRCHHOFF onchain suite: Registry, ConservationLedger, ConservationFeed, QuarantineController, KirchhoffGuard, KirchhoffTokenPool | Ledger, Feed and Quarantine on every chain; Registry on home chain | Solidity 0.8.26, Foundry | Yes |
| 3 | Conservation Engine: 4 CRE workflows (W1 Junction Watch, W2 Loop Ledger, W3 Responder, W4 Topology Watch) | Chainlink CRE DONs | CRE TypeScript SDK, viem | Yes |
| 4 | KIRCHHOFF CCV: committee of cells, each running the Judge policy hook | Kubernetes (4 cells, threshold 3 in production; 1 to 4 cells at the hackathon) | CCV Starter Kit Helm chart; Judge in Go or TypeScript | Yes |
| 5 | Indexer and API | Our cloud | Postgres, Ponder (or custom viem indexer), Fastify, WebSocket | No |
| 6 | AI services: Spec Copilot, Incident Narrator, Topology Scout | Our cloud | Claude via Anthropic API, tool use, JSON schema outputs | No |
| 7 | MCP server and public API | Our cloud | MCP TypeScript SDK | No |
| 8 | Mission Control frontend | Vercel | Next.js 15, React, Tailwind, shadcn/ui, Framer Motion, viem/wagmi | No |
| 9 | Notifier | Our cloud plus CRE HTTP capability | Telegram, Slack, PagerDuty webhooks | No |

### Normal CCIP transfer (Flow A)

1. A user sends 10 kETH from Arbitrum Sepolia to Ethereum Sepolia through CCIP. The source token pool burns 10 kETH and CCIP emits the message.
2. Each KIRCHHOFF cell's verifier picks up the message after source finality and POSTs it to its local Judge at `/v1/evaluate`.
3. The Judge reads the token's status from `ConservationLedger` on the destination chain through its own RPC.
4. The Judge fetches the source transaction receipt through its own RPC and confirms a pool burn of exactly 10 kETH for this message id.
5. Status is CONSERVED and the burn matches, so the Judge returns PASS. The cell signs.
6. The CCIP Committee Verifier signs too. Both signatures exist, so the executor releases 10 kETH on Ethereum Sepolia.
7. W1 sees the release, matches it to the burn, and marks the message settled. W2's next epoch shows Δ unchanged.

### Forged message on another bridge (Flow B, the Kelp Replay)

1. The attacker forges a WeakBridge message. The home escrow adapter releases 116,500 kETH to the attacker on Ethereum Sepolia.
2. W1's EVM log trigger fires on the `Released` event. It searches every remote chain for the matching `Burned` debit. None exists.
3. W1 writes BROKEN, with the evidence hash, to `ConservationLedger` on all three chains in the same run.
4. W3 Responder applies quarantine: CCIP lanes for kETH freeze, the attacker address is tainted, and the Conservation Feed answers BROKEN.
5. The attacker tries to move the stolen kETH to Base through CCIP. Every cell's Judge returns FAIL with reason `TOKEN_BROKEN`. The message never executes.
6. KirchhoffGuard on the kETH token blocks transfers from the tainted address on the home chain. The demo lending market freezes kETH borrowing from the feed.
7. W2's next epoch confirms the Loop Rule deficit: Δ = minus 116,500 kETH.

### Trust boundaries

| Boundary | What we trust | Mitigation |
| --- | --- | --- |
| Chain data | RPC answers | CRE DON consensus across nodes; each Judge uses its own independent RPC providers |
| CRE DON | Honest majority of DON nodes | KIRCHHOFF is additive: the CCIP Committee Verifier still signs every message |
| CCV cells | 3 of 4 cells honest (production) | Independent clouds, own keys in KMS, own RPCs |
| Spec | Issuer governance | Spec changes need issuer multisig plus a 48h timelock, so an attacker cannot loosen rules first |
| Control plane | Nothing | It cannot sign, write verdicts or change status |

## 6. Invariant engine and KIRCH-SPEC

**One pure TypeScript library, `@kirchhoff/engine`, computes every verdict. The same code runs inside the CRE workflows (compiled to WASM), the backtester, and the Judge, so all three always agree.**

Engine rules: bigint math only, no floats, no `Date.now()`, no randomness, no network calls inside the library. Inputs are plain data; outputs are plain data. 100% branch coverage is required.

### Loop Rule math

Lock-and-release model. E is home-chain escrow at pinned block b\_H; S\_i is remote supply on chain i at pinned block b\_i; F\_out is locked but not yet minted; F\_in is burned but not yet released; τ is the tolerance from the spec (0 by default).

```latex
\Delta = E_H(b_H) - \Big( \sum_{i} S_i(b_i) + F_{out} + F_{in} \Big), \qquad \text{BROKEN} \iff \Delta < -\tau
```

Burn-and-mint model (no escrow, every chain mints). I\_net is net authorized issuance from issuer mint and burn events on the issuance chain; R is the Proof of Reserve answer when the token is reserve-backed.

```latex
\sum_{i} S_i(b_i) + F \le \min\big(I_{net},\ R\big) + \tau
```

In-flight amounts F come from message matching, never from snapshot timing. Each debit with no credit yet counts once in F, keyed by message id.

### Junction Rule

For every credit c (mint or release) on any chain, there must exist exactly one debit d such that:

1. `d.messageId == c.messageId` and `d.srcChain == c.claimedSrcChain`
2. `d.token == spec.tokenOn(d.srcChain)` and `d.amount == c.amount`
3. `d.recipient == c.recipient` (when the bridge carries the recipient)
4. d is at or below the source chain's required confidence (finalized by default)
5. d has not already been consumed by an earlier credit (no double credit, no replay)

If the claimed source block is already final and no d exists, the verdict is BROKEN with reason `DEBIT_NOT_FOUND` at once. If the source block is not yet final (a faster-than-finality bridge), the token goes to DRIFT until either d appears or the match window ends, then BROKEN.

### Reason codes

| Code | Rule | Effect |
| --- | --- | --- |
| `OK` | All rules hold | PASS |
| `PENDING_ATTESTATION` | Judge cannot confirm the source debit yet | FAIL now, replay later (hook contract) |
| `DEBIT_NOT_FOUND` | Junction | BROKEN |
| `AMOUNT_MISMATCH` | Junction | BROKEN |
| `RECIPIENT_MISMATCH` | Junction | BROKEN |
| `DOUBLE_CREDIT` | Junction | BROKEN |
| `LOOP_DEFICIT` | Loop | BROKEN |
| `RESERVE_SHORTFALL` | Loop (backed tokens) | BROKEN |
| `FLOW_LIMIT` | Soft rule | DRIFT, PASS with flag |
| `STATUS_STALE` | No epoch inside the staleness window | Per-token fail-closed (default) or fail-open |
| `TOKEN_BROKEN` / `TOKEN_QUARANTINED` | Status | FAIL |
| `UNKNOWN_TOKEN` / `SPEC_MISMATCH` | Registry | FAIL |

### KIRCH-SPEC (the token spec)

YAML authored by the issuer (or drafted by Spec Copilot), validated against a JSON Schema, compiled into the CRE workflow config and hashed into the onchain Registry.

```yaml
spec_version: 1
token: kETH
model: lock_release_home        # or burn_mint_multi
home:
  chain: ethereum-testnet-sepolia
  canonical: "0xCanonical..."
  escrow: "0xEscrowAdapter..."
remotes:
  - chain: ethereum-testnet-sepolia-arbitrum-1
    token: "0xRemoteArb..."
    minters: [ccip_pool_arb, weakbridge_arb]
  - chain: ethereum-testnet-sepolia-base-1
    token: "0xRemoteBase..."
    minters: [ccip_pool_base]
bridges:
  - id: ccip
    kind: ccip_v2
    pools: { home: "0xPoolHome...", arb: "0xPoolArb...", base: "0xPoolBase..." }
  - id: weakbridge
    kind: custom
    debit_event: "Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain)"
    credit_event: "Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain)"
    search_window_blocks: 50000
reserves:
  por_feed: null                # AggregatorV3 address for backed tokens
confidence:
  default: finalized
  overrides: { ethereum-testnet-sepolia-base-1: safe }
rules:
  junction: { match_window_seconds: 1200 }
  loop: { tolerance_wei: "0", breach_confirmations: 1 }
  soft:
    flow_limit_per_hour: "50000e18"
  staleness_seconds: 120
  on_stale: fail_closed
response:
  on_broken: [freeze_ccip_lanes, taint_recipient, flip_feed, page_issuer]
  replay_requires: issuer_multisig
  recovery_timelock_seconds: 3600
```

### Spec lifecycle

1. Draft: issuer writes YAML or accepts a Spec Copilot draft.
2. Validate: JSON Schema plus semantic checks (every remote has at least one minter; every minter maps to a bridge; every address has bytecode on its chain).
3. Backtest: the engine replays the token's full event history. Any BROKEN on real history blocks activation.
4. Propose: the spec hash is proposed onchain in `KirchhoffRegistry` by the issuer multisig.
5. Timelock: 48h in production (10 minutes on testnet for the demo), visible in the UI.
6. Activate: the Registry emits `SpecActivated`; W4 picks it up and the workflows load the new config.

## 7. Smart contracts

**Six production contracts plus five demo contracts, Solidity 0.8.26, Foundry, OpenZeppelin 5.x. Every contract that receives CRE data inherits Chainlink's `ReceiverTemplate` and only accepts reports from the `KeystoneForwarder` and our registered workflow.**

### Production contracts

| Contract | Chains | Purpose |
| --- | --- | --- |
| `KirchhoffRegistry` | Home | Spec hash, spec URI, issuer Safe, timelock, activation per token |
| `ConservationLedger` | Every chain | Latest epoch, status, Δ, breach evidence; receives CRE reports |
| `QuarantineController` | Every chain | Lane freeze flag, tainted addresses, incident resolution, recovery timelock |
| `ConservationFeed` | Every chain | AggregatorV3-compatible status feed for lending markets |
| `KirchhoffGuard` | Opt-in, any chain | Token transfer hook that blocks tainted addresses |
| `KirchhoffTokenPool` | Opt-in, CCIP lanes | Fallback enforcement inside CCIP token pools if CCV registration is not available |

### Core interfaces

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

enum Status { UNKNOWN, CONSERVED, DRIFT, BROKEN, QUARANTINED, RECOVERING }

struct Epoch {
    uint64  epochId;       // strictly increasing per token
    int256  delta;         // backing minus claims, token base units
    uint64  evaluatedAt;   // block timestamp of the report write
    bytes32 blocksHash;    // keccak of pinned (chainSelector, blockNumber) pairs
    bytes32 evidenceHash;  // keccak of the evidence bundle (IPFS CID stored offchain)
    Status  status;
    uint16  reason;        // reason code from section 6
}

interface IConservationLedger {
    event EpochRecorded(bytes32 indexed tokenId, uint64 indexed epochId, int256 delta, Status status);
    event StatusChanged(bytes32 indexed tokenId, Status from, Status to, uint16 reason);
    event BreachRecorded(bytes32 indexed tokenId, uint16 reason, bytes32 evidenceHash,
                         uint64 offendingChain, bytes32 offendingTx, address recipient, uint256 amount);

    function statusOf(bytes32 tokenId) external view
        returns (Status status, int256 delta, uint64 updatedAt, bool stale);
    function latestEpoch(bytes32 tokenId) external view returns (Epoch memory);
    function isConsumed(bytes32 messageId) external view returns (bool); // debit already matched to a credit
}

interface IQuarantineController {
    event LanesFrozen(bytes32 indexed tokenId, bytes32 indexed incidentId);
    event Tainted(bytes32 indexed tokenId, address indexed account, bytes32 indexed incidentId);
    event IncidentResolved(bytes32 indexed tokenId, bytes32 indexed incidentId, uint64 recoveryEndsAt);

    function isFrozen(bytes32 tokenId) external view returns (bool);
    function isTainted(bytes32 tokenId, address account) external view returns (bool);
    function resolve(bytes32 tokenId, bytes32 incidentId) external; // issuer Safe only
}

interface IKirchhoffGuard {
    function check(address from, address to, uint256 amount) external view; // reverts if from is tainted
}
```

### Report types accepted by `ConservationLedger.onReport`

| Type | Sent by | Effect | Contract-enforced rules |
| --- | --- | --- | --- |
| `EPOCH` | W2 | Records Δ and status CONSERVED or DRIFT | Ignored if the token is BROKEN, QUARANTINED or RECOVERING; epochId must increase |
| `BREACH` | W1 or W2 | Sets BROKEN, stores evidence, calls QuarantineController | Allowed from any status except UNKNOWN-without-spec |
| `QUARANTINE_APPLIED` | W3 | Sets QUARANTINED, records tainted addresses | Only after BROKEN |
| `RECOVERY_CHECK` | W2 | Sets CONSERVED | Only if RECOVERING, timelock ended, and Δ is zero or more |

Every report carries `chainSelector` and the ledger's own address. The contract rejects any report built for another chain or another ledger (replay protection). A CRE report alone can never clear BROKEN; only the issuer Safe can start recovery.

### Demo contracts (testnet only, clearly labeled)

| Contract | Chain | Behavior |
| --- | --- | --- |
| `kETH` (canonical ERC-20) | Ethereum Sepolia | 18 decimals, calls `KirchhoffGuard.check` in `_update` |
| `RemoteKETH` (burn-mint ERC-20) | Arbitrum Sepolia, Base Sepolia | Minters: CCIP pool and WeakBridge adapter |
| `HomeEscrowAdapter` | Ethereum Sepolia | Locks kETH for WeakBridge sends; releases on WeakBridge credits |
| `WeakBridge` | All three | Mimics a 1-of-1 verifier setup: one ECDSA key authorizes credits. `Burned` and `Released` events match the spec |
| `DemoLendingMarket` | Ethereum Sepolia | Accepts kETH collateral, reads `ConservationFeed`, `borrow()` reverts with `CollateralBroken()` when status is BROKEN or worse |

**Honesty label for the demo:** we simulate the forgery by signing a WeakBridge message with its single verifier key, with no matching burn. This reproduces the effect of the Kelp forgery (a credit with no debit) without claiming to reproduce LayerZero's exact bug.

### Contract test requirements

- Unit tests for every report type and every illegal status transition.
- Fuzz tests: random sequences of debits, credits and forged credits; the Junction and Loop Rules must flag every forged credit and never flag a valid sequence.
- Invariant test (Foundry): "status never goes from BROKEN to CONSERVED without passing RECOVERING."
- Fork-free: all tests run on a local Anvil with a mock `KeystoneForwarder`.

## 8. CRE workflows (the Conservation Engine)

**Four TypeScript CRE workflows do all of the computing. They read every chain with DON consensus through the EVM client (`callContract` at pinned blocks, `filterLogs`, `getTransactionReceipt`, `headerByNumber`) and write signed reports through `writeReport` to the `KeystoneForwarder`.**

CRE makes the trigger first-class: Cron and EVM Log triggers map directly onto what we need. ([Chainlink docs](https://docs.chain.link/cre/reference/cla-migration-ts)) Reports reach our contracts through the forwarder calling `onReport(metadata, report)`. ([Chainlink docs](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts))

### W1 Junction Watch (catches forged credits)

- **Triggers:** EVM Log triggers on every credit event in the spec (`Released`, `Minted`, CCIP pool release and mint events), one trigger per chain.
- **Steps:**
  1. Decode the credit: message id, claimed source chain, amount, recipient, tx hash.
  2. `headerByNumber` on the claimed source chain at the spec's confidence to get the safe search ceiling.
  3. `filterLogs` on the source chain for the matching debit event, filtered by message id topic, inside `search_window_blocks`.
  4. Check the consumed-debit set (read from `ConservationLedger.isConsumed(messageId)`) to stop double credits.
  5. Run `engine.junction(credit, debitOrNull, sourceHead)`.
  6. Result OK: write a `SETTLED` marker (batched into the next EPOCH report). Result BROKEN: write a `BREACH` report to the ledger on every chain in the spec, in this same run.
- **Latency goal:** the BREACH report lands in the same workflow run as the forged credit.

### W2 Loop Ledger (global conservation, every epoch)

- **Triggers:** Cron every 30 seconds, plus EVM Log triggers on any supply-changing event for an immediate recompute.
- **Steps:**
  1. For each chain, pick a pinned block at the configured confidence with `headerByNumber`.
  2. One `callContract` per chain into Multicall3 at the pinned block: escrow balance, remote `totalSupply`, ledger state.
  3. Read in-flight debits and credits since the last epoch with `filterLogs` and match them by message id.
  4. Optional: read the PoR feed for backed tokens.
  5. Run `engine.loop(snapshot)` to get Δ, status and reason.
  6. Write one `EPOCH` report (or `BREACH`) to the ledger on every chain, carrying `blocksHash` of the pinned blocks.
- **Determinism:** every node pins the same blocks because they come from consensus header reads, so every node computes the same Δ.

### W3 Responder (containment)

- **Trigger:** EVM Log trigger on `BreachRecorded` on the home chain.
- **Steps:** build the incident id; write `QUARANTINE_APPLIED` to every chain with the tainted recipient list; send one notification per channel through the HTTP capability with an idempotency key equal to the incident id, so retries never double-page.
- **Secrets:** webhook URLs and tokens come from CRE secrets, never from config files.

### W4 Topology Watch (spec drift)

- **Triggers:** EVM Log trigger on `SpecActivated`, plus Cron every 10 minutes.
- **Steps:** reload active specs; scan configured chains for new minters, pools or peers of the protected token (role-granted and peer-set events); if a new minter is not in the spec, raise DRIFT with reason `SPEC_MISMATCH` and notify the issuer. A minter outside the spec is exactly how a hidden mint path appears.

### Repository layout

```
kirchhoff/
  contracts/        Foundry: production and demo contracts, tests, deploy scripts
  engine/           @kirchhoff/engine: pure TS rules, shared by workflows, Judge, backtester
  workflows/
    w1-junction/    CRE workflow + config.staging.json + config.production.json
    w2-loop/
    w3-responder/
    w4-topology/
  judge/            Policy hook service (POST /v1/evaluate)
  ccv/              Helm values for ccv-cell, one file per cell
  indexer/          Event indexer to Postgres (UI read model only)
  api/              REST + WebSocket
  ai/               Spec Copilot, Incident Narrator, Topology Scout
  mcp/              MCP server
  web/              Next.js Mission Control
  demo/             deploy-all, seed, attack-kelp-replay, reset scripts
```

### Commands the team will run

- `cre workflow simulate w2-loop --target staging` for local simulation against public testnets.
- `cre workflow deploy` once CRE deploy access is confirmed with Chainlink mentors on day 1. If live deploy is not available in time, demo with simulation and say so on the slide; ETHGlobal-style Chainlink tracks have accepted simulation with the team deploying for builders. ([ETHGlobal](https://ethglobal.com/events/cannes2026/prizes/chainlink))

### Workflow config (generated by the spec compiler)

Each workflow's config JSON is generated from the active KIRCH-SPEC by `engine/compile.ts`: chain selectors, contract addresses, event topics, confidence levels, windows and thresholds. Nobody edits workflow config by hand.

## 9. CCIP 2.0 CCV integration

**KIRCHHOFF runs as a real CCV built from Chainlink's CCV Starter Kit. Our only custom code inside the cell is the Judge, the policy hook the verifier calls before it signs.**

### How a CCV cell works (from Chainlink's docs)

- A cell is one verifier plus one aggregator, backed by Postgres, deployed with a Helm chart into Kubernetes. ([CCV Starter Kit](https://docs.chain.link/ccip/ccv-starter-kit))
- The verifier polls source chains and signs message hashes; the aggregator serves attestations over gRPC; the CCIP indexer reads them; the executor runs the message on the destination. ([CCV Starter Kit](https://docs.chain.link/ccip/ccv-starter-kit))
- The smallest production committee is four cells with a threshold of three, each in its own failure domain with its own Postgres, secrets and keys. ([CCV Starter Kit](https://docs.chain.link/ccip/ccv-starter-kit))
- The verifier POSTs each message to `<base_url>/v1/evaluate` and expects `{"decision":"PASS"}` or `{"decision":"FAIL"}` with an optional reason. Requests are signed with HMAC-SHA256. ([Policy hook guide](https://docs.chain.link/ccip/ccv-starter-kit/how-to/add-a-custom-policy-hook))
- A FAIL withholds that one node's signature. To hold a message during a review, return FAIL and replay it once the review clears. ([Policy hook guide](https://docs.chain.link/ccip/ccv-starter-kit/how-to/add-a-custom-policy-hook))
- Recent contract updates added fee token, fee amount, source block timestamp and a Finality object to the hook request. ([chainlink-ccv PR #1437](https://github.com/smartcontractkit/chainlink-ccv/pull/1437))

Because one FAIL only withholds one signature, **every cell runs the identical Judge**. Identical logic over consensus-written onchain state means the whole committee reaches the same verdict, and a FAIL from the committee blocks the message.

### The Judge: `POST /v1/evaluate`

1. Verify the HMAC-SHA256 signature. Bad signature: HTTP 401.
2. Parse the message: source and destination chain selectors, message id, token transfers, sender, receiver, finality, source block timestamp.
3. Map each transferred token address to a `tokenId` through the local spec cache. The cache syncs from `KirchhoffRegistry` every 60s; if the cached spec hash differs from the active onchain hash, return FAIL `SPEC_MISMATCH`.
4. No protected token in the message: PASS (data-only messages are out of scope; configurable per issuer).
5. Read `statusOf(tokenId)` from the ledgers on both source and destination chains through two independent RPC providers. Providers disagree or error: FAIL `PENDING_ATTESTATION`.
6. Status BROKEN, QUARANTINED or RECOVERING: FAIL with that reason. Stale: apply the spec's `on_stale` (fail-closed by default).
7. `isFrozen(tokenId)` true, or `isTainted(tokenId, sender)` true: FAIL `TOKEN_QUARANTINED`.
8. Confirm the source pool debit for this message id (via `eth_getLogs` filtered on the message id topic) and check the amount equals the transfer amount. Missing or different: FAIL with `PENDING_ATTESTATION` or `AMOUNT_MISMATCH`.
9. All checks pass: return PASS with reason `OK`.

**Judge rules:** stateless except the spec cache; 2s total time budget; every FAIL logs the reason code, message id and evidence; the reason string returned to the verifier is the reason code plus a short note. The policy hook outcomes show up on the cell's `verifier_message_transitions_total` metric with `stage="policy"`. ([Logging docs](https://docs.chain.link/ccip/ccv-starter-kit/logging-and-monitoring))

### Judge response examples

```json
{ "decision": "PASS", "reason": "OK kETH CONSERVED delta=0 epoch=4182" }
{ "decision": "FAIL", "reason": "TOKEN_BROKEN kETH DEBIT_NOT_FOUND incident=0x9f3c..." }
{ "decision": "FAIL", "reason": "PENDING_ATTESTATION source debit not yet visible, replay" }
```

### Hackathon deployment plan for the CCV

| Step | What | Owner |
| --- | --- | --- |
| 1 | Hour 0: ask Chainlink mentors for the exact testnet steps to make kETH require our CCV on its lanes, and to onboard our aggregator to the CCIP indexer | CCV lead |
| 2 | Deploy the on-chain contracts kit on 3 testnets | CCV lead |
| 3 | One k3s cluster on a single cloud VM; Postgres in-cluster; testnet keys in Kubernetes secrets (testnet-only shortcut, labeled on the slide) | Infra |
| 4 | Deploy 1 cell, wire the Judge, run the Starter Kit's "test your setup" transfer | CCV lead |
| 5 | Scale to 4 cells with threshold 3 if time allows, for the "committee" slide | Infra |

### Fallback paths (decide by hour 10)

- **Fallback B, KirchhoffTokenPool.** Our own CCIP token pools for kETH (Cross-Chain Token standard) check `ConservationLedger` and `QuarantineController` inside `releaseOrMint` and `lockOrBurn`, and revert when the token is BROKEN or the sender is tainted. This enforces the same rule at execution time on standard CCIP testnet lanes.
- **Fallback C, Judge replay.** Feed real CCIP message payloads (captured with ccip-cli) into the Judge on stage and show its verdicts, while Fallback B enforces live. Labeled clearly on the slide.

We build Fallback B regardless, from hour 4. It is cheap, and it guarantees a live refusal in the demo.

## 10. Multi-bridge supply indexing and adapters

**KIRCHHOFF only works if it sees every path that can create the token. Each bridge family gets an adapter that turns its events into the engine's two shapes: Debit and Credit.**

### Adapter contract (TypeScript, in `@kirchhoff/engine/adapters`)

```ts
export interface BridgeAdapter {
  id: string;                                   // "ccip_v2", "layerzero_oft", "weakbridge"
  debitTopics(spec: TokenSpec, chain: ChainSel): Hex[];
  creditTopics(spec: TokenSpec, chain: ChainSel): Hex[];
  decodeDebit(log: Log, chain: ChainSel): Debit | null;
  decodeCredit(log: Log, chain: ChainSel): Credit | null;
  messageIdTopicIndex: 1 | 2 | 3;               // which indexed topic carries the id, for filterLogs
  maxDeliverySeconds: number;                   // used to size the match window
}

export type Debit  = { messageId: Hex; srcChain: ChainSel; dstChain: ChainSel; amount: bigint; recipient?: Hex; txHash: Hex; block: bigint };
export type Credit = { messageId: Hex; claimedSrcChain: ChainSel; dstChain: ChainSel; amount: bigint; recipient?: Hex; txHash: Hex; block: bigint };
```

All amounts are normalized to canonical base units using per-chain `decimals` from the spec, so 6-decimal and 18-decimal deployments of one token compare correctly.

### Adapters by phase

| Adapter | Debit / credit source | Phase | Notes |
| --- | --- | --- | --- |
| `weakbridge` | `Burned` / `Released` (our demo contract) | Hackathon | The attack path in the Kelp Replay |
| `ccip_v2` | CCIP token pool lock/burn and release/mint events, keyed by CCIP message id | Hackathon | Exact event names taken from the pool contracts the team deploys |
| `layerzero_oft` | OFT send and receive events keyed by LayerZero GUID | Stretch at hackathon, required for v1 | Match on the received amount, since OFT strips decimal dust on send; confirm event signatures against the deployed OFT version |
| `wormhole_ntt` | NTT manager send and redeem events | v1 | Event names verified at integration time |
| `op_standard_bridge`, `arbitrum_gateway` | Native rollup bridge deposit and finalize events | v1 | Long delivery windows (7-day withdrawals) handled through `maxDeliverySeconds` |
| `issuer_mint` | Issuer `Mint` / `Burn` with no bridge | v1 | Feeds I\_net for burn-and-mint tokens |

### Supply rules the adapters must respect

- **Rebasing tokens:** compare shares, not balances (spec flag `unit: shares`).
- **Fee-on-transfer tokens:** credits are matched on the amount actually received, recorded by the bridge's own event.
- **Escrow donations:** anyone can send tokens to the escrow. This only raises Δ (surplus), never triggers a breach, and is shown in the UI as "unclaimed surplus".
- **Unknown minters:** W4 Topology Watch flags any minter role grant not listed in the spec. Unlisted mint paths are the most dangerous blind spot.

### UI read model (not in the veto path)

The indexer writes every debit, credit, epoch, verdict and incident into Postgres for the UI and API. Tables: `tokens`, `chains`, `debits`, `credits`, `matches`, `epochs`, `verdicts`, `incidents`, `taints`, `specs`. The UI never reads verdicts from anywhere except this mirror of onchain state, and every row links to its explorer transaction.

## 11. AI layer

**AI makes KIRCHHOFF fast to adopt and fast to understand. It never decides a verdict. Every AI output is a draft or an explanation with cited evidence, and a human or deterministic code acts on it.**

### AI principles (non-negotiable)

1. **No AI in the veto path.** The Judge, the engine and the contracts contain no model calls.
2. **Provenance on every claim.** Every address, event or number the AI writes must come from a tool result. Lines without provenance render red and cannot be approved.
3. **Untrusted inputs stay untrusted.** Contract names, verified-source comments and explorer metadata are data, never instructions. Tool results cannot change the system prompt or call write tools.
4. **No write powers.** AI services cannot sign transactions, propose specs onchain, or change status. They produce drafts.
5. **Structured outputs.** Spec drafts and incident reports use JSON Schema outputs; prose is generated only from validated structures.

Model: Claude through the Anthropic API, model name set by environment variable, temperature 0 for Spec Copilot and Narrator.

### Feature 1: Spec Copilot (onboarding)

**Job:** turn "rsETH, home on Ethereum, on Arbitrum and Base, bridged with CCIP and LayerZero" into a correct, backtested KIRCH-SPEC in minutes instead of days.

| Tool the model can call | Returns |
| --- | --- |
| `get_contract(chain, address)` | Bytecode hash, ABI (from Blockscout or Etherscan-family APIs), proxy implementation |
| `list_role_grants(chain, token)` | Every `RoleGranted` / minter change event, so hidden minters surface |
| `list_ccip_pools(chain, token)` | Pool addresses from the CCIP token admin registry |
| `list_oft_peers(chain, oft)` | Peer endpoints set on a LayerZero OFT |
| `sample_events(chain, address, topic, n)` | Recent decoded events, to confirm debit and credit signatures |
| `validate_spec(yaml)` | Schema and semantic errors |
| `backtest_spec(yaml, from_block)` | Runs the engine on history; returns breaches, drift events, coverage |

**Flow:** the user types a description and canonical address; the Copilot calls tools; it drafts YAML; validation and backtest run automatically; the UI shows the YAML with a provenance chip on every line and a plain-English "why" beside each minter; the issuer edits and approves; the approval opens a Safe transaction to propose the spec hash.

### Feature 2: Incident Narrator

**Job:** the on-call engineer understands the breach in 30 seconds.

- Input: a structured evidence bundle built deterministically by W3 and the API: offending credit tx, every chain and block range searched for the missing debit, Δ before and after, actions applied, held messages.
- Output: a 120-word summary, a timeline, the blast radius per chain, and next steps chosen only from a fixed playbook list ("rotate bridge verifier key", "contact DEX for pool pause", "prepare holder communication").
- Every sentence carries evidence ids that link to explorer transactions. The panel is labeled "AI summary. Verify against evidence."
- Posted to Slack and Telegram with the incident link.

### Feature 3: Topology Scout

**Job:** find supply paths the issuer forgot. It crawls explorers for same-name and same-symbol deployments, bridged variants, new OFT peers and new chains, then files proposals in the Onboarding screen. W4 (deterministic) watches known chains; the Scout looks for unknown ones.

### Feature 4: Ask KIRCHHOFF

A chat panel in Mission Control answering questions over the read model with a read-only SQL tool and the evidence store: "Why did message 0x7a... fail?", "What was Δ on Base at 14:00?", "Which lanes are frozen right now?" Answers cite rows and transactions.

### Feature 5: Agent access (MCP)

AI agents increasingly move money across chains on their own. Chainlink's leadership described agents at Sibos 2026 as the most impatient customers in finance, taking whatever path is fastest. ([Chainlink Sibos 2026 recap](https://chain.link/blog/sibos-2026-recap)) KIRCHHOFF gives them a safety check before every cross-chain move through an MCP server (section 13).

### AI evaluation

| Eval | Hackathon bar | v1 bar |
| --- | --- | --- |
| Spec Copilot provenance coverage | 100% of addresses on the demo token | 100% on every onboarded token |
| Spec Copilot field accuracy vs hand-written golden specs | Demo token exact | 95% on a 20-token golden set |
| Narrator citation coverage | Every sentence cites evidence | Same, plus human rating 4/5 or better on 20 replayed incidents |
| Prompt-injection suite (malicious contract names and comments) | 10 cases, 0 tool misuse | 100 cases, 0 tool misuse |

## 12. Frontend UI/UX

**The product looks like an electrical control room: chains are nodes in a live circuit, bridges are wires, and money is current. When the current stops adding up, the circuit turns red and the judge sees it without reading a word.**

### Design direction

- **Metaphor:** a circuit diagram, not a dashboard. The Kirchhoff name gives us the visual system for free.
- **Dark-first** (control-room feel, best on stage projectors), full light theme supported.
- **Calm by default, loud only on breach.** 95% of the time the screen is quiet teal. A breach is the only moment with red, motion and sound.
- **Every number is verifiable.** Each figure has an explorer link or an onchain read behind it, one click away.

### Design tokens

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `bg/base` | #0B0D10 | #FAFAF9 | App background |
| `bg/panel` | #12151A | #FFFFFF | Panels, cards |
| `line/wire` | #2A313B | #D6D9DE | Idle bridge wires, borders |
| `status/conserved` | #2DD4BF | #0F766E | CONSERVED, PASS |
| `status/drift` | #FBBF24 | #B45309 | DRIFT, soft warnings |
| `status/broken` | #F43F5E | #BE123C | BROKEN, FAIL |
| `status/quarantined` | #A78BFA | #6D28D9 | QUARANTINED, tainted |
| `status/recovering` | #60A5FA | #1D4ED8 | RECOVERING |
| `status/unknown` | #6B7280 | #6B7280 | UNKNOWN, stale |

- **Type:** Inter for UI (14px base, 1.5 line height); JetBrains Mono for numbers, hashes and code, with tabular figures so counters never jitter.
- **Scale:** 12 / 14 / 16 / 20 / 28 / 48 / 72. The Δ readout is 72px.
- **Spacing:** 4px grid; panels 16px padding; 8px corner radius; 1px borders.
- **Icons:** Lucide. Status always shows color plus icon plus word, never color alone.
- **Components:** shadcn/ui on Tailwind; Monaco editor for YAML; Recharts or visx for charts; React Flow for the circuit map; Framer Motion for motion.

### Motion rules

- Wire pulses: a 6px dot travels source to destination in 600ms for every settled transfer.
- Breach: the offending wire turns `status/broken`, the Δ readout counts down to the deficit over 800ms, the app frame gains a 2px red border, and the browser tab title becomes "BROKEN · kETH".
- Quarantine: frozen lanes show a violet lock glyph and the wire turns dashed.
- `prefers-reduced-motion`: no pulses, no counting; instant state changes.

### Screens

| Route | Screen | Purpose | Must-have elements |
| --- | --- | --- | --- |
| `/t/[token]` | Public Status Page | Holder trust | Big status badge, Δ, per-chain supply table, last epoch age, "verify onchain" links, embeddable SVG badge |
| `/app/tokens/[token]` | Mission Control | Live operations, the demo hero | Circuit Map, Conservation Meter, Verdict Stream, Ledger table, Δ history chart |
| `/app/incidents/[id]` | Incident Room | On-call | Evidence timeline, blast radius, AI narrative with citations, actions, held messages, Resolve via Safe, postmortem export |
| `/app/onboard` | Onboarding Wizard | Issuer adoption | 6 steps: describe, Copilot discovery, review spec, backtest, propose, timelock |
| `/app/ops` | Verifier Ops | CCV operators | Cell health, Judge latency p50/p99, PASS/FAIL counts, RPC agreement, CRE run history |
| `/app/integrate` | Integrations | Risk stewards, agents | Feed addresses, Solidity snippet, API keys, MCP config |
| `/lab` | Attack Lab | Demo only, labeled "Testnet simulation" | "Run Kelp Replay" button, step tracker, attacker console beside Mission Control |

### Mission Control layout (1440px and up)

- **Top bar:** token switcher, environment badge (TESTNET), status pill ("CONSERVED · Δ 0 kETH"), epoch number, staleness timer, Ask KIRCHHOFF (Cmd+K).
- **Left two-thirds: Circuit Map.** Escrow node in the center, one node per chain around it with live supply, one wire per bridge per lane. Hover a wire: last 10 transfers. Click a node: that chain's ledger drawer.
- **Right third, top: Conservation Meter.** Two horizontal bars, Backing and Claims, on the same scale. Δ in 72px below. Green when the bars balance; the Claims bar overflows in red on breach.
- **Right third, bottom: Verdict Stream.** Virtualized list, newest first: time, lane, amount, PASS or FAIL, reason code, message id link.
- **Bottom band: Ledger table and Δ history.** Per chain: supply, escrow, in flight, last pinned block. Δ chart over the last 24h with incident markers.

&#91;embedded content: Mission Control wireframe · breach state\]

The hero frame of the demo: the forged WeakBridge wire is red, the Claims bar overflows Backing, and the refused CCIP transfer sits at the top of the Verdict Stream. Values in the ledger band are placeholders for the build.

### Incident Room layout

1. Header: severity, Δ, time from offending block to BROKEN onchain, incident id.
2. Left column: vertical evidence timeline (offending credit, debit search per chain with block ranges, BREACH report tx per chain, quarantine tx per chain, refused CCIP messages).
3. Right column: AI narrative card with citation chips; Actions card listing applied containment with checkmarks; Held messages count with "Replay after recovery" (disabled until CONSERVED).
4. Footer: "Resolve incident" opens a Safe transaction; "Export postmortem" downloads Markdown and PDF.

### States every screen must design

| State | Treatment |
| --- | --- |
| Loading | Skeletons sized like the final content; never a spinner on the Δ readout |
| Empty | One sentence plus one action ("No protected tokens yet. Onboard your first token.") |
| Stale | Panels dim to 60%, banner "Last epoch 2m 14s ago. Verdicts follow the token's stale policy." |
| RPC or API error | Inline banner naming the failing chain; the rest stays live |
| Breach | Red frame, toast with the one-line cause, Incident Room deep link, optional alert sound (off by default) |

### Accessibility

- WCAG 2.2 AA contrast in both themes; full keyboard navigation; visible focus rings.
- Verdict Stream is an ARIA live region (polite); breach announcements are assertive.
- Every chart has a data table toggle.

### Stage mode

`?stage=1` locks the layout to 1920x1080, scales type by 120%, enlarges the cursor, hides dev controls, and slows motion by 1.3x so the screen recording reads clearly on the TOKEN2049 screens.

### Microcopy

- Breach toast: "Forged credit on Ethereum Sepolia: 116,500 kETH released with no matching burn. CCIP lanes frozen."
- FAIL row: "Refused · TOKEN\_BROKEN · attacker transfer to Base Sepolia"
- Status page hero: "kETH adds up across 3 chains. Last checked 12 seconds ago."

## 13. Public API, SDK, MCP server

**Three ways to consume KIRCHHOFF: onchain (the feed, trustless), HTTP (fast, for apps), and MCP (for AI agents). The onchain feed is the source of truth; the others mirror it.**

### Onchain integration for lending markets and vaults

```solidity
interface AggregatorV3Interface {
    function latestRoundData() external view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

abstract contract KirchhoffProtected {
    AggregatorV3Interface public immutable kirchhoffFeed; // ConservationFeed for this collateral
    uint256 public constant MAX_AGE = 300;                 // seconds

    error CollateralNotConserved(int256 status);
    error CollateralStatusStale(uint256 age);

    constructor(address feed) { kirchhoffFeed = AggregatorV3Interface(feed); }

    function _requireConserved() internal view {
        (, int256 s,, uint256 updatedAt,) = kirchhoffFeed.latestRoundData();
        if (block.timestamp - updatedAt > MAX_AGE) revert CollateralStatusStale(block.timestamp - updatedAt);
        if (s != 1 && s != 2) revert CollateralNotConserved(s); // 1 CONSERVED, 2 DRIFT
    }
}
```

### REST API (`https://api.kirchhoff.xyz/v1`, placeholder domain)

| Method | Path | Auth | Returns |
| --- | --- | --- | --- |
| GET | `/tokens` | Public | Protected tokens with status |
| GET | `/tokens/{token}/status` | Public | Status, Δ, epoch, per-chain supply, pinned blocks, ledger addresses |
| GET | `/tokens/{token}/epochs?limit&cursor` | Public | Epoch history for charts |
| GET | `/tokens/{token}/verdicts?cursor` | Public | Judge verdicts with reason codes |
| GET | `/incidents/{id}` | Public | Incident, evidence bundle, AI narrative |
| POST | `/check-transfer` | Public, rate-limited | Dry run: `{token, srcChain, dstChain, amount, sender}` to `{wouldPass, reason}` using current onchain status |
| POST | `/specs/draft` | Issuer key | Spec Copilot run (streams tool trace over SSE) |
| POST | `/specs/backtest` | Issuer key | Backtest result |
| WS | `/stream?token=` | Public | Channels: `status`, `epoch`, `verdict`, `incident` |

All responses include `source: "onchain-mirror"`, the ledger address and the block the value was read at, so any client can verify it.

### MCP server (`@kirchhoff/mcp`)

Transports: stdio and Streamable HTTP. All tools are read-only.

| Tool | Input | Output |
| --- | --- | --- |
| `kirchhoff_status` | `token` | Status, Δ, age, per-chain summary |
| `kirchhoff_check_transfer` | `token, src_chain, dst_chain, amount, sender` | `would_pass`, reason code, advice line |
| `kirchhoff_explain_verdict` | `message_id` | Verdict, reason, evidence links |
| `kirchhoff_incident` | `incident_id` | Narrative plus evidence |
| `kirchhoff_list_tokens` | none | Protected tokens |

The tool descriptions tell agents to call `kirchhoff_check_transfer` before any cross-chain move of a protected token and to stop if `would_pass` is false.

### TypeScript SDK (`@kirchhoff/sdk`)

```ts
import { Kirchhoff } from "@kirchhoff/sdk";
const k = new Kirchhoff({ network: "testnet" });
const s = await k.status("kETH");              // { status: "CONSERVED", delta: 0n, ... }
k.subscribe("kETH", (e) => console.log(e));     // live epochs, verdicts, incidents
const ok = await k.verifyOnchain("kETH", "ethereum-testnet-sepolia"); // reads the ledger directly via viem
```

## 14. Security model and threat model

**KIRCHHOFF catches every attack that creates value from nothing, on any bridge. It cannot undo the first fraudulent release on a bridge it does not sit on; it contains it within one CRE run.**

### Threats and responses

| # | Threat | Detected by | Response | Residual risk |
| --- | --- | --- | --- | --- |
| 1 | Forged message on a non-CCIP bridge (the Kelp pattern) | Junction Rule, W1 | BROKEN, lanes frozen, recipient tainted, feed flips | The first release on that bridge already happened; Guard-enabled tokens also block onward transfers |
| 2 | Forged or buggy CCIP message | Judge checks the source debit independently of the Committee Verifier | FAIL, message never executes | Needs both our committee and the Chainlink committee to fail |
| 3 | Compromised mint key minting with no message | Loop Rule (W2) and unlisted-minter alert (W4) | BROKEN within one epoch | Exposure equals what moves before the next epoch (30s cron plus event trigger) |
| 4 | Replay or double credit of a real debit | Junction Rule consumed set | BROKEN, `DOUBLE_CREDIT` | None known |
| 5 | Lying or eclipsed RPC | DON consensus in CRE; two independent providers per Judge | Disagreement means FAIL `PENDING_ATTESTATION` | Liveness delay, not loss |
| 6 | Chain reorg after a verdict | Finalized confidence by default | Faster confidence only by explicit spec override | Documented per chain |
| 7 | Spec poisoning (attacker loosens rules first) | Issuer Safe plus 48h timelock; UI diff alert on every proposal | Holders and stewards see the pending change | Issuer Safe compromise |
| 8 | Report replay across chains or ledgers | `chainSelector` and ledger address inside every report | Contract rejects | None known |
| 9 | KIRCHHOFF operator compromised | Cannot sign alone: CRE reports are DON-signed; CCV needs 3 of 4 independent cells | Worst case denial of service | Cells must run in separate organizations in production |
| 10 | Malicious AI suggestion | Provenance requirement, no write tools | Draft blocked | Human approval still required |
| 11 | Prompt injection through contract metadata | Untrusted-input policy, injection test suite | Tool misuse blocked | Covered by the eval suite |

### Failure modes

| Failure | Behavior | Why |
| --- | --- | --- |
| Judge unreachable | Verifier gets no verdict, message fails, replay later | Fail-closed protects value; delay is recoverable, loss is not |
| CRE workflow stops | Status goes stale after `staleness_seconds`; spec's `on_stale` applies | Issuer chooses safety or liveness explicitly |
| Indexer or UI down | No effect on verdicts | Control plane is outside the veto path |
| Adapter bug causes a false BROKEN | Token frozen until issuer recovery | Prevented by mandatory backtest and fuzzing; recovery path documented |

### What KIRCHHOFF does not protect against

- Theft of real assets that keeps supply conserved, for example a social-engineered admin draining a protocol's own vault (the Drift pattern).
- DEX price manipulation, phishing, or bugs in lending logic.
- Swaps an attacker makes in the same block as the forged release, unless the token uses KirchhoffGuard.

We say this on the slide. Judges trust a team that names its limits.

## 15. Demo script and stage deck

**The Top 5 present with a screen recording embedded in .ppt or .keynote slides; live demos are not allowed on stage and decks lock at the deadline (11:59pm, October 7). So the recording is the product on stage.**

Judging weights we design against: Functionality 30%, Technical implementation 25%, Innovation 20%, Usefulness 15%, Demo 10% (from the Origins brief).

### Recorded demo, 2 minutes 30 seconds (stage mode, 1920x1080)

| Time | Screen | What happens | Voiceover line |
| --- | --- | --- | --- |
| 0:00 | Black slide, then headline numbers | Kelp: one forged message, $292M, holders on 20 chains | "In April, one forged message created $292M from nothing." |
| 0:15 | Mission Control, idle | 3 chains, kETH CONSERVED, a normal CCIP transfer pulses through and shows PASS | "This is kETH on three chains. Every transfer is checked by our verifier inside CCIP 2.0." |
| 0:35 | Attack Lab beside Mission Control | Forge a WeakBridge message; 116,500 kETH released on Ethereum Sepolia; explorer tx shown | "Here is the Kelp attack, on a bridge with a single verifier." |
| 1:05 | Mission Control | Wire turns red, Δ counts to minus 116,500, BREACH report txs appear on all 3 chains | "In the same CRE run, Kirchhoff finds a credit with no debit." |
| 1:25 | Attacker console plus CCIP explorer | Attacker sends the stolen kETH to Base through CCIP; every cell's Judge returns FAIL TOKEN\_BROKEN; the message never executes | "The attacker tries to spread it. Our verifier refuses to sign." (the holy-shit moment) |
| 1:50 | Attacker console plus lending market | Home-chain transfer reverts (Guard); `borrow()` reverts `CollateralBroken()` | "He cannot move it, and nobody will lend against it." |
| 2:05 | Incident Room | AI narrative with citations, containment checklist | "On-call gets the whole story in one screen." |
| 2:20 | Title slide | Tagline | "Every bridge checks who signed. Kirchhoff checks if the money adds up." |

### Deck (8 slides, .pptx, video embedded on slide 4, no external links for video)

1. **KIRCHHOFF.** "Every bridge checks who signed. We check if the money adds up."
2. **The problem.** Kelp $292M, 20 chains hit; $340M+ in 2026 bridge losses. One sentence each.
3. **The insight.** Two rules: Junction (every credit has a debit) and Loop (backing covers all claims). One diagram.
4. **Demo.** Embedded 2:30 video.
5. **How it works.** Architecture diagram: CRE Conservation Engine, CCV cells with the Judge, onchain ledger and feed.
6. **Why Chainlink.** Built on CCIP 2.0 CCVs (launched Sept 28); CRE DON consensus reads across chains; we sit beside the Committee Verifier, never replace it.
7. **Business.** CCV marketplace fees per message; issuer subscriptions; feed for lending markets. First customers: multi-chain LRT, LST, wrapped BTC issuers.
8. **Limits and roadmap.** What we do not protect against, next 90 days, team, ask.

### Submission checklist

- [ ] Public GitHub repo with README, architecture diagram, deployed addresses per chain, CRE workflow ids, and "how to reproduce the Kelp Replay".
- [ ] Live URL: public Mission Control in read-only mode with a "Replay last incident" timeline.
- [ ] Deck uploaded to Google Drive as .pptx with the video embedded in the file.
- [ ] Main track submission plus Chainlink track submission, with a paragraph on exactly how CRE and CCIP are used.
- [ ] Submitted before 11:59pm on October 7.

### Recording checklist

- [ ] `demo/reset.ts` restores all three chains to a clean, conserved state in under 3 minutes.
- [ ] Record at least three full takes; keep the best one unedited apart from trimming.
- [ ] Explorer tabs pre-opened for each transaction; clock and timestamps visible.
- [ ] A second machine records a backup take in parallel.

## 16. 36-hour build plan

**Origins requires every line of project code to be written inside the 36 hours. Before the start we only prepare: this PRD, accounts, keys, testnet funds and reading. The plan below is in hours from the official start.**

### Before the start (allowed prep, no project code)

- [ ] CRE account and CLI login working; confirm Confidential features are not needed (they are not).
- [ ] Testnet ETH and LINK on Ethereum Sepolia, Arbitrum Sepolia, Base Sepolia for 3 deployer wallets.
- [ ] Two independent RPC providers per chain (Judge needs two).
- [ ] One cloud VM (8 vCPU, 32 GB) for k3s and the CCV cell; Vercel project; Postgres instance.
- [ ] Anthropic API key; Blockscout or Etherscan-family API keys.
- [ ] Everyone has read sections 4 to 9 of this PRD and the CCV Starter Kit docs.

### Team split (8 builders plus a lead; merge roles if the team is smaller)

| Role | Owns | Hackathon deliverables |
| --- | --- | --- |
| Lead / PM (Yathu) | Scope, mentor asks, deck, voiceover | Hour 0 mentor answers, cut decisions, final video and deck |
| Contracts lead | Ledger, Quarantine, Feed, Registry | Deployed and verified on 3 testnets by hour 8 |
| Contracts 2 | Demo contracts, Guard, TokenPool fallback, deploy and reset scripts | `demo/deploy-all`, `demo/attack`, `demo/reset` |
| CRE lead | W1, W2 | Both simulating green against testnets by hour 14 |
| Engine | `@kirchhoff/engine`, backtester, W3, W4 | Engine at 100% branch coverage by hour 10 |
| CCV / infra | Cell, Judge, k3s, RPCs | Judge PASS/FAIL live in a cell by hour 20, or Fallback B by hour 16 |
| Frontend lead | Mission Control, Attack Lab, stage mode | Hero screen on live data by hour 20 |
| Frontend 2 / design | Incident Room, Status Page, Onboarding, design system | All screens with real states by hour 26 |
| AI + API | Indexer, API, WebSocket, Copilot, Narrator, MCP | Indexer by hour 8; Copilot and Narrator by hour 26 |

### Hard gates

1. **Hour 4: ABI freeze.** Contract interfaces from section 7 are frozen; frontend and workflows code against them.
2. **Hour 10: CCV path decision.** If testnet CCV registration is not confirmed, Fallback B becomes the primary enforcement path for the demo.
3. **Hour 22: first full Kelp Replay** end to end on testnets.
4. **Hour 28: code freeze.** Bugs only after this point.
5. **Hour 35: submitted.** One hour of buffer before the deadline.

&#91;embedded content: 36-hour build plan · hours from the official start\]

Every workstream starts inside hour 4 so the first full Kelp Replay can run at hour 22; nothing new is built after the hour 28 freeze.

### Cut list (cut from the top, never touch the bottom group)

| Order | Cut if behind | Fallback |
| --- | --- | --- |
| 1 | Topology Scout | Mention as roadmap |
| 2 | Ask KIRCHHOFF chat | None |
| 3 | MCP server | Show the REST `check-transfer` endpoint instead |
| 4 | LayerZero adapter | Roadmap slide |
| 5 | 4-cell committee | 1 cell, with the committee shown in the architecture slide |
| 6 | Full Spec Copilot | Copilot drafts only the demo token's spec |
| 7 | AI Narrator | Deterministic template text from the evidence bundle |
| Never cut | W1, W2, ledger, Judge or Fallback B, Circuit Map, Verdict Stream, Kelp Replay | These are the product |

## 17. Testing and QA

**The one test that matters most: replay random valid histories and every forged credit, and prove KIRCHHOFF flags every forgery and never flags valid traffic.**

| Layer | Tool | What must pass | Hackathon scope |
| --- | --- | --- | --- |
| Engine unit | Vitest | Every reason code, every rule branch, 100% branch coverage | Full |
| Engine property | fast-check | 10,000 random sequences of debits, credits, in-flight states and forged credits: every forgery flagged, zero false flags | Full |
| Contracts unit | Forge | Every report type, every illegal transition, replay rejection | Full |
| Contracts invariant | Forge invariant tests | BROKEN never returns to CONSERVED without RECOVERING; epochId strictly increases | Full |
| Workflows | `cre workflow simulate` against 3 local Anvil chains plus a mock forwarder | W1 and W2 produce the expected reports for 6 scripted scenarios | Full |
| Judge | Vitest or Go test plus recorded CCIP payloads | HMAC rejection, every FAIL path, 2s budget, RPC disagreement | Full |
| End to end | `demo/e2e.ts` on public testnets | Kelp Replay assertions: BREACH on 3 chains, CCIP refusal, Guard revert, borrow revert, incident created | Full, run 3 times before recording |
| Chaos | Scripted | Kill one RPC, kill the Judge, pause W2: behavior matches section 14's failure table | Light |
| Frontend | Playwright | Mission Control, Incident Room and Attack Lab flows; stage-mode visual snapshot | Key flows only |
| AI | Eval scripts | Section 11 eval table | Demo token only |
| Load | k6 | Judge at 100 requests per second, p99 under 300 ms | Light |

### The six scripted scenarios

1. Normal round trip home to Arbitrum to home: CONSERVED throughout.
2. Message in flight across an epoch boundary: no false DRIFT or BROKEN.
3. Forged WeakBridge release (Kelp Replay): BROKEN by `DEBIT_NOT_FOUND`.
4. Double credit of one real burn: BROKEN by `DOUBLE_CREDIT`.
5. Direct mint by a compromised minter key, no message: BROKEN by `LOOP_DEFICIT`.
6. Donation to the escrow: Δ rises, status stays CONSERVED, UI shows surplus.

### Definition of done for any feature

- [ ] Tests from the table above written and green.
- [ ] Works on the 3 public testnets, not just Anvil.
- [ ] Every number in its UI links to an explorer transaction or an onchain read.
- [ ] Loading, empty, stale, error and breach states designed and built.
- [ ] No em dashes in user-facing copy (house style).

## 18. Production roadmap, business model, go-to-market

**Adoption path: shadow mode first (watch and alert, no veto), then enforcement once an issuer has seen zero false alarms on its own traffic.**

### Roadmap

| Phase | Window after TOKEN2049 | Ships | Exit criteria |
| --- | --- | --- | --- |
| 0. Harden | Weeks 1 to 4 | Open-source engine and adapters, audit scoping, Chainlink Build application, CCV marketplace conversations | Audit firm booked; 2 issuer design partners signed |
| 1. Shadow | Months 2 to 3 | Mainnet monitoring for 2 design partners, LayerZero and Wormhole adapters, Incident Room in production | 60 days with zero false BROKEN on real traffic |
| 2. Enforce | Months 4 to 6 | 4-cell committee across independent operators, CCV marketplace listing, first enforced token | First token requiring KIRCHHOFF CCV on mainnet lanes |
| 3. Feed | Months 6 to 9 | Conservation Feed integrated by lending markets and vault curators | 3 money markets reading the feed |
| 4. Institutional | Months 9 to 12 | Tokenized funds and deposits on CCIP 2.0 across public and private chains; dedicated cells for regulated issuers | First institutional issuer |

### Business model

| Revenue line | Who pays | How |
| --- | --- | --- |
| CCV verification fee | Users of protected tokens, collected by CCIP | CCIP 2.0 lets third-party verifiers set their own fee on top of the base fee ([Chainlink](https://chain.link/blog/introducing-ccip-2-0)) |
| Issuer subscription | Token issuers | Monitoring, Incident Room, Spec Copilot, backtests, on-call integrations |
| Feed SLA | Lending markets, curators | Public feed free; paid tier with SLA and support |
| Dedicated cells | Institutions | We operate isolated cells or license the Judge for their own operators |

Pricing is a hypothesis to validate with design partners, not a commitment.

### Competitive landscape

| Alternative | What it does | Why KIRCHHOFF is different |
| --- | --- | --- |
| CCIP Committee Verifier | Verifies message authenticity | We add an independent economic check; we sit beside it, by design |
| Issuer-built CCVs (Lombard is building custom verification into its tokens) ([Chainlink](https://chain.link/blog/introducing-ccip-2-0)) | One issuer's own logic | We are a reusable product across issuers and bridges |
| Infra firms building CCVs (Infosys, Nethermind) ([Unchained](https://unchainedcrypto.com/?p=47980)) | Operate verifiers for clients | Likely partners: they can run cells with our Judge |
| Other bridges' verifier networks | Check signatures on their own messages | Cannot see supply created on other bridges |
| Runtime monitoring firms | Alert on suspicious activity | Alerts do not veto; we refuse to sign |
| Chainlink Proof of Reserve | Proves reserves exist | Does not track flows or match credits to debits; we can consume it |

### Go-to-market

1. **First customers:** issuers whose tokens move across several bridges and many chains: LRTs, LSTs, wrapped BTC, multi-chain stablecoins. Kelp itself said it was moving rsETH to CCIP. ([Unchained](https://unchainedcrypto.com/?p=47980))
2. **Channel:** Chainlink's CCV marketplace and ecosystem team; audit firms that recommend us in reports; risk curators who require the feed.
3. **Wedge:** free shadow-mode monitoring with a public status page. The page itself is marketing: holders ask their issuer why a token is not on it.

### Moat

- Adapter library and backtest corpus across bridges and chains, which compounds with every token.
- Incident history and zero-false-positive track record per token, which nobody can copy quickly.
- Network effect: the more lending markets read the feed, the more issuers must be on it.

## 19. Risks and open questions

**The biggest risk is not the idea; it is whether the CCIP 2.0 CCV testnet path is ready for us in 36 hours. Fallback B removes that risk for the demo.**

### Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Testnet CCV registration for our token is not available in time | Medium | High | Fallback B (KirchhoffTokenPool) built from hour 4; decision at hour 10 |
| CRE live deploy not granted during the event | Medium | Medium | Demo on `cre workflow simulate` against public testnets, labeled honestly |
| False DRIFT or BROKEN from messages in flight across an epoch | Low | High | In-flight from message matching, never from snapshot timing; scenario 2 test |
| Testnet congestion or slow finality breaks the recording | Medium | High | Reset script, three takes, backup recorder, pre-funded wallets |
| Judges read it as "just monitoring" | Medium | High | The hero shot is a refused CCIP message, not a chart |
| Chainlink or a large firm ships the same idea | Medium | Medium | Ship first, partner with CCV operators, publish the open spec |
| Team split with the Cascade (Cardano track) build | High | High | Decide before hour 0: one team, one project, or two fully separate teams |

### Open questions (answer before or at hour 0)

- [ ] Exact steps to make kETH require our CCV on CCIP 2.0 testnet lanes, and to onboard our aggregator to the CCIP indexer. Owner: CCV lead.
- [ ] Does the policy hook request carry token amounts and the source transaction hash? Read the [OpenAPI v1 spec](https://github.com/smartcontractkit/chainlink-ccv/blob/main/verifier/policy_hook_openapi_v1.yaml) before the start. Owner: CCV lead.
- [ ] Can we get CRE live deployment during the event? Owner: Lead.
- [ ] Which confidence options does the CRE EVM Log trigger expose (latest, safe, finalized)? Owner: CRE lead.
- [ ] CRE per-run limits on `filterLogs` block ranges and call counts; size `search_window_blocks` to fit. Owner: CRE lead.
- [ ] Token pool interface version on the CCIP testnet lanes we use, for Fallback B. Owner: Contracts 2.
- [ ] Finality time on each of the three testnets, to pace the recording. Owner: CRE lead.

## 20. References

**Chainlink platform**

- [Introducing CCIP 2.0](https://chain.link/blog/introducing-ccip-2-0)
- [Sibos 2026 recap: CCIP 2.0, Swift ledger, Fulcrum](https://chain.link/blog/sibos-2026-recap)
- [CCV Starter Kit](https://docs.chain.link/ccip/ccv-starter-kit)
- [Add a custom policy hook](https://docs.chain.link/ccip/ccv-starter-kit/how-to/add-a-custom-policy-hook)
- [CCV logging and monitoring](https://docs.chain.link/ccip/ccv-starter-kit/logging-and-monitoring)
- [Cross-Chain Verifiers concepts](https://docs.chain.link/ccip/concepts/ccvs)
- [Policy hook OpenAPI v1](https://github.com/smartcontractkit/chainlink-ccv/blob/main/verifier/policy_hook_openapi_v1.yaml) and [PR #1437](https://github.com/smartcontractkit/chainlink-ccv/pull/1437)
- [CRE EVM client reference (TypeScript)](https://docs.chain.link/cre/reference/sdk/evm-client-ts)
- [CRE consumer contracts and IReceiver](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts)
- [CRE trigger model (Automation migration guide)](https://docs.chain.link/cre/reference/cla-migration-ts)

**Hackathon context**

- [Convergence: A Chainlink Hackathon winners](https://chain.link/blog/convergence-hackathon-winners)
- [Chromion hackathon winners](https://chain.link/blog/announcing-the-chainlink-chromion-hackathon-winners)
- [ETHGlobal Cannes 2026 Chainlink prizes](https://ethglobal.com/events/cannes2026/prizes/chainlink)

**Incidents and market**

- [Crypto Times: 2026 bridge hacks and the Kelp DAO exploit](https://www.cryptotimes.io/2026/05/18/crypto-bridge-hacks-top-328m-in-2026-as-cross-chain-exploits-accelerate/)
- [Phemex: every major DeFi hack in 2026](https://phemex.com/blogs/defi-hacks-2026-bridge-exploits-explained)
- [DexTools / PeckShield: bridge hacks pass $340M in 2026](https://www.dextools.io/news/crypto-bridge-hacks-340-million-2026-peckshield-alert-june-2026-de)
- [Decrypt: CCIP 2.0 and the single-verifier lesson](https://decrypt.co/379463)
- [Unchained: CCIP 2.0 launch, Kelp moving to CCIP](https://unchainedcrypto.com/?p=47980)
