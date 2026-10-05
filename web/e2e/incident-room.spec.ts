import { expect, test } from "@playwright/test";

test.describe("Incident Room", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/app/tokens/kETH?scenario=breach");
    await page.getByRole("link", { name: "Open Incident Room" }).first().click();
    await expect(page.getByTestId("incident-header")).toBeVisible();
  });

  test("shows evidence, the AI narrative with citations and containment", async ({ page }) => {
    await expect(page.getByTestId("incident-header")).toContainText("SEV1");
    await expect(page.getByTestId("evidence-timeline")).toContainText("No matching Burned debit on Arbitrum Sepolia");
    const narrative = page.getByTestId("ai-narrative");
    await expect(narrative).toContainText("AI summary. Verify against evidence.");
    await expect(narrative.getByRole("link").first()).toHaveAttribute("href", /etherscan|arbiscan|basescan/);
    await expect(page.getByTestId("held-messages")).toBeVisible();
    await expect(page.getByTestId("replay-after-recovery")).toBeDisabled();
  });

  test("Resolve via Safe prepares resolve(tokenId, incidentId) calldata", async ({ page }) => {
    await page.getByTestId("resolve-incident").click();
    const calldata = page.getByTestId("resolve-calldata");
    await expect(calldata).toBeVisible();
    // resolve(bytes32,bytes32) selector followed by two 32-byte words.
    await expect(calldata).toHaveText(/^0x[0-9a-f]{8}[0-9a-f]{128}$/);
    await expect(page.getByRole("link", { name: /Open in Safe/ })).toHaveAttribute("href", /app\.safe\.global/);
  });

  test("exports a Markdown postmortem", async ({ page }) => {
    await page.getByTestId("export-postmortem").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-markdown").click()]);
    expect(download.suggestedFilename()).toMatch(/\.md$/);
  });
});
