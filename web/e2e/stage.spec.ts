import { expect, test } from "@playwright/test";
import { freezeClock } from "./helpers";

for (const theme of ["dark", "light"] as const) {
  test(`stage mode snapshot, breach, ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
    await freezeClock(page);
    await page.goto(`/app/tokens/kETH?stage=1&theme=${theme}&scenario=breach`);
    await expect(page.locator("html")).toHaveAttribute("data-stage", "1");
    await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "QUARANTINED");
    await expect(page.getByTestId("verdict-row").first()).toBeVisible();
    await page.clock.runFor(1_500);
    await expect(page).toHaveScreenshot(`mission-control-stage-${theme}.png`, { fullPage: false, mask: [page.getByTestId("staleness")] });
  });

  test(`stage mode snapshot, conserved, ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
    await freezeClock(page);
    await page.goto(`/app/tokens/kETH?stage=1&theme=${theme}`);
    await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "CONSERVED");
    await expect(page.getByTestId("verdict-row").first()).toBeVisible();
    await expect(page).toHaveScreenshot(`mission-control-stage-conserved-${theme}.png`, { fullPage: false, mask: [page.getByTestId("staleness")] });
  });
}
