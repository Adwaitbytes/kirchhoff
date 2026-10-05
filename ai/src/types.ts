import type { IncidentResponse } from "@kirchhoff/sdk";

/** Everything the Incident Room shows except the AI narrative: deterministic, built from the mirror (Narrator input). */
export type IncidentBundle = Omit<IncidentResponse, "narrative" | "source" | "ledger" | "block" | "servedAt">;
