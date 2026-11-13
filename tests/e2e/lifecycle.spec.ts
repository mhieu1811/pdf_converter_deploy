import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { getFixture } from "../fixtures/manifest";

const fixturePath = (id: string) => path.resolve(getFixture(id).pdfPath);
const READY = "Sẵn sàng. Chọn một tệp PDF.";

async function openReady(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText(READY, { timeout: 30_000 });
}

const input = (page: Page) => page.getByLabel("Chọn tệp PDF");
const chooseFile = (page: Page, id: string) => input(page).setInputFiles(fixturePath(id));
const convertButton = (page: Page) => page.getByRole("button", { name: "Chuyển sang Word" });
const downloadLink = (page: Page, id: string) => page.getByRole("link", { name: new RegExp(`${id}\\.docx`) });

test.describe("job lifecycle", () => {
  test("cancelling a real scan is acknowledged within a second and that job never reports again", async ({ page }) => {
    await openReady(page);
    await chooseFile(page, "perf-scan-5p");
    await convertButton(page).click();
    await expect(page.getByRole("status")).toContainText("nhận dạng chữ");

    const cancelled = Date.now();
    await page.getByRole("button", { name: "Hủy" }).click();
    await expect(page.getByRole("status")).toContainText("Đã hủy", { timeout: 1000 });
    expect(Date.now() - cancelled).toBeLessThan(1500);

    // The cancelled job must neither progress nor produce a result, even long after.
    await page.waitForTimeout(4000);
    await expect(page.getByRole("link")).toHaveCount(0);
    await expect(page.getByRole("status")).not.toContainText(/Đang (nhận dạng|đọc|tạo)/);
    await expect(page.getByRole("status")).toContainText("Đã hủy");
    await expect(page.getByRole("status")).not.toContainText("không thành công");
  });

  test("after a cancel the engines are replaced, and a second file yields only its own output", async ({ page }) => {
    await openReady(page);
    await chooseFile(page, "perf-scan-5p");
    await convertButton(page).click();
    await expect(page.getByRole("status")).toContainText("nhận dạng chữ");
    await page.getByRole("button", { name: "Hủy" }).click();
    await expect(page.getByRole("status")).toContainText("Đã hủy");

    // File selection stays closed until the replacement engines are ready.
    await expect(input(page)).toBeEnabled({ timeout: 30_000 });
    await chooseFile(page, "native-congvan-1p");
    await convertButton(page).click();
    await expect(downloadLink(page, "native-congvan-1p")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("link")).toHaveCount(1);
    await expect(downloadLink(page, "perf-scan-5p")).toHaveCount(0);
  });

  test("a double click starts one conversion only", async ({ page }) => {
    await openReady(page);
    await chooseFile(page, "native-list-3p");
    await convertButton(page).dblclick();
    await expect(downloadLink(page, "native-list-3p")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("link")).toHaveCount(1);
    await expect(page.getByRole("status")).toHaveText("Hoàn tất.");
  });

  test("resetting repeatedly always lands in a clean ready state", async ({ page }) => {
    await openReady(page);
    await chooseFile(page, "native-table-1p");
    const reset = page.getByRole("button", { name: "Chọn tệp khác" });
    await reset.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(page.getByRole("status")).toHaveText(READY);
    await expect(page.getByRole("img", { name: /Xem trước/ })).toHaveCount(0);
    await expect(convertButton(page)).toHaveCount(0);
    await expect(input(page)).toBeEnabled();
  });

  test("a saved download survives the next file, while the in-page link to the old output is revoked", async ({ page }) => {
    await openReady(page);
    await chooseFile(page, "native-congvan-1p");
    await convertButton(page).click();
    const link = downloadLink(page, "native-congvan-1p");
    await expect(link).toBeVisible({ timeout: 30_000 });
    const oldHref = (await link.getAttribute("href"))!;
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBe("native-congvan-1p.docx");
    await expect(page.getByText(/tệp Word đã tải về vẫn còn trên máy/)).toBeVisible();

    await chooseFile(page, "native-table-1p");
    await convertButton(page).click();
    await expect(downloadLink(page, "native-table-1p")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("link")).toHaveCount(1);
    const stillValid = await page.evaluate((href) => fetch(href).then(() => true, () => false), oldHref);
    expect(stillValid).toBe(false);
  });

  test("a failed initialization is explained, blocks file selection and can be retried", async ({ page }) => {
    let block = true;
    await page.route("**/engine/tesseract/lang/vie.traineddata.gz", (route) => (block ? route.abort() : route.continue()));
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText("Không tải được", { timeout: 30_000 });
    await expect(input(page)).toBeDisabled();
    block = false;
    await page.getByRole("button", { name: "Thử lại" }).click();
    await expect(page.getByRole("status")).toHaveText(READY, { timeout: 30_000 });
    await expect(input(page)).toBeEnabled();
  });
});
