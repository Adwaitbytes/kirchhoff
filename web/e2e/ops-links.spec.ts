import { expect, test } from "@playwright/test";

test("every Verifier Ops figure links to its source or is marked not public", async ({ page }) => {
  await page.goto("/app/ops");
  await expect(page.getByTestId("ops-latency")).toBeVisible();
  const figures = page.locator("[data-figure]");
  const n = await figures.count();
  expect(n).toBeGreaterThan(10);
  for (let i = 0; i < n; i += 1) {
    const f = figures.nth(i);
    const linked = await f.evaluate((el) => el.closest("a[href]") !== null);
    const marked = await f.evaluate((el) => el.hasAttribute("data-not-public"));
    expect(linked || marked, `figure ${i} "${await f.innerText()}" has no source`).toBe(true);
  }
});
