import { describe, expect, it } from "vitest";
import {
  evmAddress,
  hookResponse,
  judge,
  parseHookRequest,
  protectedTransfer,
  type ParsedMessage,
  type Read,
  type ReadPair,
  type SourceDebitLookup,
  type SpecCacheEntry,
  type StatusRead,
  type TokenEvaluation,
} from "../src/judge-core.ts";
import { tokenId } from "../src/encoding.ts";
import { Reason, Status, type Hex } from "../src/types.ts";
import { ALICE, ARB, CANONICAL, HOME, POOL_ARB, REMOTE_ARB, hash, units } from "./fixtures.ts";

const ID = hash("ccip-msg");
const SPEC_HASH = hash("spec");
const conserved: StatusRead = { ok: true, status: Status.CONSERVED, delta: 0n, epochId: 4182n, stale: false, reason: Reason.OK };
const ok = <T>(value: T): Read<T> => ({ ok: true, value });
const both = <T>(value: T): ReadPair<T> => [ok(value), ok(value)];
const down: Read<never> = { ok: false, error: "timeout" };
const padded = (a: Hex): string => `0x${"0".repeat(24)}${a.slice(2)}`;

function token(over: Partial<TokenEvaluation> = {}): TokenEvaluation {
  return {
    symbol: "kETH",
    tokenId: tokenId("kETH"),
    amount: units(10n),
    cachedSpecHash: SPEC_HASH,
    activeSpecHash: SPEC_HASH,
    onStale: "fail_closed",
    source: [conserved, conserved],
    destination: [conserved, conserved],
    laneInSpec: true,
    frozen: both(false),
    senderTainted: both(false),
    sourceDebit: both<SourceDebitLookup>({ kind: "found", amount: units(10n) }),
    incidentId: null,
    ...over,
  };
}

const run = (t: TokenEvaluation | null, budgetExceeded = false) => judge({ messageId: ID, token: t, budgetExceeded });

function request(over: Record<string, unknown> = {}, message: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "v1",
    verifier_id: "kirchhoff-1",
    message_id: ID,
    source_tx_hash: hash("tx"),
    source_block_number: 10,
    finalized_block_number: 12,
    block_depth: 2,
    message: {
      version: 1,
      source_chain_selector: ARB.toString(),
      dest_chain_selector: HOME.toString(),
      sender: padded(ALICE),
      receiver: padded(ALICE),
      token_transfer: {
        version: 1,
        amount: units(10n).toString(),
        source_pool_address: padded(POOL_ARB),
        source_token_address: padded(REMOTE_ARB),
        dest_token_address: padded(CANONICAL),
        token_receiver: padded(ALICE),
        extra_data: "0x",
      },
      ...message,
    },
    ...over,
  };
}

describe("evmAddress", () => {
  it("unpads 32-byte hook addresses and accepts plain 20-byte ones", () => {
    expect(evmAddress(padded(ALICE))).toBe(ALICE);
    expect(evmAddress(ALICE.toUpperCase().replace("0X", "0x"))).toBe(ALICE);
  });
  it.each(["0x", "nothex", `0x${"1".repeat(64)}`, `0x${"0".repeat(128)}`, "0x1234"])("rejects %s", (v) => {
    expect(evmAddress(v)).toBeNull();
  });
});

