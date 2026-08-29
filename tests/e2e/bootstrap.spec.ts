import { expect, test } from "@playwright/test";

/**
 * E2E (PRD §15): bootstrap → setup → login → feeds → admin.
 * Requires a running stack with seeded demo data:
 *   docker compose up --build -d && pnpm migrate && pnpm seed
 *   pnpm test:e2e
 */

test.describe("bootstrap and primary flows", () => {
  test("health endpoints respond", async ({ request }) => {
    const live = await request.get("/health/live");
    expect(live.status()).toBe(200);
    const ready = await request.get("/health/ready");
    expect([200, 503]).toContain(ready.status());
  });

  test("setup page renders the first-admin form", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "HoodMint Radar setup" })).toBeVisible();
    await expect(page.getByLabel("Bootstrap token")).toBeVisible();
  });

  test("unauthenticated API returns envelope for public projects list", async ({ request }) => {
    const response = await request.get("/api/v1/projects?view=all&limit=5");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { data?: unknown[]; meta?: Record<string, unknown> };
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("watchlist view is protected", async ({ request }) => {
    const response = await request.get("/api/v1/projects?view=watchlist");
    expect(response.status()).toBe(401);
    const problem = (await response.json()) as { title?: string };
    expect(problem.title).toBeDefined();
  });

  test("feed views render with URL state", async ({ page }) => {
    await page.goto("/all?sort=starting");
    await expect(page.getByRole("table")).toBeVisible();
    await page.goto("/live");
    await expect(page.getByRole("heading", { name: "Live mints" })).toBeVisible();
    await page.goto("/next");
    await expect(page.getByRole("heading", { name: "Up next" })).toBeVisible();
    await page.goto("/latest");
    await expect(page.getByRole("heading", { name: "Latest discoveries" })).toBeVisible();
  });

  test("project detail shows stage timeline and evidence panels", async ({ page, request }) => {
    const feed = (await (await request.get("/api/v1/projects?view=all&limit=1")).json()) as {
      data?: { id?: string }[];
    };
    const id = feed.data?.[0]?.id;
    test.skip(id === undefined, "no projects seeded");
    await page.goto(`/projects/${id}`);
    await expect(page.getByRole("heading", { name: /Stage timeline/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Source evidence/ })).toBeVisible();
  });

  test("calendar events expose mint decision signals", async ({ page }) => {
    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: "Minting calendar" })).toBeVisible();
    const mintLinks = page.getByRole("link", { name: /Mint on OpenSea/ });
    test.skip((await mintLinks.count()) === 0, "no upcoming phases seeded");
    await expect(mintLinks.first()).toBeVisible();
    await expect(page.getByText("Tracked wallet WL").first()).toBeVisible();
    await expect(page.getByText(/X: none|X @/).first()).toBeVisible();
    await expect(page.getByText(/Website: none/).first()).toBeVisible();
  });

  test("admin requires auth (server-side redirect to login)", async ({ page }) => {
    await page.goto("/admin");
    await page.waitForURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("mobile navigation renders bottom bar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/all");
    await expect(page.getByRole("navigation", { name: "Primary mobile" })).toBeVisible();
    await expect(page.getByText("Tracked wallet WL").first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Mint on OpenSea/ }).first()).toBeVisible();
  });
});
