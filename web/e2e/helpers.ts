import type { Page } from "@playwright/test";

/** Fixed wall clock so fixture data (built from Date.now) is identical on every run. */
export const FIXED_TIME = new Date("2026-10-06T09:00:00.000Z");

export async function freezeClock(page: Page): Promise<void> {
  await page.clock.install({ time: FIXED_TIME });
}

export async function noHorizontalScroll(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => {
    const els = [document.documentElement, ...Array.from(document.querySelectorAll<HTMLElement>("#main, #main > div"))];
    const scrollWidth = Math.max(...els.map((e) => e.scrollWidth - e.clientWidth)) + document.documentElement.clientWidth;
    return { scrollWidth, clientWidth: document.documentElement.clientWidth };
  });
}
