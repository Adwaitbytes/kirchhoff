/**
 * Captures a review gallery of every screen (stage mode 1920x1080, dark and light, plus 375px
 * mobile) into e2e/__screenshots__/gallery. Run against a fixtures server:
 *   E2E_PORT=3418 pnpm exec tsx e2e/gallery.capture.ts   (or: node --experimental-strip-types)
 */
import { chromium, type Page } from "@playwright/test";

const BASE = `http://localhost:${process.env.E2E_PORT ?? 3418}`;
const OUT = new URL("./__screenshots__/gallery/", import.meta.url).pathname;

async function settle(page: Page, ms = 1800): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(ms);
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  for (const theme of ["dark", "light"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: theme });
    const page = await ctx.newPage();
    const shots: [string, string][] = [
      ["landing", `/?stage=0&theme=${theme}`],
      ["mission-control", `/app/tokens/kETH?stage=1&theme=${theme}`],
      ["mission-control-breach", `/app/tokens/kETH?stage=1&theme=${theme}&scenario=breach`],
      ["status-page", `/t/kETH?stage=1&theme=${theme}`],
      ["ops", `/app/ops?stage=1&theme=${theme}`],
      ["integrate", `/app/integrate?stage=1&theme=${theme}`],
      ["onboard", `/app/onboard?stage=1&theme=${theme}`],
      ["incident-room", `/app/incidents/0x498d23bbcdc23cebcba86d96f97671a66b4fde6a32958611604b7c1a3436e1fa?stage=1&theme=${theme}`],
    ];
    for (const [name, url] of shots) {
      await page.goto(`${BASE}${url}`);
      await settle(page, name === "landing" ? 3200 : 1800);
      await page.screenshot({ path: `${OUT}${name}-stage-${theme}.png` });
    }
    await page.goto(`${BASE}/lab?stage=1&theme=${theme}`);
    await settle(page);
    await page.getByTestId("run-kelp-replay").click();
    await page.waitForTimeout(13_000);
    await page.screenshot({ path: `${OUT}attack-lab-mid-replay-stage-${theme}.png` });
    await ctx.close();
  }
  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 }, colorScheme: "dark", hasTouch: true, isMobile: true });
  const m = await mobile.newPage();
  for (const [name, url] of [
    ["landing", "/?stage=0&theme=dark"],
    ["mission-control", "/app/tokens/kETH?stage=0&theme=dark"],
    ["lab", "/lab?stage=0&theme=dark"],
    ["status-page", "/t/kETH?stage=0&theme=dark"],
  ] as const) {
    await m.goto(`${BASE}${url}`);
    await settle(m, 2500);
    await m.screenshot({ path: `${OUT}${name}-mobile-375.png`, fullPage: name === "landing" || name === "status-page" });
  }
  await browser.close();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
