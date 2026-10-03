import { afterEach, describe, expect, it } from "vitest";
import { ARB, HOME, kethRequest, post, startHarness, type Harness } from "./helpers/harness.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("2 s time budget", () => {
  it("answers 503 at the budget when a provider hangs, instead of holding the verifier's call", async () => {
    h = await startHarness({ budgetMs: 2000 });
    const hung = h.stubs.get(ARB)?.[0];
    if (hung) hung.failure = "hang";
    const res = await post(h.url, kethRequest(h.token));
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("PENDING_ATTESTATION kETH time budget exceeded, retry");
    expect(res.ms).toBeGreaterThanOrEqual(1950);
    expect(res.ms).toBeLessThan(2400);
  });

  it("honors a configured budget below the RPC latency", async () => {
    h = await startHarness({ budgetMs: 150 });
    h.both(HOME, (s) => {
      s.delayMs = 400;
    });
    const res = await post(h.url, kethRequest(h.token));
    expect(res.status).toBe(503);
    expect(res.ms).toBeLessThan(400);
  });

  it("still answers a definitive registry FAIL when RPC is slow, because step 3 needs no read", async () => {
    h = await startHarness({ budgetMs: 150 });
    h.both(HOME, (s) => s.state.registries.set(h?.token.registry.address ?? "", `0x${"77".repeat(32)}`));
    await h.cache.syncOnce();
    h.both(ARB, (s) => {
      s.failure = "hang";
    });
    const res = await post(h.url, kethRequest(h.token));
    expect(res.status).toBe(200);
    expect(res.body.reason).toMatch(/^SPEC_MISMATCH kETH/);
  });

  it("answers well inside the budget on the happy path", async () => {
    h = await startHarness();
    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) times.push((await post(h.url, kethRequest(h.token))).ms);
    expect(Math.max(...times)).toBeLessThan(300);
  });
});
