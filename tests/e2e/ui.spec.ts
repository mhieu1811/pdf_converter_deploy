import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { readFileSync } from "node:fs";
import { getFixture } from "../fixtures/manifest";

const fixturePath = (id: string) => path.resolve(getFixture(id).pdfPath);
const READY = "Sẵn sàng. Chọn một tệp PDF.";

async function openReady(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText(READY, { timeout: 30_000 });
}

const chooseFile = (page: Page, id: string) => page.getByLabel("Chọn tệp PDF").setInputFiles(fixturePath(id));
const convertButton = (page: Page) => page.getByRole("button", { name: "Chuyển sang Word" });

test.describe("Vietnamese interface", () => {
  test("states what is private, the limits and the quality caveat before any file is chosen", async ({ page }) => {
    await openReady(page);
    await expect(page.getByRole("heading", { level: 1, name: "PDF sang Word" })).toBeVisible();
    await expect(page.getByText(/không được tải lên máy chủ/)).toBeVisible();
    await expect(page.getByText(/vẫn tải mã chương trình/)).toBeVisible();
    await expect(page.getByText("Tối đa 10 MiB và 20 trang")).toBeVisible();
    await expect(page.getByText(/bản quét/i)).toBeVisible();
    await expect(convertButton(page)).toHaveCount(0);
  });

  test("a chosen file shows a local preview and waits for the button before converting", async ({ page }) => {
    await openReady(page);
    await chooseFile(page, "native-congvan-1p");
    await expect(page.getByRole("status")).toContainText("Đã chọn native-congvan-1p.pdf (1 trang)");
    const preview = page.getByRole("img", { name: /Xem trước trang 1/ });
    await expect(preview).toBeVisible();
    expect(await preview.getAttribute("src")).toMatch(/^blob:/);
    await expect(page.getByRole("link")).toHaveCount(0);
    await expect(convertButton(page)).toBeEnabled();
  });

  test("converts, announces progress, lists grouped warnings and offers the download", async ({ page }) => {
    await openReady(page);
    await chooseFile(page, "native-congvan-1p");
    await convertButton(page).click();
    const link = page.getByRole("link", { name: /native-congvan-1p\.docx/ });
    await expect(link).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Hoàn tất.");
    await expect(page.getByRole("list", { name: "Cảnh báo chất lượng" })).toContainText("Phông chữ gốc");
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBe("native-congvan-1p.docx");
    const chunks: Buffer[] = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).subarray(0, 2).toString()).toBe("PK");
  });

  test("announces the phase and page while a scan is being recognized", async ({ page }) => {
    await openReady(page);
    await chooseFile(page, "perf-scan-5p");
    await convertButton(page).click();
    await expect(page.getByRole("status")).toContainText(/Đang nhận dạng chữ \(OCR\), trang \d\/5/);
    await expect(page.getByRole("button", { name: "Hủy" })).toBeVisible();
    await expect(page.getByRole("link", { name: /perf-scan-5p\.docx/ })).toBeVisible({ timeout: 90_000 });
  });

  test("OCR-all makes a native page go through recognition", async ({ page }) => {
    await openReady(page);
    await chooseFile(page, "native-diacritics-1p");
    await page.getByLabel(/OCR tất cả các trang/).check();
    await convertButton(page).click();
    await expect(page.getByRole("link", { name: /native-diacritics-1p\.docx/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("list", { name: "Cảnh báo chất lượng" })).toContainText("nhận dạng chữ (OCR)");
  });

  test("shows specific refusals for size, pages, protection and bad files, without a download", async ({ page }) => {
    await openReady(page);
    const cases: [string, RegExp][] = [
      ["limit-size-over", /vượt quá giới hạn 10 MiB/],
      ["limit-pages-21", /vượt quá giới hạn 20 trang/],
      ["protected-pdf", /bảo vệ bằng mật khẩu/],
      ["invalid-not-pdf", /không phải là PDF hợp lệ/],
    ];
    for (const [id, message] of cases) {
      await chooseFile(page, id);
      await expect(page.getByRole("status")).toContainText(message);
      await expect(page.getByRole("link")).toHaveCount(0);
      await expect(convertButton(page)).toHaveCount(0);
    }
  });

  test("never offers a download when the conversion itself fails", async ({ page }) => {
    await openReady(page);
    await chooseFile(page, "scan-unreadable-1p");
    await convertButton(page).click();
    await expect(page.getByRole("status")).toContainText("không đọc được", { timeout: 60_000 });
    await expect(page.getByRole("link")).toHaveCount(0);
  });

  test("a file can be chosen with the keyboard", async ({ page }) => {
    await openReady(page);
    const input = page.getByLabel("Chọn tệp PDF");
    await input.focus();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
    await chooser.setFiles(fixturePath("native-table-1p"));
    await expect(page.getByRole("status")).toContainText("Đã chọn native-table-1p.pdf");
  });

  test("a file can be dropped on the page", async ({ page }) => {
    await openReady(page);
    const base64 = readFileSync(fixturePath("native-table-1p")).toString("base64");
    const transfer = await page.evaluateHandle(([data, name]) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "application/pdf" }));
      return dt;
    }, [base64, "native-table-1p.pdf"] as const);
    const zone = page.getByTestId("dropzone");
    await zone.dispatchEvent("dragover", { dataTransfer: transfer });
    await zone.dispatchEvent("drop", { dataTransfer: transfer });
    await expect(page.getByRole("status")).toContainText("Đã chọn native-table-1p.pdf");
  });

  test("a browser without required features gets a clear notice instead of a broken page", async ({ page }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, "OffscreenCanvas");
    });
    await page.goto("/");
    await expect(page.getByRole("alert")).toContainText("Trình duyệt này chưa được hỗ trợ");
    await expect(page.getByLabel("Chọn tệp PDF")).toBeDisabled();
  });
});
