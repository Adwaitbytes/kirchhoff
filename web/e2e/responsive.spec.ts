import { expect, test } from "@playwright/test";
import { noHorizontalScroll } from "./helpers";

const ROUTES = ["/", "/app/tokens/kETH", "/lab", "/t/kETH", "/app/ops", "/app/integrate", "/app/onboard", "/app/tokens/kETH?scenario=breach"];

for (const route of ROUTES) {
  test(`no horizontal scroll and no console errors on ${route}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    const { scrollWidth, clientWidth } = await noHorizontalScroll(page);
    expect(scrollWidth, `content wider than viewport on ${route}`).toBeLessThanOrEqual(clientWidth + 1);
    expect(errors).toEqual([]);
  });
}
