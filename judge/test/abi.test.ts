import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toFunctionSignature, type Abi, type AbiFunction } from "viem";
import { LEDGER_ABI, QUARANTINE_ABI, REGISTRY_ABI, TOPIC_CCIP_MESSAGE_SENT, TOPIC_LOCKED_OR_BURNED } from "../src/abi.ts";

const OUT = fileURLToPath(new URL("../../contracts/out/", import.meta.url));

function artifact(contract: string): Abi | null {
  const path = `${OUT}${contract}.sol/${contract}.json`;
  return existsSync(path) ? ((JSON.parse(readFileSync(path, "utf8")) as { abi: Abi }).abi) : null;
}

function signatures(abi: Abi): Map<string, AbiFunction> {
  const out = new Map<string, AbiFunction>();
  for (const item of abi) if (item.type === "function") out.set(toFunctionSignature(item), item);
  return out;
}

/** Output shape without names: tuple components flattened to their types. */
function outputs(fn: AbiFunction): string {
  const shape = (p: { type: string; components?: readonly { type: string }[] }): string =>
    p.components === undefined ? p.type : `(${p.components.map(shape).join(",")})${p.type.slice("tuple".length)}`;
  return fn.outputs.map(shape).join(",");
}

// contracts/out is a build artifact (gitignored); run `forge build` in contracts/ to enable this guard.
describe.skipIf(!existsSync(OUT))("Judge ABIs agree with the Foundry artifacts", () => {
  it.each([
    ["ConservationLedger", LEDGER_ABI],
    ["QuarantineController", QUARANTINE_ABI],
    ["KirchhoffRegistry", REGISTRY_ABI],
  ] as const)("%s", (contract, ours) => {
    const theirs = artifact(contract);
    if (theirs === null) throw new Error(`contracts/out/${contract}.sol missing: run forge build`);
    const deployed = signatures(theirs);
    for (const [sig, fn] of signatures(ours)) {
      const match = deployed.get(sig);
      expect(match, `${contract}.${sig}`).toBeDefined();
      if (match) {
        expect(outputs(fn), `${contract}.${sig} outputs`).toBe(outputs(match));
        // uint8 enum outputs stay uint8 in the artifact; the Judge validates the range itself.
        expect(match.stateMutability).toBe("view");
      }
    }
  });
});

describe("CCIP 2.0.0 topics (docs/research/ccip.md, confirmed against live Sepolia logs)", () => {
  it("match the documented topic0 values", () => {
    expect(TOPIC_LOCKED_OR_BURNED).toBe("0xf33bc26b4413b0e7f19f1ea739fdf99098c0061f1f87d954b11f5293fad9ae10");
    expect(TOPIC_CCIP_MESSAGE_SENT).toBe("0x371bc2ff0a006f4ef863b1d27a065d4e9f938b6d883eb154572b4aea593b32cc");
  });
});