describe("parseHookRequest (policy hook v1)", () => {
  it("normalizes selectors from decimal strings and addresses from padded hex", () => {
    const r = parseHookRequest(request());
    expect(r).toEqual({
      ok: true,
      message: {
        messageId: ID,
        sourceTxHash: hash("tx"),
        srcChain: ARB,
        dstChain: HOME,
        sender: ALICE,
        receiver: ALICE,
        transfer: { amount: units(10n), sourceToken: REMOTE_ARB, sourcePool: POOL_ARB, destToken: CANONICAL, receiver: ALICE },
      },
    });
  });
  it("keeps selectors above 2^63 exact", () => {
    const r = parseHookRequest(request({}, { source_chain_selector: "16015286601757825753" }));
    expect(r.ok && r.message.srcChain).toBe(16015286601757825753n);
  });
  it("treats a missing or null token_transfer as data-only", () => {
    const { token_transfer: _t, ...bare } = request().message as Record<string, unknown>;
    expect(parseHookRequest({ ...request(), message: bare })).toMatchObject({ ok: true, message: { transfer: null } });
    expect(parseHookRequest(request({}, { token_transfer: null }))).toMatchObject({ ok: true, message: { transfer: null } });
  });
  it.each([
    ["a non-object body", 7, /body/],
    ["an array body", [], /body/],
    ["another schema version", request({ schema_version: "v2" }), /schema_version/],
    ["a missing message", request({ message: "x" }), /message must/],
    ["a numeric selector", request({}, { source_chain_selector: 5 }), /source_chain_selector must be a string/],
    ["a negative selector", request({}, { dest_chain_selector: "-1" }), /uint64/],
    ["a selector above uint64", request({}, { dest_chain_selector: (1n << 64n).toString() }), /uint64/],
    ["a non-EVM sender", request({}, { sender: `0x${"1".repeat(64)}` }), /sender is not an EVM address/],
    ["a bad message id", request({ message_id: "0x12" }), /message_id/],
    ["a malformed token_transfer", request({}, { token_transfer: [] }), /token_transfer/],
    ["a non-decimal amount", request({}, { token_transfer: { amount: "1e18" } }), /amount must be a decimal/],
  ])("rejects %s", (_label, body, pattern) => {
    const r = parseHookRequest(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(pattern);
  });
});

describe("protectedTransfer (step 3 mapping)", () => {
  const cache: SpecCacheEntry[] = [
    { symbol: "kETH", tokenId: tokenId("kETH"), addresses: new Map([[HOME, CANONICAL], [ARB, REMOTE_ARB.toUpperCase().replace("0X", "0x") as Hex]]) },
  ];
  const parsed = (body: Record<string, unknown>): ParsedMessage => {
    const r = parseHookRequest(body);
    if (!r.ok) throw new Error(r.error);
    return r.message;
  };
  it("maps the source token on the source chain", () => {
    expect(protectedTransfer(parsed(request()), cache)).toMatchObject({ amount: units(10n), entry: { symbol: "kETH" } });
  });
  it("is null for data-only messages and unprotected tokens", () => {
    expect(protectedTransfer(parsed(request({}, { token_transfer: null })), cache)).toBeNull();
    expect(protectedTransfer(parsed(request({}, { source_chain_selector: "1" })), cache)).toBeNull();
  });
});

describe("judge: PRD section 9 steps 3 to 9 with INTERFACES.md revision 2", () => {
  it("step 9: PASS OK with the destination view", () => {
    expect(run(token())).toEqual({
      decision: "PASS",
      reason: Reason.OK,
      symbol: "kETH",
      note: "CONSERVED delta=0 epoch=4182",
      reasonString: "OK kETH CONSERVED delta=0 epoch=4182",
    });
  });

  it("step 4: PASS for a message with no protected token", () => {
    expect(run(null)).toMatchObject({ decision: "PASS", reason: Reason.OK, symbol: null, reasonString: "OK no protected token" });
  });

  it("step 3: UNKNOWN_TOKEN when the registry has no active spec", () => {
    expect(run(token({ activeSpecHash: null }))).toMatchObject({ decision: "FAIL", reason: Reason.UNKNOWN_TOKEN });
  });

  it("step 3: SPEC_MISMATCH when the cache is behind the registry, compared case-insensitively", () => {
    expect(run(token({ activeSpecHash: hash("newer") }))).toMatchObject({ decision: "FAIL", reason: Reason.SPEC_MISMATCH });
    expect(run(token({ activeSpecHash: SPEC_HASH.toUpperCase().replace("0X", "0x") as Hex })).decision).toBe("PASS");
  });

  it("an exhausted time budget is PENDING, not FAIL", () => {
    expect(run(token(), true)).toMatchObject({ decision: "PENDING", reason: Reason.PENDING_ATTESTATION });
  });

  describe("step 5: two providers per chain are PENDING when they cannot agree", () => {
    const failed: StatusRead = { ok: false, error: "timeout" };
    it.each([
      ["source error", { source: [conserved, failed] as const }, "source status read failed"],
      ["source first error", { source: [failed, conserved] as const }, "source status read failed"],
      ["destination error", { destination: [conserved, failed] as const }, "destination status read failed"],
      ["status disagreement", { source: [conserved, { ...conserved, status: Status.BROKEN }] as const }, "disagree"],
      ["staleness disagreement", { destination: [conserved, { ...conserved, stale: true }] as const }, "disagree"],
    ])("%s", (_label, over, note) => {
      const r = run(token(over));
      expect(r).toMatchObject({ decision: "PENDING", reason: Reason.PENDING_ATTESTATION });
      expect(r.note).toContain(note);
    });
  });

  describe("step 6: status", () => {
    const at = (status: Status, extra: Partial<Extract<StatusRead, { ok: true }>> = {}): StatusRead => ({ ...conserved, status, ...extra });
    it.each([
      [Status.BROKEN, Reason.TOKEN_BROKEN],
      [Status.QUARANTINED, Reason.TOKEN_QUARANTINED],
      [Status.RECOVERING, Reason.TOKEN_RECOVERING],
    ] as const)("status %i fails with %i", (status, reason) => {
      const read = at(status, { reason: Reason.DEBIT_NOT_FOUND });
      expect(run(token({ destination: [read, read] }))).toMatchObject({ decision: "FAIL", reason });
    });
    it("quotes the breach reason and incident", () => {
      const read = at(Status.BROKEN, { reason: Reason.DEBIT_NOT_FOUND });
      const r = run(token({ source: [read, read], incidentId: hash("incident") }));
      expect(r.reasonString).toBe(`TOKEN_BROKEN kETH DEBIT_NOT_FOUND incident=${hash("incident").slice(0, 6)}...`);
    });
    it("stale and UNKNOWN fail closed by default", () => {
      const stale = at(Status.CONSERVED, { stale: true });
      expect(run(token({ destination: [stale, stale] })).reason).toBe(Reason.STATUS_STALE);
      const unknown = at(Status.UNKNOWN);
      expect(run(token({ source: [unknown, unknown] })).reason).toBe(Reason.STATUS_STALE);
    });
    it("fail_open lets stale and UNKNOWN through to the next steps", () => {
      const stale = at(Status.DRIFT, { stale: true });
      const unknown = at(Status.UNKNOWN);
      const r = run(token({ onStale: "fail_open", source: [unknown, unknown], destination: [stale, stale] }));
      expect(r).toMatchObject({ decision: "PASS", note: "DRIFT delta=0 epoch=4182" });
    });
  });

  it("step 3: a lane outside the spec is a definitive SPEC_MISMATCH", () => {
    expect(run(token({ laneInSpec: false }))).toMatchObject({ decision: "FAIL", reason: Reason.SPEC_MISMATCH, note: "lane not in spec" });
  });

  it("step 7: frozen lanes and tainted senders fail TOKEN_QUARANTINED", () => {
    expect(run(token({ frozen: both(true) }))).toMatchObject({ decision: "FAIL", reason: Reason.TOKEN_QUARANTINED, note: "lanes frozen" });
    expect(run(token({ senderTainted: both(true) }))).toMatchObject({ reason: Reason.TOKEN_QUARANTINED, note: "sender tainted" });
  });

  it("step 7: an agreed flag fails even when the other flag is disputed", () => {
    expect(run(token({ frozen: [ok(true), down], senderTainted: both(true) }))).toMatchObject({ decision: "FAIL", note: "sender tainted" });
    expect(run(token({ frozen: both(true), senderTainted: [ok(false), ok(true)] }))).toMatchObject({ decision: "FAIL", note: "lanes frozen" });
  });

  it.each([
    ["frozen disagreement", { frozen: [ok(false), ok(true)] as const }, "frozen"],
    ["frozen error", { frozen: [down, ok(false)] as const }, "frozen"],
    ["taint error", { senderTainted: [ok(false), down] as const }, "senderTainted"],
    ["debit error", { sourceDebit: [ok<SourceDebitLookup>({ kind: "missing" }), down] as const }, "sourceDebit"],
    ["debit found vs missing", { sourceDebit: [ok<SourceDebitLookup>({ kind: "found", amount: 1n }), ok<SourceDebitLookup>({ kind: "missing" })] as const }, "sourceDebit"],
    ["debit missing vs found", { sourceDebit: [ok<SourceDebitLookup>({ kind: "missing" }), ok<SourceDebitLookup>({ kind: "found", amount: 1n })] as const }, "sourceDebit"],
    ["debit amounts differ", { sourceDebit: [ok<SourceDebitLookup>({ kind: "found", amount: 1n }), ok<SourceDebitLookup>({ kind: "found", amount: 2n })] as const }, "sourceDebit"],
  ])("steps 7 and 8: %s is PENDING", (_label, over, field) => {
    const r = run(token(over));
    expect(r).toMatchObject({ decision: "PENDING", reason: Reason.PENDING_ATTESTATION });
    expect(r.note).toBe(`providers disagree on ${field}, retry`);
  });

  it("step 8: a missing source debit is PENDING; a different amount is a definitive AMOUNT_MISMATCH", () => {
    expect(run(token({ sourceDebit: both<SourceDebitLookup>({ kind: "missing" }) }))).toMatchObject({
      decision: "PENDING",
      reasonString: "PENDING_ATTESTATION kETH source debit not yet visible, retry",
    });
    expect(run(token({ sourceDebit: both<SourceDebitLookup>({ kind: "found", amount: 1n }) }))).toMatchObject({
      decision: "FAIL",
      reason: Reason.AMOUNT_MISMATCH,
    });
  });

  it("caps the reason string at 256 characters", () => {
    expect(run(token({ symbol: "k".repeat(300) })).reasonString).toHaveLength(256);
  });
});

describe("hookResponse", () => {
  it("answers verdicts with HTTP 200 and PENDING with HTTP 503", () => {
    expect(hookResponse(ID, run(token()))).toEqual({
      status: 200,
      body: { decision: "PASS", reason: "OK kETH CONSERVED delta=0 epoch=4182", message_id: ID },
    });
    expect(hookResponse(ID, run(token({ frozen: both(true) }))).status).toBe(200);
    expect(hookResponse(ID, run(token(), true))).toEqual({
      status: 503,
      body: { error: "PENDING_ATTESTATION kETH time budget exceeded, retry" },
    });
  });
});
