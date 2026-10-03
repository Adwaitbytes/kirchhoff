import { bridgeAddressMaps, emitterOn, messageIdTopic, parseBridgeEvent } from "../adapters/event.ts";
import { bridgeForMinter, chainByAlias, specChains } from "../chains.ts";
import { describeError, type CcipBridgeSpec, type ChainRef, type Hex, type TokenSpec } from "../types.ts";

export type BytecodeCheck = (chain: ChainRef, address: Hex) => Promise<boolean>;

export type SpecValidation = { ok: boolean; errors: string[]; warnings: string[] };

export const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";

export function isPlaceholder(address: Hex): boolean {
  return address.toLowerCase() === ZERO_ADDRESS;
}


function duplicates(values: readonly string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) !== i);
}

/** Every address the spec names, with the chain it must have bytecode on. */
export function specAddresses(spec: TokenSpec): { label: string; chain: ChainRef; address: Hex }[] {
  const out: { label: string; chain: ChainRef; address: Hex }[] = [
    { label: "home.canonical", chain: spec.home.chain, address: spec.home.canonical },
  ];
  if (spec.home.escrow !== null) out.push({ label: "home.escrow", chain: spec.home.chain, address: spec.home.escrow });
  for (const r of spec.remotes) out.push({ label: `remotes.${r.chain.alias}.token`, chain: r.chain, address: r.token });
  for (const b of spec.bridges) {
    for (const { name, map } of bridgeAddressMaps(b)) {
      for (const [alias, address] of Object.entries(map)) {
        const chain = chainByAlias(spec, alias);
        if (chain !== undefined) out.push({ label: `bridges.${b.id}.${name}.${alias}`, chain, address });
      }
    }
    if (b.kind === "ccip_v2" && b.lockbox !== null) {
      out.push({ label: `bridges.${b.id}.lockbox`, chain: spec.home.chain, address: b.lockbox });
    }
  }
  if (spec.reserves.porFeed !== null) {
    out.push({ label: "reserves.por_feed", chain: spec.home.chain, address: spec.reserves.porFeed });
  }
  return out;
}

function checkStructure(spec: TokenSpec, errors: string[]): void {
  const chains = specChains(spec);
  for (const d of duplicates(chains.map((c) => c.name))) errors.push(`chain ${d} appears more than once`);
  for (const d of duplicates(chains.map((c) => c.alias))) errors.push(`chain alias ${d} appears more than once`);
  for (const d of duplicates(spec.bridges.map((b) => b.id))) errors.push(`bridge id ${d} appears more than once`);
  for (const name of Object.keys(spec.confidence.overrides)) {
    if (!chains.some((c) => c.name === name)) errors.push(`confidence override for ${name}, which is not in the spec`);
  }
  if (spec.model === "lock_release_home" && spec.home.escrow === null) {
    errors.push("lock_release_home needs home.escrow");
  }
  for (const remote of spec.remotes) {
    if (remote.minters.length === 0) errors.push(`remote ${remote.chain.name} has no minter`);
    for (const minter of remote.minters) {
      const bridge = bridgeForMinter(spec, minter, remote.chain.alias);
      if (bridge === undefined) {
        errors.push(`minter ${minter} on ${remote.chain.name} maps to no bridge`);
      } else if (emitterOn(spec, bridge, remote.chain.selector) === null) {
        errors.push(`minter ${minter} maps to bridge ${bridge.id}, which has no address on ${remote.chain.name}`);
      }
    }
  }
}

function checkCcip(spec: TokenSpec, bridge: CcipBridgeSpec, errors: string[], warnings: string[]): void {
  for (const [alias] of Object.entries(bridge.pools)) {
    const chain = chainByAlias(spec, alias);
    if (chain === undefined) continue;
    for (const ramp of ["onramps", "offramps"] as const) {
      if (bridge[ramp][alias] === undefined) {
        warnings.push(`ccip_v2 bridge ${bridge.id} has a pool on ${chain.name} but no ${ramp} entry, so its messages there are not matched`);
      }
    }
  }
  // V2 lock-release pools keep escrow in an ERC20LockBox; without it E undercounts and valid CCIP traffic reads as a deficit.
  if (spec.model === "lock_release_home" && bridge.pools[spec.home.chain.alias] !== undefined && bridge.lockbox === null) {
    errors.push(`ccip_v2 bridge ${bridge.id} has a home pool but no lockbox; the lock-release escrow is the ERC20LockBox balance`);
  }
}

function checkBridges(spec: TokenSpec, errors: string[], warnings: string[]): void {
  for (const bridge of spec.bridges) {
    for (const { name, map } of bridgeAddressMaps(bridge)) {
      for (const alias of Object.keys(map)) {
        if (chainByAlias(spec, alias) === undefined) errors.push(`bridge ${bridge.id} ${name} names unknown chain alias ${alias}`);
      }
    }
    if (bridge.kind === "ccip_v2") {
      checkCcip(spec, bridge, errors, warnings);
      continue;
    }
    try {
      const debit = parseBridgeEvent(bridge.events.debitEvent, bridge.events.debitFields);
      const credit = parseBridgeEvent(bridge.events.creditEvent, bridge.events.creditFields);
      if (messageIdTopic(debit) !== messageIdTopic(credit)) {
        errors.push(`bridge ${bridge.id}: debit and credit must carry the message id in the same topic`);
      }
    } catch (e) {
      errors.push(`bridge ${bridge.id}: ${describeError(e)}`);
    }
  }
}

/**
 * Semantic checks from the PRD section 6 spec lifecycle, step 2. The bytecode
 * check is injected so the engine itself never touches the network; zero
 * addresses are compile-time placeholders and only warn.
 */
export async function validateSpec(spec: TokenSpec, hasBytecode?: BytecodeCheck): Promise<SpecValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  checkStructure(spec, errors);
  checkBridges(spec, errors, warnings);

  for (const { label, chain, address } of specAddresses(spec)) {
    if (isPlaceholder(address)) {
      warnings.push(`${label} is a placeholder address; compile fills it from deployments`);
      continue;
    }
    if (hasBytecode === undefined) continue;
    try {
      if (!(await hasBytecode(chain, address))) errors.push(`${label} ${address} has no bytecode on ${chain.name}`);
    } catch (e) {
      errors.push(`${label} bytecode check failed on ${chain.name}: ${describeError(e)}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
