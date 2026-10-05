# Requests from the CRE workflows to `@kirchhoff/engine`

Owner of this file: CRE lead (workflows/). The engine team owns `engine/`; the workflows never edit it.
Each request says why the workflows need it and what they do until it lands.

## R1. Resolved spec inside the W1 and W2 configs (DELIVERED)

`junction(credit, debit, ctx)`, `matchAll(...)` and `loop(snapshot, spec)` take a full `TokenSpec`, but the
generated `W1Config` / `W2Config` only carry flattened fields. Inside WASM the workflow has nothing but its config.

Ask:
- add `spec: SpecJson` (the same JSON-safe object `spec.resolved.json` already contains, bigints as decimal
  strings) to `W1Config` and `W2Config`;
- export a pure `reviveSpec(json: SpecJson): TokenSpec` from the main entry (`@kirchhoff/engine`), no ajv/yaml, so
  it bundles into the CRE WASM.

Until then: `workflows/src/spec.ts` rebuilds a `TokenSpec` from the compiled config fields (chains, decimals,
model, rules). Bridges are rebuilt from `creditTriggers` / `debitLookups`.

**RESOLVED (engine).** `W1Config.spec` and `W2Config.spec` carry the resolved spec as `SpecJson` (bigints as decimal strings, same content as `spec.resolved.json`). `import { reviveSpec } from "@kirchhoff/engine"` gives back the `TokenSpec`; it lives in `engine/src/spec-json.ts`, imports nothing, and round-trips are tested (`test/spec-json.test.ts`, `test/compile.test.ts`). `workflows/src/spec.ts` can drop its rebuild.

## R2. `SpecActivated` signature differs from the contract (RESOLVED by the engine, 04:01)

`engine/src/contract-events.ts` has `SpecActivated(bytes32 indexed tokenId, bytes32 specHash)`, but
`contracts/src/interfaces/IKirchhoffRegistry.sol` emits
`SpecActivated(bytes32 indexed tokenId, bytes32 indexed specHash, string specURI, uint64 version)`.
The topic0 in `W4Config.registry.specActivatedTopic0` therefore never matches and W4's log trigger never fires.

## R3. W2 supply triggers fire on every transfer (DELIVERED)

`W2Config.supplyTriggers` subscribes to every `Transfer` of the token. CRE caps log triggers at 10 events per 6 s
and every ordinary transfer would start a full epoch. Supply only changes on mint (`from == 0`) and burn
(`to == 0`) on remotes, and on transfers into or out of the escrow holders on home. Please emit topic filters:
`topics: [[Transfer], [0x0..0], []]` and `[[Transfer], [], [0x0..0]]` on remotes (two triggers or one trigger with
both zero-address slots is not expressible, so one trigger per side), and `[[Transfer], [], [escrowHolders]]` plus
`[[Transfer], [escrowHolders], []]` on home. Until then the workflows apply these filters themselves from
`supplyTriggers` + `escrowHolders` (the trigger topics are a workflow wiring concern, so this is a fallback, not a
config edit).

**RESOLVED (engine).** `W2Config.supplyTriggers` is now `SupplyTrigger[]` = `{ chain, address, side, topics: [Hex[], Hex[], Hex[]] }`, one trigger per side, slots are 32-byte padded addresses and `[]` is a wildcard. Remotes: `mint` `[[Transfer], [0x0..0], []]` and `burn` `[[Transfer], [], [0x0..0]]`. Home (lock_release_home): `escrow_in` `[[Transfer], [], [escrowHolders]]` and `escrow_out` `[[Transfer], [escrowHolders], []]`, holders = escrow adapter + ERC20LockBox. For burn_mint_multi the home chain gets mint/burn like a remote. The old `topic0` field is gone.

## R4. CCIP credit/debit ramps in W1/W2 configs (RESOLVED: `pairWith`, ramps from `deployments.ccip`)

W1 must also trigger on OffRamp `ExecutionStateChanged` (credit message id) and confirm the debit through the
OnRamp `CCIPMessageSent` in the same transaction (INTERFACES.md Revision 2). The compiled configs carry no
OnRamp/OffRamp addresses yet, and `bridgeWatches` skips ccip bridges with no pool ABI. Please add per chain
`onramp` / `offramp` addresses and the two ramp topic0s to `creditTriggers` / `debitLookups` (adapter `ccip_v2`).
Until then W1/W2 watch the WeakBridge only and log that CCIP is unwatched (the warning the compiler already prints).

## R5. `searchWindowBlocks` above the CRE limit (RESOLVED: kETH.yaml now 100, `logQueryBlockLimit` in W2)

`debitLookups[].searchWindowBlocks` is `50000`; CRE `filterLogs` accepts at most 100 blocks per query
(`ChainRead.LogQueryBlockLimit`). The workflows clamp to 100 and confirm debits through `debitOf` (Revision 2), so
this is informational. A compiler warning when the spec exceeds 100 would help reviewers.

**RESOLVED (engine).** The compiler warns `bridge <id>: search_window_blocks N exceeds CRE's 100-block filterLogs limit; queries use 100` and emits 100 in `debitLookups[].searchWindowBlocks`.

## R6. Debit registry flag on W2 watches (DELIVERED)

`W1Config.debitLookups[].registry` says whether a bridge exposes `debitOf` / `creditOf`; `W2Config.debitEvents`
does not. W2 needs it to match credits whose debit is older than its log windows. Until then W2 treats
`adapter === "weakbridge"` as "has the registry" (true for WeakBridge and HomeEscrowAdapter). Ask: add the same
`registry` field to `W2Config.debitEvents`.

**RESOLVED (engine).** `W2Config.debitEvents[].registry` is the same value as `W1Config.debitLookups[].registry`: `{ debitOf, creditOf }` function selectors for WeakBridge / HomeEscrowAdapter, `null` for CCIP.

## Status (04:05 onward)

R1 (resolved spec in W1/W2 configs + `reviveSpec`), R3 (supply trigger topic filters) and R6 (`registry` on
W2 debit watches) were delivered by the engine; the workflows now use them directly (`reviveSpec(config.spec)`,
`config.supplyTriggers`, `debitEvents[].registry`) and the interim fallbacks were removed. All requests are closed.

## R8. W4 needs the spec, the CCIP TokenAdminRegistry and the notify secrets (OPEN, 2026-10-06)

PRD_TRACEABILITY 8.W4.1-8.W4.3: W4 must (a) compare `KirchhoffRegistry.activeSpec(tokenId).specHash` with the spec it
runs, (b) check the token's CCIP pool and pool peers against the spec, and (c) page the issuer when it raises DRIFT.
Ask, all additive to `W4Config`:
- `spec: SpecJson` (as in W1/W2), so W4 knows the spec pools per chain and revives it with `reviveSpec`;
- `chains[].tokenAdminRegistry: Hex | null` from a new optional `ChainDeployment.ccip.tokenAdminRegistry`
  (public testnets: docs/research/ccip.md section 1; null on Anvil, where Deploy.s.sol has none);
- `notifySecrets: string[]` exactly as in `W3Config` (from `response.on_broken` containing `page_issuer`).
`workflows/scripts/lib/deployments.ts` will fill `ccip.tokenAdminRegistry` from the Deploy.s.sol record
(`ccipTokenAdminRegistry`, zero address -> omitted).
