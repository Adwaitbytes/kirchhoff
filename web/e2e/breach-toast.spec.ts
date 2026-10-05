import { expect, test, type Locator } from "@playwright/test";

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error("element has no box");
  return b;
}

function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

for (const vp of [
  { width: 1920, height: 1080, stage: true },
  { width: 1440, height: 900, stage: false },
]) {
  test.describe(`breach toast at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("never covers the ledger, verdicts or meter in Mission Control", async ({ page }) => {
      await page.goto(`/app/tokens/kETH?scenario=breach&stage=${vp.stage ? 1 : 0}`);
      const toast = page.getByTestId("breach-toast");
      await expect(toast).toBeVisible();
      await expect(toast).toContainText("Forged credit on Ethereum Sepolia: 116,500 kETH released with no matching burn. CCIP lanes frozen.");
      const t = await box(toast);
      for (const id of ["ledger-title", "stream-title", "meter-title", "history-title", "circuit-title"]) {
        const panel = page.locator(`section[aria-labelledby="${id}"]`);
        expect(intersects(t, await box(panel)), `toast overlaps ${id}`).toBe(false);
      }
    });

    test("never covers the verdicts or meter in the Attack Lab", async ({ page }) => {
      test.setTimeout(60_000);
      await page.goto(`/lab?stage=${vp.stage ? 1 : 0}`);
      await page.getByTestId("run-kelp-replay").click();
      const toast = page.getByTestId("breach-toast");
      await expect(toast).toBeVisible({ timeout: 15_000 });
      const t = await box(toast);
      for (const id of ["stream-title", "meter-title", "circuit-title"]) {
        expect(intersects(t, await box(page.locator(`section[aria-labelledby="${id}"]`))), `toast overlaps ${id}`).toBe(false);
      }
      for (const key of ["forge_release", "breach_written"]) {
        expect(intersects(t, await box(page.getByTestId(`lab-step-${key}`)))).toBe(false);
      }
    });
  });
}
