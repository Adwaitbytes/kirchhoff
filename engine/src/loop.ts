import { isHome, specChains } from "./chains.ts";
import { rescale, toCanonical } from "./units.ts";
import { EngineInputError, Reason, Status, type LoopResult, type Snapshot, type TokenSpec } from "./types.ts";

function supplyOf(snapshot: Snapshot, spec: TokenSpec, chain: bigint): bigint {
  const entries = snapshot.supplies.filter((s) => s.chain === chain);
  const entry = entries[0];
  if (entry === undefined || entries.length > 1) {
    throw new EngineInputError(`snapshot needs exactly one supply for chain ${chain.toString()}`);
  }
  return toCanonical(spec, chain, entry.supply);
}

/**
 * ΣS over the chains whose supply is a claim on backing. Lock-and-release
 * counts remotes only (home supply is the canonical token itself); burn-and-mint
 * counts every chain because every chain mints.
 */
function claimedSupply(snapshot: Snapshot, spec: TokenSpec): bigint {
  let total = 0n;
  for (const chain of specChains(spec)) {
    if (spec.model === "lock_release_home" && isHome(spec, chain.selector)) continue;
    total += supplyOf(snapshot, spec, chain.selector);
  }
  return total;
}

type Backing = { backing: bigint; reserveBinds: boolean };

function backingOf(snapshot: Snapshot, spec: TokenSpec): Backing {
  if (snapshot.model === "lock_release_home") return { backing: snapshot.escrow, reserveBinds: false };
  if (spec.reserves.porFeed === null) return { backing: snapshot.issuanceNet, reserveBinds: false };
  if (snapshot.reserve === null) {
    throw new EngineInputError(`${spec.token} is reserve-backed but the snapshot has no reserve answer`);
  }
  const reserve = rescale(snapshot.reserve, spec.reserves.decimals, spec.home.decimals);
  // R binds only when strictly below I_net; on a tie the issuance bound is the one violated.
  return reserve < snapshot.issuanceNet
    ? { backing: reserve, reserveBinds: true }
    : { backing: snapshot.issuanceNet, reserveBinds: false };
}

/**
 * PRD section 6 Loop Rule for one epoch.
 *
 * lock_release_home: Δ = E − (ΣS + F_out + F_in), BROKEN iff Δ < −τ.
 * burn_mint_multi:   Δ = min(I_net, R) − (ΣS + F),  BROKEN iff Δ < −τ.
 *
 * A deficit only becomes BROKEN after `breach_confirmations` consecutive deficit
 * epochs; earlier ones are DRIFT so a single bad read cannot break the token
 * when the issuer asked for confirmations. Escrow donations only raise Δ.
 */
export function loop(snapshot: Snapshot, spec: TokenSpec): LoopResult {
  if (snapshot.model !== spec.model) {
    throw new EngineInputError(`snapshot model ${snapshot.model} does not match spec model ${spec.model}`);
  }
  const { backing, reserveBinds } = backingOf(snapshot, spec);
  const claims = claimedSupply(snapshot, spec) + snapshot.inFlightOut + snapshot.inFlightIn;
  const delta = backing - claims;
  const surplus = delta > 0n ? delta : 0n;
  const base = { delta, backing, claims, surplus };

  if (delta < -spec.rules.loop.toleranceWei) {
    const reason = reserveBinds ? Reason.RESERVE_SHORTFALL : Reason.LOOP_DEFICIT;
    const confirmed = snapshot.priorDeficitEpochs + 1 >= spec.rules.loop.breachConfirmations;
    return { ...base, status: confirmed ? Status.BROKEN : Status.DRIFT, reason, deficit: true };
  }
  const limit = spec.rules.soft.flowLimitPerHour;
  if (limit !== null && snapshot.flowLastHour > limit) {
    return { ...base, status: Status.DRIFT, reason: Reason.FLOW_LIMIT, deficit: false };
  }
  return { ...base, status: Status.CONSERVED, reason: Reason.OK, deficit: false };
}
