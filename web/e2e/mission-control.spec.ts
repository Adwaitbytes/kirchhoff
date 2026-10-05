import { expect, test } from "@playwright/test";

test.describe("Mission Control", () => {
  test("shows a conserved token with live verdicts", async ({ page }) => {
    await page.goto("/app/tokens/kETH");
    const pill = page.getByTestId("status-pill");
    await expect(pill).toHaveAttribute("data-status", "CONSERVED");
    await expect(pill).toContainText("Δ 0 kETH");
    await expect(page.getByTestId("delta-readout")).toHaveText("0");
    await expect(page.getByTestId("circuit-map")).toBeVisible();
    await expect(page.getByRole("button", { name: /Arbitrum Sepolia: .* Open ledger/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Home escrow on Ethereum Sepolia/ })).toBeVisible();

    const rows = page.getByTestId("verdict-row");
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toHaveAttribute("data-decision", "PASS");
    const before = await rows.first().textContent();
    // The fixture world settles a CCIP transfer every 9s; a fresh PASS lands on top.
    await expect.poll(async () => rows.first().textContent(), { timeout: 20_000 }).not.toBe(before);
  });

  test("every number links to an explorer or an onchain read", async ({ page }) => {
    await page.goto("/app/tokens/kETH");
    const delta = page.getByTestId("delta-readout").locator("xpath=ancestor::a[1]");
    await expect(delta).toHaveAttribute("href", /sepolia\.etherscan\.io\/address\/0x[0-9a-fA-F]{40}#readContract/);
    const pill = page.getByTestId("status-pill").locator("xpath=ancestor::a[1]");
    await expect(pill).toHaveAttribute("href", /#readContract$/);
  });

  test("wire hover lists recent transfers and a chain opens its ledger drawer", async ({ page }) => {
    await page.goto("/app/tokens/kETH");
    await page.getByTestId("wire-weakbridge").hover();
    await expect(page.getByRole("dialog", { name: /Last \d+ transfers on WeakBridge/ })).toBeVisible();
    await page.getByRole("button", { name: /Base Sepolia: .* Open ledger/ }).click();
    const drawer = page.getByRole("dialog", { name: "Base Sepolia ledger" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Verify onchain" }).click();
    await expect(drawer.getByRole("status")).toContainText("statusOf: CONSERVED");
  });

  test("Δ history has a data table toggle", async ({ page }) => {
    await page.goto("/app/tokens/kETH");
    await page.getByRole("button", { name: "Table" }).click();
    await expect(page.getByRole("table", { name: /Δ per epoch/ })).toBeVisible();
  });

  test("stale state dims panels and names the stale policy", async ({ page }) => {
    await page.goto("/app/tokens/kETH?scenario=stale");
    await expect(page.getByText(/Last epoch \d+m \d+s ago\. Verdicts follow the token's stale policy\./)).toBeVisible();
  });

  test("RPC error names the failing chain and the rest stays live", async ({ page }) => {
    await page.goto("/app/tokens/kETH?scenario=rpc-error");
    await expect(page.getByRole("alert").filter({ hasText: "Base Sepolia RPC error" })).toBeVisible();
    await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "CONSERVED");
  });

  test("API outage shows an inline banner, never fake numbers", async ({ page }) => {
    await page.goto("/app/tokens/kETH?scenario=api-down");
    await expect(page.getByRole("alert").filter({ hasText: "KIRCHHOFF API unreachable" })).toBeVisible();
    await expect(page.getByTestId("delta-readout")).toHaveCount(0);
  });

  test("empty state invites onboarding", async ({ page }) => {
    await page.goto("/app?scenario=empty");
    await expect(page.getByText("No protected tokens yet. Onboard your first token.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Onboard a token" }).first()).toBeVisible();
  });

  test("loading state uses skeletons, never a spinner on Δ", async ({ page }) => {
    await page.goto("/app/tokens/kETH?scenario=loading");
    await expect(page.locator(".skeleton").first()).toBeVisible();
    await expect(page.getByTestId("delta-readout")).toHaveCount(0);
    await expect(page.getByRole("progressbar")).toHaveCount(0);
  });

  test("breach state frames the app in red and deep links to the Incident Room", async ({ page }) => {
    await page.goto("/app/tokens/kETH?scenario=breach");
    await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "QUARANTINED");
    await expect(page.getByTestId("breach-frame")).toBeVisible();
    await expect(page).toHaveTitle("BROKEN · kETH");
    await expect(page.getByTestId("claims-overflow")).toBeVisible();
    await expect(page.getByTestId("delta-readout")).toHaveText("−116,500");
    const fail = page.getByTestId("verdict-row").filter({ hasText: "Refused · TOKEN_BROKEN · attacker transfer to Base Sepolia" });
    await expect(fail).toBeVisible();
    await page.getByRole("link", { name: "Open Incident Room" }).first().click();
    await expect(page.getByTestId("incident-header")).toBeVisible();
  });

  test("replays the last incident read-only from recorded evidence", async ({ page }) => {
    await page.goto("/app/tokens/kETH?scenario=breach");
    await page.getByTestId("replay-last-incident").click();
    const replay = page.getByTestId("incident-replay");
    await expect(replay).toBeVisible();
    await expect(replay).toContainText("Forged credit lands");
    await page.getByRole("slider", { name: "Replay position" }).focus();
    await page.keyboard.press("End");
    await expect(replay).toContainText("QUARANTINED");
    await expect(replay.getByRole("link").first()).toHaveAttribute("href", /etherscan|arbiscan|basescan/);
  });

  test("replay is disabled when no incident was ever recorded", async ({ page }) => {
    await page.goto("/app/tokens/kETH");
    await expect(page.getByTestId("replay-last-incident")).toBeDisabled();
  });
});

test.describe("Spec proposal alert", () => {
  for (const route of ["/app/tokens/kETH?scenario=spec-pending", "/t/kETH?scenario=spec-pending"]) {
    test(`shows a pending spec change with diff and timelock on ${route}`, async ({ page }) => {
      await page.goto(route);
      const alert = page.getByTestId("spec-proposal-alert");
      await expect(alert).toBeVisible();
      await expect(alert).toContainText("loosen");
      await expect(page.getByTestId("spec-diff")).toContainText("rules.loop.tolerance_wei");
      await expect(page.getByTestId("spec-timelock")).toContainText(/activates in \d+m/);
    });
  }

  test("no alert when nothing is pending", async ({ page }) => {
    await page.goto("/app/tokens/kETH");
    await expect(page.getByTestId("status-pill")).toBeVisible();
    await expect(page.getByTestId("spec-proposal-alert")).toHaveCount(0);
  });
});

test.describe("No epoch yet", () => {
  test("Mission Control says No epoch yet instead of a 1970 age", async ({ page }) => {
    await page.goto("/app/tokens/kETH?scenario=no-epoch");
    await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "UNKNOWN");
    await expect(page.getByTestId("epoch-none")).toHaveText("No epoch yet");
    await expect(page.getByTestId("no-epoch-banner")).toContainText("No epoch recorded yet. Verdicts follow the token's stale policy (fail closed).");
    await expect(page.getByTestId("delta-pending")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/\d{4,}h \d+m/);
  });

  test("status page, badge and landing chip use the same wording", async ({ page, request }) => {
    await page.goto("/t/kETH?scenario=no-epoch");
    await expect(page.getByTestId("status-hero")).toContainText("no epoch recorded yet");
    await expect(page.getByTestId("no-epoch-banner")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/\d{4,}h \d+m/);
    await page.goto("/?scenario=no-epoch");
    await expect(page.getByTestId("landing-live-status")).toContainText("no epoch yet");
    const svg = await (await request.get("/t/kETH/badge.svg")).text();
    expect(svg).toContain("<svg");
  });
});
