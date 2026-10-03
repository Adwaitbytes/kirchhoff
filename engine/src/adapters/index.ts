import type { TokenSpec } from "../types.ts";
import { createCcipV2Adapter } from "./ccip.ts";
import { createEventAdapter } from "./event.ts";
import type { BridgeAdapter } from "./types.ts";
import { WEAKBRIDGE_EVENTS, createWeakbridgeAdapter } from "./weakbridge.ts";

export type { BridgeAdapter, Log } from "./types.ts";
export { CCIP_EVENTS, CCIP_TOPICS, createCcipV2Adapter } from "./ccip.ts";
export { addressOn, createEventAdapter, emitterOn, messageIdTopic, parseBridgeEvent, type EventAdapterOptions } from "./event.ts";
export {
  BRIDGE_REGISTRY_ABI,
  NO_TX,
  creditFromRegistry,
  debitFromRegistry,
  encodeCreditOf,
  encodeDebitOf,
} from "./registry.ts";
export { WEAKBRIDGE_EVENTS, createWeakbridgeAdapter } from "./weakbridge.ts";

const sameEvents = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b;

/** One adapter per spec bridge: ccip_v2, the frozen WeakBridge, or a generic single-event adapter. */
export function adaptersForSpec(spec: TokenSpec): BridgeAdapter[] {
  return spec.bridges.map((bridge) => {
    if (bridge.kind === "ccip_v2") return createCcipV2Adapter(spec, bridge.id);
    if (
      sameEvents(bridge.events.debitEvent, WEAKBRIDGE_EVENTS.debitEvent) &&
      sameEvents(bridge.events.creditEvent, WEAKBRIDGE_EVENTS.creditEvent)
    ) {
      return createWeakbridgeAdapter(spec, bridge.id);
    }
    return createEventAdapter({ id: bridge.id, spec, bridgeId: bridge.id, events: bridge.events });
  });
}
