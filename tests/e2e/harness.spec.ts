import { expect, test } from "@playwright/test";
test("harness mounts with a real file input and needs no backend", async ({ page }) => {
  const origins = new Set<string>();
  page.on("request", (request) => origins.add(new URL(request.url()).origin));

  await page.goto("/");

  const input = page.getByLabel("Chọn tệp PDF");
  await expect(input).toBeAttached();
  await expect(input).toHaveAttribute("type", "file");
  await expect(input).toHaveAttribute("accept", /pdf/);
  await expect(page.getByRole("status")).toBeAttached();
  await expect(page.getByRole("status")).toHaveText("Sẵn sàng. Chọn một tệp PDF.");
  expect([...origins]).toEqual([new URL(page.url()).origin]);
});
