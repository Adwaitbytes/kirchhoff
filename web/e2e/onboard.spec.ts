import { expect, test } from "@playwright/test";

test.describe("Onboarding", () => {
  test("auto backtest runs once every line has evidence, and the Scout feeds the draft", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/app/onboard");
    await page.getByRole("button", { name: "Trace the wiring" }).click();
    await expect(page.getByRole("button", { name: "Review the draft" })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole("button", { name: "Review the draft" }).click();

    const auto = page.getByTestId("auto-backtest");
    await expect(auto).toContainText("Waiting on evidence: Line 14");
    await expect(page.getByTestId("approve-spec")).toBeDisabled();

    const scout = page.getByTestId("scout-panel");
    await expect(scout).toContainText("Scout finding. Verify the evidence.");
    await expect(scout.getByTestId("scout-proposal")).toHaveCount(2);
    await scout.getByRole("button", { name: "Add to draft" }).click();
    await expect(scout.getByRole("button", { name: "Added as issuer lines" })).toBeDisabled();

    // Removing the only line without evidence lets the backtest run on its own.
    await page.getByTestId("remove-line").first().click();
    await expect(auto).toContainText("History conserves", { timeout: 10_000 });
    await expect(page.getByTestId("approve-spec")).toBeEnabled();

    await auto.getByRole("button", { name: "Full backtest" }).click();
    await expect(page.getByText("Zero breaches across every chain in range.")).toBeVisible();
  });
});
