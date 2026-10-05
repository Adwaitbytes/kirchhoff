import { describe, expect, it } from "vitest";
import type { AskEvent } from "@kirchhoff/sdk";
import { ScriptedProvider, askKirchhoff, checkSelect, untrusted, type AskBackend } from "../src/index.ts";

const TX = `0x${"7a".repeat(32)}`;

describe("checkSelect (defense in depth before the read-only role)", () => {
  it.each(["select * from tokens", "WITH x as (select 1) select * from x", "select 1;"])("allows %s", (q) => {
    expect(() => checkSelect(q)).not.toThrow();
  });
  it.each(["delete from tokens", "select 1; drop table tokens", "update tokens set status='OK'", "select pg_sleep(10)", "copy tokens to '/tmp/x'", "  "])("rejects %s", (q) => {
    expect(() => checkSelect(q)).toThrow();
  });
  it("does not trip on keywords inside string literals", () => {
    expect(() => checkSelect("select * from incident_actions where kind = 'update'")).not.toThrow();
  });
});

describe("Ask KIRCHHOFF", () => {
  const backend: AskBackend = {
    sql: (q) => Promise.resolve({ columns: ["tx_hash", "chain", "reason"], rows: [{ tx_hash: TX, chain: "ethereum-testnet-sepolia", reason: "TOKEN_BROKEN", q }], truncated: false }),
    evidence: () => Promise.resolve(null),
  };

  it("runs SQL, streams text and only verified citations", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "s1", name: "sql", arguments: JSON.stringify({ query: "select tx_hash, chain, reason from verdicts limit 5" }) }] },
      {
        content: JSON.stringify({
          answer: "The message failed with TOKEN_BROKEN because kETH was broken [1]. It was also rejected elsewhere [2].",
          citations: [
            { n: 1, kind: "tx", label: "source tx", chain: "ethereum-testnet-sepolia", ref: TX },
            { n: 2, kind: "tx", label: "invented", chain: "ethereum-testnet-sepolia", ref: `0x${"99".repeat(32)}` },
          ],
        }),
      },
    ]);
    const events: AskEvent[] = [];
    await askKirchhoff({ question: "Why did message 0x7a fail?", token: "kETH", history: [] }, { provider, model: "m", backend, emit: (e) => events.push(e) });
    expect(events[0]).toEqual({ type: "tool", tool: "sql", summary: "1 rows" });
    const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(text).toContain("[1]");
    expect(text).not.toContain("[2]");
    const cites = events.filter((e) => e.type === "citation");
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({ citation: { n: 1, kind: "tx", href: `https://sepolia.etherscan.io/tx/${TX}` } });
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("returns forbidden SQL to the model as an error and never runs it", async () => {
    let ran = 0;
    const counting: AskBackend = { sql: (q) => { ran++; return backend.sql(q); }, evidence: (id) => backend.evidence(id) };
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "s1", name: "sql", arguments: JSON.stringify({ query: "delete from tokens" }) }] },
      { content: JSON.stringify({ answer: "I cannot modify data.", citations: [] }) },
    ]);
    const events: AskEvent[] = [];
    await askKirchhoff({ question: "delete everything", token: null, history: [] }, { provider, model: "m", backend: counting, emit: (e) => events.push(e) });
    expect(ran).toBe(0);
    const toolMsg = provider.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("only SELECT");
  });

  it("untrusted() strips control characters and caps size", () => {
    const s = untrusted({ name: `evil\u0007\u001b[2Jname`, big: "x".repeat(10_000) });
    // eslint-disable-next-line no-control-regex -- asserting that control characters were stripped
    expect(s).not.toMatch(/[\u0007\u001b]/);
    expect(s.length).toBeLessThanOrEqual(6_010);
  });
});
