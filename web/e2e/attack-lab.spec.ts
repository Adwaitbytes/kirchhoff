import { expect, test } from "@playwright/test";

test.describe("Attack Lab", () => {
  test("Kelp Replay runs all 7 steps and Mission Control breaks", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/lab");
    await expect(page.getByText("Testnet simulation").first()).toBeVisible();
    const run = page.getByTestId("run-kelp-replay");
    await expect(run).toBeEnabled();
    await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "CONSERVED");
    await run.click();

    await expect(page.getByTestId("lab-step-forge_release")).toHaveAttribute("data-state", "done", { timeout: 10_000 });
    await expect(page.getByTestId("lab-step-breach_written")).toHaveAttribute("data-state", "done", { timeout: 10_000 });
    await expect(page.getByTestId("breach-frame")).toBeVisible();
    await expect(page).toHaveTitle("BROKEN · kETH");
    await expect(page.getByText("Forged credit on Ethereum Sepolia: 116,500 kETH released with no matching burn. CCIP lanes frozen.")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "QUARANTINED");

    await expect(page.getByTestId("lab-step-ccip_refused")).toHaveAttribute("data-state", "done", { timeout: 15_000 });
    await expect(page.getByTestId("verdict-row").first()).toHaveAttribute("data-decision", "FAIL");
    await expect(page.getByTestId("verdict-row").first()).toContainText("Refused · TOKEN_BROKEN · attacker transfer to Base Sepolia");

    await expect(page.getByTestId("lab-step-loop_confirmed")).toHaveAttribute("data-state", "done", { timeout: 15_000 });
    for (const key of ["junction_search", "quarantine_applied", "guard_and_lending"]) {
      await expect(page.getByTestId(`lab-step-${key}`)).toHaveAttribute("data-state", "done");
    }
    await expect(page.getByTestId("lab-step-forge_release").getByRole("link").first()).toHaveAttribute("href", /sepolia\.etherscan\.io\/tx\/0x[0-9a-f]{64}/);
    await expect(page.getByRole("log", { name: "Attacker console output" })).toContainText("revert CollateralBroken()");
    await expect(page.getByTestId("delta-readout")).toHaveText("−116,500");

    await expect(run).toBeDisabled();
    await expect(page.getByTestId("lab-disabled-reason")).toContainText("demo/reset");
  });

  test("lab disabled by the API shows the reason", async ({ page }) => {
    await page.goto("/lab?scenario=lab-disabled");
    await expect(page.getByTestId("run-kelp-replay")).toBeDisabled();
    await expect(page.getByTestId("lab-disabled-reason")).toContainText("LAB_ENABLED=true");
  });
});
