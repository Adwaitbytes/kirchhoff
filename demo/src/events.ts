/** Human-readable progress goes to stderr so stdout stays a clean JSON-lines stream for the API. */
export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

export const LABEL = "Testnet simulation";

export type StepStatus = "started" | "ok" | "refused" | "failed" | "skipped";

export type StepEvent = {
  label: typeof LABEL;
  network: string;
  step: string;
  status: StepStatus;
  chain?: string;
  title?: string;
  txHash?: string | null;
  explorerUrl?: string | null;
  revertReason?: string;
  detail?: Record<string, string | number | boolean | null>;
  at: string;
};

export type StepInput = Omit<StepEvent, "label" | "network" | "at">;

/** One JSON object per line on stdout (the Attack Lab stream contract). */
export function stepEmitter(network: string): (event: StepInput) => StepEvent {
  return (event) => {
    const full: StepEvent = { label: LABEL, network, ...event, at: new Date().toISOString() };
    process.stdout.write(`${JSON.stringify(full)}\n`);
    return full;
  };
}
