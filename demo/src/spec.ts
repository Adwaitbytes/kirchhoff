import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSpec, type Deployments } from "@kirchhoff/engine";
import { parseSpec, specHash } from "@kirchhoff/engine/spec";
import { parseAbi, type Hex } from "viem";
import { account, read, send, type Sent } from "./chain.ts";
import type { Context } from "./context.ts";
import { mergedPath, readState } from "./deployments.ts";
import { REPO_ROOT } from "./env.ts";
import { log, type stepEmitter } from "./events.ts";
import { execSafe } from "./safe.ts";

type Emit = ReturnType<typeof stepEmitter>;

export const registryAbi = parseAbi([
  "function proposeSpec(bytes32 tokenId, bytes32 specHash, string specURI)",
  "function activateSpec(bytes32 tokenId)",
  "function activeSpecHash(bytes32 tokenId) view returns (bytes32)",
  "function timelockSeconds() view returns (uint64)",
  "struct PendingSpec { bytes32 specHash; string specURI; uint64 eta; }",
  "function pendingSpec(bytes32 tokenId) view returns (PendingSpec)",
]);

const SPEC_PATH = "engine/specs/kETH.yaml";
const REPO_SLUG = "Adwaitbytes/kirchhoff";

/**
 * The KIRCH-SPEC hash the registry, the Judge's cache and the workflow configs all hold: the engine's `specHash`
 * of engine/specs/kETH.yaml resolved against deployments/<network>.json (engine/src/spec/compile-files.ts).
 */
export function resolvedSpecHash(net: Context["net"]["name"]): Hex {
  const parsed = parseSpec(readFileSync(join(REPO_ROOT, SPEC_PATH), "utf8"));
  if (!parsed.ok) throw new Error(`KIRCH-SPEC invalid: ${parsed.errors.join("; ")}`);
  const deployments = JSON.parse(readFileSync(mergedPath(net), "utf8")) as Deployments;
  const { spec, errors } = resolveSpec(parsed.spec, deployments);
  if (errors.length > 0) throw new Error(`KIRCH-SPEC does not resolve against ${net}.json: ${errors.join("; ")}`);
  return specHash(spec);
}

/**
 * Immutable spec URI: the raw GitHub URL of the spec template at the commit that last changed it (the hash covers
 * that template resolved with the deployment addresses). Falls back to `main` when the file has local edits.
 */
export function specUri(): string {
  const dirty = execFileSync("git", ["status", "--porcelain", "--", SPEC_PATH], { cwd: REPO_ROOT, encoding: "utf8" }).trim() !== "";
  const commit = dirty ? "" : execFileSync("git", ["log", "-1", "--format=%H", "--", SPEC_PATH], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  return `https://raw.githubusercontent.com/${REPO_SLUG}/${commit === "" ? "main" : commit}/${SPEC_PATH}`;
}

/**
 * Contract parameters the KIRCH-SPEC owns (rules.staleness_seconds, response.recovery_timelock_seconds), read with the
 * engine's parser. They are rule fields, so they are the same before and after address resolution.
 */
export function specParameters(): { stalenessSeconds: bigint; recoveryTimelockSeconds: bigint } {
  const parsed = parseSpec(readFileSync(join(REPO_ROOT, SPEC_PATH), "utf8"));
  if (!parsed.ok) throw new Error(`KIRCH-SPEC invalid: ${parsed.errors.join("; ")}`);
  return { stalenessSeconds: parsed.spec.rules.stalenessSeconds, recoveryTimelockSeconds: parsed.spec.response.recoveryTimelockSeconds };
}

export type SpecLifecycle = { specHash: Hex; specURI: string; propose: Sent | null; activate: Sent | null; skipped: boolean };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * PRD section 6 spec lifecycle on the home KirchhoffRegistry: the issuer Safe (2-of-3) proposes the spec hash and
 * URI, the registry timelock elapses (testnet minimum 600 s, with a countdown; Anvil fast-forwards its clock), then
 * anyone activates it. Idempotent: skipped when the active hash already matches, and an identical pending proposal
 * is reused instead of restarting the timelock.
 */
export async function activateSpec(ctx: Context, emit: Emit): Promise<SpecLifecycle> {
  const home = ctx.chains.home;
  const registry = ctx.at("home", "kirchhoffRegistry");
  const hash = resolvedSpecHash(ctx.net.name);
  const uri = specUri();
  const active = await read<Hex>(home, { to: registry, abi: registryAbi, functionName: "activeSpecHash", args: [ctx.tokenId] });
  if (active.toLowerCase() === hash.toLowerCase()) {
    emit({ step: "spec", status: "skipped", chain: "home", title: `spec ${hash} already active` });
    return { specHash: hash, specURI: uri, propose: null, activate: null, skipped: true };
  }

  const safe = readState(ctx.net.name).safe?.address;
  if (safe === undefined) throw new Error("no issuer Safe recorded; run deploy-all first");
  let pending = await read<{ specHash: Hex; specURI: string; eta: bigint }>(home, { to: registry, abi: registryAbi, functionName: "pendingSpec", args: [ctx.tokenId] });
  let propose: Sent | null = null;
  if (pending.eta === 0n || pending.specHash.toLowerCase() !== hash.toLowerCase() || pending.specURI !== uri) {
    propose = await execSafe(home, safe, { to: registry, abi: registryAbi, functionName: "proposeSpec", args: [ctx.tokenId, hash, uri] }, "proposeSpec");
    emit({ step: "spec-propose", status: "ok", chain: "home", title: `issuer Safe proposed spec ${hash}`, txHash: propose.hash, explorerUrl: propose.url, detail: { specURI: uri } });
    pending = await read(home, { to: registry, abi: registryAbi, functionName: "pendingSpec", args: [ctx.tokenId] });
  } else {
    emit({ step: "spec-propose", status: "skipped", chain: "home", title: "identical proposal already pending", detail: { eta: Number(pending.eta) } });
  }

  const now = async (): Promise<bigint> => (await home.client.getBlock({ blockTag: "latest" })).timestamp;
  if (home.local) {
    // Anvil only: move the clocks past the timelock instead of idling 10 minutes. All three chains move together:
    // W1 compares the credit time with the source chain's pin, so skewed clocks would read as a pending debit.
    const gap = pending.eta - (await now()) + 1n;
    if (gap > 0n) {
      for (const chain of Object.values(ctx.chains)) {
        await chain.client.request({ method: "evm_increaseTime" as never, params: [Number(gap)] as never });
        await chain.client.request({ method: "evm_mine" as never, params: [] as never });
      }
    }
  } else {
    for (let left = pending.eta - (await now()); left > 0n; left = pending.eta - (await now())) {
      log(`spec timelock: ${left}s until activateSpec is allowed`);
      await sleep(Math.min(Number(left) * 1000 + 2000, 30_000));
    }
  }

  const activate = await send(home, account("DEPLOYER"), { to: registry, abi: registryAbi, functionName: "activateSpec", args: [ctx.tokenId] }, "activateSpec");
  const after = await read<Hex>(home, { to: registry, abi: registryAbi, functionName: "activeSpecHash", args: [ctx.tokenId] });
  if (after.toLowerCase() !== hash.toLowerCase()) throw new Error(`activateSpec left active hash ${after}, expected ${hash}`);
  emit({ step: "spec-activate", status: "ok", chain: "home", title: `spec ${hash} active`, txHash: activate.hash, explorerUrl: activate.url });
  return { specHash: hash, specURI: uri, propose, activate, skipped: false };
}
