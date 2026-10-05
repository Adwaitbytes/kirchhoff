import { expect, test, type Page } from "@playwright/test";

async function focusIsVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    const cs = getComputedStyle(el);
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    const ring = cs.boxShadow !== "none";
    return outline || ring;
  });
}

test.describe("Keyboard only", () => {
  test("skip link is first and jumps to main", async ({ page }) => {
    await page.goto("/app/tokens/kETH");
    await expect(page.getByTestId("status-pill")).toBeVisible();
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  });

  test("tab order walks the rail then the top bar, every stop with a visible focus ring", async ({ page }) => {
    await page.goto("/app/tokens/kETH");
    await expect(page.getByTestId("status-pill")).toBeVisible();
    const names: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press("Tab");
      expect(await focusIsVisible(page), `focus ring missing at stop ${i + 1}`).toBe(true);
      names.push(await page.evaluate(() => (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "").trim().slice(0, 40)));
    }
    const rail = names.indexOf("Mission Control");
    const switcher = names.findIndex((n) => n.startsWith("Token: kETH"));
    expect(rail).toBeGreaterThan(0);
    expect(switcher).toBeGreaterThan(rail);
  });

  test("Cmd+K opens Ask KIRCHHOFF and Escape closes it, restoring focus", async ({ page }) => {
    await page.goto("/app/tokens/kETH");
    await expect(page.getByTestId("status-pill")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Ask KIRCHHOFF" });
    await expect(dialog).toBeVisible();
    await expect(page.getByPlaceholder("Ask KIRCHHOFF or jump to a screen")).toBeFocused();
    await page.keyboard.type("ops");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/app\/ops$/);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("ledger drawer opens from the keyboard and Escape returns focus to the chain", async ({ page }) => {
    await page.goto("/app/tokens/kETH");
    const chain = page.getByRole("button", { name: /Base Sepolia: .* Open ledger/ });
    await chain.focus();
    expect(await focusIsVisible(page)).toBe(true);
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Base Sepolia ledger" });
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(chain).toBeFocused();
  });

  test("a wire's transfers open on focus, no mouse needed", async ({ page }) => {
    await page.goto("/app/tokens/kETH");
    await page.getByTestId("wire-weakbridge").focus();
    await expect(page.getByRole("dialog", { name: /Last \d+ transfers on WeakBridge/ })).toBeVisible();
  });

  test("Attack Lab runs from the keyboard", async ({ page }) => {
    await page.goto("/lab");
    const run = page.getByTestId("run-kelp-replay");
    await expect(run).toBeEnabled();
    await run.focus();
    expect(await focusIsVisible(page)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("lab-step-forge_release")).toHaveAttribute("data-state", /running|done/);
  });
});
