import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { compileValidators } from "../src/schema.ts";
import {
  AMOUNT,
  ARB,
  HOME,
  MESSAGE_ID,
  contractsOn,
  kethRequest,
  pad32,
  post,
  SENDER,
  startHarness,
  type Harness,
} from "./helpers/harness.ts";
import { ZERO32 } from "./helpers/rpc-stub.ts";

const validators = compileValidators();
const INCIDENT: Hex = `0x9f3c${"00".repeat(30)}`;

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

async function verdict(body: unknown = kethRequest(h.token)) {
  const res = await post(h.url, body);
  if (res.status === 200) expect(validators.response(res.body), JSON.stringify(validators.response.errors)).toBe(true);
  return res;
}

function expectPending(res: { status: number; body: Record<string, unknown> }, note: RegExp): void {
  expect(res.status).toBe(503);
  expect(Object.keys(res.body)).toEqual(["error"]);
  expect(res.body.error).toMatch(/^PENDING_ATTESTATION /);
  expect(res.body.error).toMatch(note);
}

function failLog(): Record<string, unknown> {
  const line = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "verdict FAIL");
  if (line === undefined) throw new Error(`no FAIL log in ${h.logs.join("")}`);
  return line;
}

describe("PASS (steps 4 and 9)", () => {
  it("passes a conserved, debited kETH transfer with the PRD reason format", async () => {
    const res = await verdict();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ decision: "PASS", message_id: MESSAGE_ID, reason: "OK kETH CONSERVED delta=0 epoch=4182" });
  });

  it("reports the destination view: DRIFT still passes", async () => {
    h.both(HOME, (s) => {
      const l = s.state.ledgers.get(contractsOn(h.token, HOME).ledger);
      if (l !== undefined) Object.assign(l, { status: 2, delta: -5n, epochId: 77n, epochReason: 8 });
    });
    const res = await verdict();
    expect(res.body).toEqual({ decision: "PASS", message_id: MESSAGE_ID, reason: "OK kETH DRIFT delta=-5 epoch=77" });
  });

  it("passes a data-only message without touching RPC", async () => {
    const req = kethRequest(h.token);
    delete req.message.token_transfer;
    const before = [...h.stubs.values()].flat().reduce((n, s) => n + s.calls, 0);
    const res = await verdict(req);
    expect(res.body).toEqual({ decision: "PASS", message_id: MESSAGE_ID, reason: "OK no protected token" });
    expect([...h.stubs.values()].flat().reduce((n, s) => n + s.calls, 0)).toBe(before);
  });

  it("passes a token that is not protected", async () => {
    const req = kethRequest(h.token);
    if (req.message.token_transfer) req.message.token_transfer.source_token_address = pad32("0x00000000000000000000000000000000deadbeef");
    expect((await verdict(req)).body.reason).toBe("OK no protected token");
  });

  it("passes a non-EVM message from a chain outside every spec", async () => {
    const req = kethRequest(h.token);
    req.message.source_chain_selector = "16423721717087811551"; // Solana devnet
    req.message.sender = `0x${"ab".repeat(32)}`;
    if (req.message.token_transfer) req.message.token_transfer.source_token_address = `0x${"cd".repeat(32)}`;
    expect((await verdict(req)).body.reason).toBe("OK no protected token");
  });

  it("passes a stale status when the spec says fail_open", async () => {
    (h.token as { onStale: string }).onStale = "fail_open";
    h.both(HOME, (s) => {
      const l = s.state.ledgers.get(contractsOn(h.token, HOME).ledger);
      if (l !== undefined) l.stale = true;
    });
    expect((await verdict()).body.decision).toBe("PASS");
  });
});

