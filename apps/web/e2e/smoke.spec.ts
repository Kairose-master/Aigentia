import { expect, test } from "@playwright/test";

/**
 * Offline smoke tests: the API is not required. Every page must render its chrome and an
 * empty/offline state without client or server errors.
 */
test.describe("spectator dashboard (offline mode)", () => {
  test("home renders the wordmark, hero and stats strip", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await expect(page.getByTestId("wordmark")).toHaveText("AIGENTIA");
    await expect(page.getByTestId("hero-title")).toContainText("LIVE ECONOMY");
    await expect(page.getByTestId("stats-strip")).toBeVisible();
    await expect(page.getByTestId("stat-agents")).toBeVisible();
    await expect(page.getByTestId("live-pill")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("/agents renders its heading", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByRole("heading", { level: 1, name: /agents/i })).toBeVisible();
  });

  test("/market renders its heading", async ({ page }) => {
    await page.goto("/market");
    await expect(page.getByRole("heading", { level: 1, name: /market/i })).toBeVisible();
  });

  test("/transactions renders its heading", async ({ page }) => {
    await page.goto("/transactions");
    await expect(page.getByRole("heading", { level: 1, name: /transactions/i })).toBeVisible();
  });
});
