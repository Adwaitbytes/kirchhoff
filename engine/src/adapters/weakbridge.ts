import { EngineInputError, type BridgeEvents, type TokenSpec } from "../types.ts";
import { createEventAdapter } from "./event.ts";
import type { BridgeAdapter } from "./types.ts";

/** Frozen in docs/INTERFACES.md: emitted by WeakBridge on remotes and HomeEscrowAdapter on home. */
export const WEAKBRIDGE_EVENTS: BridgeEvents = {
  debitEvent: "Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain)",
  creditEvent: "Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain)",
  debitFields: { messageId: "id", amount: "amount", recipient: "to", remoteChain: "dstChain" },
  creditFields: { messageId: "id", amount: "amount", recipient: "to", remoteChain: "srcChain" },
};

const normalize = (signature: string): string => signature.replace(/\s+/g, " ").trim();

/**
 * Adapter for the demo WeakBridge. The spec must declare exactly the frozen
 * events, so a spec edit cannot silently point W1 at different logs.
 */
export function createWeakbridgeAdapter(spec: TokenSpec, bridgeId = "weakbridge"): BridgeAdapter {
  const bridge = spec.bridges.find((b) => b.id === bridgeId);
  if (bridge?.kind !== "custom") throw new EngineInputError(`spec ${spec.token} has no custom bridge "${bridgeId}"`);
  if (
    normalize(bridge.events.debitEvent) !== WEAKBRIDGE_EVENTS.debitEvent ||
    normalize(bridge.events.creditEvent) !== WEAKBRIDGE_EVENTS.creditEvent
  ) {
    throw new EngineInputError(`bridge ${bridgeId} events differ from the frozen WeakBridge events`);
  }
  return createEventAdapter({ id: "weakbridge", spec, bridgeId, events: WEAKBRIDGE_EVENTS });
}