describe("FAIL paths (definitive verdicts, HTTP 200)", () => {
  const setLedger = (chain: bigint, values: Record<string, unknown>): void => {
    h.both(chain, (s) => {
      const l = s.state.ledgers.get(contractsOn(h.token, chain).ledger);
      if (l !== undefined) Object.assign(l, values);
    });
  };

  it("TOKEN_BROKEN on the destination, quoting the breach reason and incident", async () => {
    setLedger(HOME, { status: 3, activeIncident: INCIDENT, breachReason: 2 });
    const res = await verdict();
    expect(res.body).toEqual({ decision: "FAIL", message_id: MESSAGE_ID, reason: "TOKEN_BROKEN kETH DEBIT_NOT_FOUND incident=0x9f3c..." });
    const log = failLog();
    expect(log).toMatchObject({ level: "warn", messageId: MESSAGE_ID, reasonCode: "TOKEN_BROKEN" });
    expect(log.evidence).toMatchObject({ token: "kETH", sourceTx: expect.stringMatching(/^0x4c0f/) as unknown });
  });

  it("TOKEN_BROKEN on the source chain", async () => {
    setLedger(ARB, { status: 3, epochReason: 6 });
    expect((await verdict()).body.reason).toBe("TOKEN_BROKEN kETH LOOP_DEFICIT");
  });

  it("TOKEN_QUARANTINED status", async () => {
    setLedger(HOME, { status: 4, activeIncident: INCIDENT, breachReason: 2 });
    expect((await verdict()).body.reason).toBe("TOKEN_QUARANTINED kETH DEBIT_NOT_FOUND incident=0x9f3c...");
  });

  it("TOKEN_RECOVERING status", async () => {
    setLedger(HOME, { status: 5, activeIncident: INCIDENT, breachReason: 5 });
    expect((await verdict()).body.reason).toBe("TOKEN_RECOVERING kETH DOUBLE_CREDIT incident=0x9f3c...");
  });

  it("STATUS_STALE under fail_closed", async () => {
    setLedger(ARB, { stale: true });
    expect((await verdict()).body).toMatchObject({ decision: "FAIL", reason: "STATUS_STALE kETH no fresh epoch, fail_closed" });
  });

  it("STATUS_STALE for UNKNOWN status", async () => {
    setLedger(HOME, { status: 0 });
    expect((await verdict()).body.reason).toBe("STATUS_STALE kETH no fresh epoch, fail_closed");
  });

  it("TOKEN_QUARANTINED when lanes are frozen on either chain", async () => {
    h.both(HOME, (s) => {
      const q = s.state.quarantines.get(contractsOn(h.token, HOME).quarantine);
      if (q !== undefined) q.frozen = true;
    });
    expect((await verdict()).body.reason).toBe("TOKEN_QUARANTINED kETH lanes frozen");
  });

  it("TOKEN_QUARANTINED when the sender is tainted on the source chain", async () => {
    h.both(ARB, (s) => s.state.quarantines.get(contractsOn(h.token, ARB).quarantine)?.tainted.add(SENDER.toLowerCase()));
    expect((await verdict()).body.reason).toBe("TOKEN_QUARANTINED kETH sender tainted");
  });

  it("AMOUNT_MISMATCH when the pool debit differs from the transfer", async () => {
    const res = await verdict(kethRequest(h.token, { amount: AMOUNT + 1n }));
    expect(res.body).toEqual({
      decision: "FAIL",
      message_id: MESSAGE_ID,
      reason: `AMOUNT_MISMATCH kETH debit=${AMOUNT.toString()} transfer=${(AMOUNT + 1n).toString()}`,
    });
    expect(failLog()).toMatchObject({ reasonCode: "AMOUNT_MISMATCH" });
  });

  it("SPEC_MISMATCH when the registry activated a different spec, without any ledger read", async () => {
    h.both(HOME, (s) => s.state.registries.set(h.token.registry.address, `0x${"77".repeat(32)}`));
    await h.cache.syncOnce();
    const before = [...h.stubs.values()].flat().reduce((n, s) => n + s.calls, 0);
    expect((await verdict()).body.reason).toBe("SPEC_MISMATCH kETH cached spec differs from active registry spec");
    expect([...h.stubs.values()].flat().reduce((n, s) => n + s.calls, 0)).toBe(before);
  });

  it("UNKNOWN_TOKEN when the registry has no active spec", async () => {
    h.both(HOME, (s) => s.state.registries.set(h.token.registry.address, ZERO32));
    await h.cache.syncOnce();
    expect((await verdict()).body.reason).toBe("UNKNOWN_TOKEN kETH no active spec in registry");
  });

  it("SPEC_MISMATCH for a destination chain the spec does not cover", async () => {
    const req = kethRequest(h.token);
    req.message.dest_chain_selector = "5009297550715157269";
    expect((await verdict(req)).body.reason).toBe("SPEC_MISMATCH kETH lane not in spec");
  });

  it("keeps a definitive FAIL when providers only disagree on a later step", async () => {
    setLedger(HOME, { status: 3 });
    h.stubs.get(ARB)?.[1].state.quarantines.get(contractsOn(h.token, ARB).quarantine)?.tainted.add(SENDER.toLowerCase());
    expect((await verdict()).body).toMatchObject({ decision: "FAIL", reason: "TOKEN_BROKEN kETH OK" });
  });
});

