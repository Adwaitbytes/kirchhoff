import { expect, test } from "@playwright/test";

const ROUTES = [
  "/",
  "/app",
  "/app/tokens/kETH",
  "/app/tokens/kETH?scenario=breach",
  "/app/tokens/kETH?scenario=stale",
  "/app/tokens/kBTC",
  "/lab",
  "/t/kETH",
  "/t/kBTC",
  "/app/ops",
  "/app/integrate",
  "/app/onboard",
  "/app/incidents/0x498d23bbcdc23cebcba86d96f97671a66b4fde6a32958611604b7c1a3436e1fa",
];

for (const route of ROUTES) {
  test(`no console errors or hydration mismatches on ${route}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1_000);
    expect(errors).toEqual([]);
  });
}
