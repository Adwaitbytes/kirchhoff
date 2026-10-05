import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ROUTES = [
  "/",
  "/app/tokens/kETH",
  "/app/tokens/kETH?scenario=breach",
  "/app/tokens/kETH?scenario=stale",
  "/app/tokens/kETH?scenario=spec-pending",
  "/lab",
  "/t/kETH",
  "/app/ops",
  "/app/integrate",
  "/app/onboard",
  "/app/incidents/0x498d23bbcdc23cebcba86d96f97671a66b4fde6a32958611604b7c1a3436e1fa",
];

for (const theme of ["dark", "light"] as const) {
  for (const route of ROUTES) {
    test(`WCAG 2.2 AA: no serious or critical violations on ${route} (${theme})`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await page.goto(`${route}${route.includes("?") ? "&" : "?"}theme=${theme}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1_200);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      const report = bad.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join("\n  ")}`).join("\n");
      expect(bad, report).toEqual([]);
    });
  }
}