describe("PENDING paths (HTTP 503, the verifier retries)", () => {
  it("one provider errors on the source chain", async () => {
    const [, second] = h.stubs.get(ARB) ?? [];
    if (second) second.failure = "rpc-error";
    expectPending(await verdict(), /source status read failed/);
  });

  it("one provider answers HTTP 500 on the destination chain", async () => {
    const [first] = h.stubs.get(HOME) ?? [];
    if (first) first.failure = "http-500";
    expectPending(await verdict(), /destination status read failed/);
  });

  it("one provider is down (connection refused)", async () => {
    await h.stubs.get(HOME)?.[1].stop();
    expectPending(await verdict(), /destination status read failed/);
  });

  it("providers disagree on status", async () => {
    Object.assign(h.ledger(HOME, 1), { status: 3 });
    expectPending(await verdict(), /destination providers disagree/);
  });

  it("providers disagree on staleness", async () => {
    Object.assign(h.ledger(ARB, 0), { stale: true });
    expectPending(await verdict(), /source providers disagree/);
  });

  it("the source debit is not visible yet", async () => {
    h.both(ARB, (s) => {
      s.state.logs = [];
    });
    expectPending(await verdict(), /source debit not yet visible/);
  });

  it("only one provider sees the source debit", async () => {
    const [first] = h.stubs.get(ARB) ?? [];
    if (first) first.state.logs = [];
    expectPending(await verdict(), /providers disagree on sourceDebit/);
  });

  it("the debit belongs to another message id", async () => {
    h.both(ARB, (s) => {
      for (const l of s.state.logs) if (l.topics[3] !== undefined) l.topics[3] = `0x${"ee".repeat(32)}`;
    });
    expectPending(await verdict(), /source debit not yet visible/);
  });

  it("providers disagree on the sender taint while everything else passes", async () => {
    h.stubs.get(ARB)?.[0].state.quarantines.get(contractsOn(h.token, ARB).quarantine)?.tainted.add(SENDER.toLowerCase());
    expectPending(await verdict(), /providers disagree on senderTainted/);
  });

  it("providers disagree on frozen lanes", async () => {
    const q = h.stubs.get(HOME)?.[1].state.quarantines.get(contractsOn(h.token, HOME).quarantine);
    if (q) q.frozen = true;
    expectPending(await verdict(), /providers disagree on frozen/);
  });
});

describe("spec cache gating", () => {
  it("answers 503 until the first registry sync succeeds", async () => {
    await h.close();
    h = await startHarness({ syncNow: false });
    expectPending(await verdict(), /spec cache never synced/);
    expect((await fetch(`${h.url}/readyz`)).status).toBe(503);
    await h.cache.syncOnce();
    expect((await verdict()).status).toBe(200);
    expect((await fetch(`${h.url}/readyz`)).status).toBe(200);
  });

  it("stays unsynced when the two registry reads disagree", async () => {
    await h.close();
    h = await startHarness({ syncNow: false });
    h.stubs.get(HOME)?.[1].state.registries.set(h.token.registry.address, `0x${"77".repeat(32)}`);
    await h.cache.syncOnce();
    expectPending(await verdict(), /providers disagree on registry activeSpecHash/);
  });
});

describe("request validation (OpenAPI v1)", () => {
  it("rejects a body that is not an EvaluateRequest with 400", async () => {
    const req = kethRequest(h.token) as unknown as Record<string, unknown>;
    delete req.source_tx_hash;
    const res = await verdict(req);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source_tx_hash/);
  });

  it("rejects a selector sent as a JSON number", async () => {
    // Raw text: a JS number literal cannot even hold this selector, which is the point.
    const raw = JSON.stringify(kethRequest(h.token)).replace('"source_chain_selector":"3478487238524512106"', '"source_chain_selector":3478487238524512106');
    expect((await verdict(raw)).status).toBe(400);
  });

  it("rejects malformed JSON and unknown routes", async () => {
    expect((await verdict("{not json")).status).toBe(400);
    expect((await fetch(`${h.url}/v1/evaluate`)).status).toBe(405);
    expect((await fetch(`${h.url}/nope`)).status).toBe(404);
  });

  it("rejects a non-decimal amount", async () => {
    const req = kethRequest(h.token);
    if (req.message.token_transfer) req.message.token_transfer.amount = "1e18";
    expect((await verdict(req)).status).toBe(400);
  });
});

describe("observability", () => {
  it("exports latency and decisions by reason on /metrics, and /healthz", async () => {
    await verdict();
    await verdict(kethRequest(h.token, { amount: 1n }));
    const text = await (await fetch(`${h.url}/metrics`)).text();
    expect(text).toMatch(/judge_decisions_total\{decision="PASS",reason="OK"\} 1/);
    expect(text).toMatch(/judge_decisions_total\{decision="FAIL",reason="AMOUNT_MISMATCH"\} 1/);
    expect(text).toMatch(/judge_evaluate_duration_seconds_bucket\{le="0.3",outcome="PASS"\} 1/);
    expect(text).toMatch(/judge_spec_cache_synced\{token="kETH"\} 1/);
    expect(await (await fetch(`${h.url}/healthz`)).json()).toEqual({ status: "ok" });
  });
});
