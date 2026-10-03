import { Status, statusName } from "./types.ts";

export type StatusEvent =
  /** W2 EPOCH report. */
  | { kind: "EPOCH"; status: typeof Status.CONSERVED | typeof Status.DRIFT }
  /** W1 or W2 BREACH report. */
  | { kind: "BREACH" }
  /** W3 QUARANTINE_APPLIED report. */
  | { kind: "QUARANTINE_APPLIED" }
  /** QuarantineController.resolve by the issuer Safe; never a CRE report. */
  | { kind: "BEGIN_RECOVERY" }
  /** W2 RECOVERY_CHECK report. */
  | { kind: "RECOVERY_CHECK"; delta: bigint; timelockEnded: boolean }
  /** No epoch inside the staleness window. */
  | { kind: "STALE" };

export type IllegalTransition = { from: Status; event: StatusEvent["kind"]; why: string };

export type TransitionResult =
  | { ok: true; status: Status; changed: boolean }
  | { ok: false; error: IllegalTransition };

const stay = (status: Status): TransitionResult => ({ ok: true, status, changed: false });
const move = (status: Status): TransitionResult => ({ ok: true, status, changed: true });
const illegal = (from: Status, event: StatusEvent, why: string): TransitionResult => ({
  ok: false,
  error: { from, event: event.kind, why: `${event.kind} from ${statusName(from)}: ${why}` },
});

function isContained(status: Status): boolean {
  return status === Status.BROKEN || status === Status.QUARANTINED || status === Status.RECOVERING;
}

export type CreReportEvent = Extract<StatusEvent, { kind: "EPOCH" | "BREACH" }>;

/**
 * EPOCH and BREACH are accepted from every status (an EPOCH while contained is
 * ignored, a repeat BREACH only adds evidence), so this half of the machine is
 * total and returns the next status directly.
 */
export function applyCreReport(from: Status, event: CreReportEvent): Status {
  if (event.kind === "EPOCH") return isContained(from) ? from : event.status;
  return from === Status.BROKEN || from === Status.QUARANTINED ? from : Status.BROKEN;
}

/**
 * PRD section 4 status machine, extended exactly as far as the contract rules
 * in docs/INTERFACES.md require: an EPOCH while contained is ignored (not an
 * error), a BREACH while BROKEN or QUARANTINED records evidence without a status
 * change, and a BREACH during RECOVERING or before the first epoch breaks the
 * token. Only BEGIN_RECOVERY, which no CRE report can produce, leaves
 * QUARANTINED, so a CRE report can never clear BROKEN.
 */
export function transition(from: Status, event: StatusEvent): TransitionResult {
  switch (event.kind) {
    case "EPOCH":
    case "BREACH": {
      const to = applyCreReport(from, event);
      return to === from ? stay(from) : move(to);
    }
    case "QUARANTINE_APPLIED":
      return from === Status.BROKEN ? move(Status.QUARANTINED) : illegal(from, event, "only allowed when BROKEN");
    case "BEGIN_RECOVERY":
      return from === Status.QUARANTINED
        ? move(Status.RECOVERING)
        : illegal(from, event, "only allowed when QUARANTINED");
    case "RECOVERY_CHECK":
      if (from !== Status.RECOVERING) return illegal(from, event, "only allowed when RECOVERING");
      if (!event.timelockEnded) return illegal(from, event, "recovery timelock has not ended");
      if (event.delta < 0n) return illegal(from, event, "fresh epoch delta is negative");
      return move(Status.CONSERVED);
    case "STALE":
      // Staleness only demotes live statuses; BROKEN and worse are always reported as is.
      return from === Status.CONSERVED || from === Status.DRIFT ? move(Status.UNKNOWN) : stay(from);
  }
}
