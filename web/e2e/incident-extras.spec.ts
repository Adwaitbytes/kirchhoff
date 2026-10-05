import { expect, test, type Page } from "@playwright/test";

async function incidentHref(page: Page, scenario: string): Promise<string> {
  await page.goto(`/app/tokens/kETH?scenario=${scenario}`);
  const link = page.locator('a[href^="/app/incidents/"]').first();
  await expect(link).toBeAttached();
  const href = await link.getAttribute("href");
  if (!href) throw new Error("no incident link");
  return href.split("?")[0] ?? href;
}

test.describe("Incident Room extras", () => {
  test("a Loop Rule incident shows n/a, never zero addresses", async ({ page }) => {
    const href = await incidentHref(page, "loop");
    await page.goto(`${href}?scenario=loop`);
    const header = page.getByTestId("incident-header");
    await expect(header).toContainText("Loop Rule deficit");
    await expect(page.getByTestId("loop-rule-note")).toBeVisible();
    await expect(header).toContainText("Recipient n/a");
    await expect(header).toContainText("Home BREACH report");
    const body = await page.locator("#main").innerText();
    expect(body).not.toContain("0x0000000000000000000000000000000000000000");
    expect(body).not.toMatch(/0x0000…0000/);
  });

  test("replay after recovery is disabled while the token is not CONSERVED", async ({ page }) => {
    const href = await incidentHref(page, "breach");
    await page.goto(`${href}?scenario=breach`);
    await expect(page.getByTestId("replay-after-recovery")).toBeDisabled();
  });

  test("once CONSERVED the Safe-gated replay plan lists one replay call", async ({ page }) => {
    const href = await incidentHref(page, "recovered");
    await page.goto(`${href}?scenario=recovered`);
    const btn = page.getByTestId("replay-after-recovery");
    await expect(btn).toBeEnabled();
    await btn.click();
    const plan = page.getByTestId("replay-plan");
    await expect(plan).toBeVisible();
    await expect(plan).toContainText("skip");
    await expect(page.getByTestId("replay-plan-call")).toHaveCount(1);
    await expect(plan.getByRole("link", { name: /Open in Safe/ })).toHaveAttribute("href", /app\.safe\.global/);
  });
});
