import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { JsonBlock, JsonCell, LayoutSummary } from "../../src/e2eHooks";
import { characterErrorRate, normalizeForComparison } from "../benchmark/cer";
import { getFixture } from "../fixtures/manifest";
import { fixtureBase64, openApp } from "./helpers";

type Table = Extract<JsonBlock, { kind: "table" }>;

async function layoutOf(page: Page, id: string, pageNumber = 1, forceOcr = false): Promise<LayoutSummary> {
  return page.evaluate(([data, name, n, force]) => window.__e2e!.layoutPage(data, name, n, force), [fixtureBase64(id), `${id}.pdf`, pageNumber, forceOcr] as const);
}

const paragraphTexts = (cell: JsonCell[]) => cell.flatMap((item) => (item.kind === "paragraph" ? [item.text] : []));
const tablesOf = (blocks: JsonBlock[]) => blocks.filter((block): block is Table => block.kind === "table");
const imagesIn = (cell: JsonCell[]) => cell.filter((item) => item.kind === "image").length;

/** Text of a page in Word reading order: paragraphs, and tables cell by cell. */
function flatText(blocks: JsonBlock[]): string {
  return blocks
    .flatMap((block) => (block.kind === "table" ? block.rows.flatMap((row) => row.flatMap(paragraphTexts)) : block.kind === "paragraph" ? [block.text] : []))
    .join("\n");
}

const referenceOf = (id: string, pageIndex = 0) => getFixture(id).pages[pageIndex].referenceText;
const cer = (id: string, layout: LayoutSummary, pageIndex = 0) => characterErrorRate(referenceOf(id, pageIndex), flatText(layout.blocks));

test.describe("layout reconstruction on real fixtures, with the network blocked", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let page: Page;
  let initialized = false;
  const requestsAfterInit: string[] = [];

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    page.on("request", (request) => {
      if (initialized) requestsAfterInit.push(request.url());
    });
    await openApp(page);
    await page.evaluate(() => window.__e2e!.initialize());
    initialized = true;
    await context.setOffline(true);
  });

  test.afterAll(async () => {
    await page.evaluate(() => window.__e2e!.dispose()).catch(() => undefined);
    await context.close();
  });

  test("native letter: letterhead and signature become borderless tables, with the stamp kept as an image", async () => {
    const layout = await layoutOf(page, "native-congvan-1p");
    expect(layout.mode).toBe("native");
    expect(cer("native-congvan-1p", layout)).toBeLessThanOrEqual(0.005);

    const [letterhead, signature] = tablesOf(layout.blocks);
    expect(letterhead.bordered).toBe(false);
    expect(paragraphTexts(letterhead.rows[0][0])).toContain("SỞ KẾ HOẠCH MẪU");
    expect(paragraphTexts(letterhead.rows[0][2])).toContain("Độc lập - Tự do - Hạnh phúc");
    expect(letterhead.rows[0][2].find((item) => item.kind === "paragraph" && item.text.startsWith("CỘNG HÒA"))).toMatchObject({ alignment: "center", bold: true });

    expect(signature.rows[0].map(imagesIn)).toEqual([0, 0, 1]);
    expect(layout.warnings).toEqual(expect.arrayContaining(["RASTER_REGION", "FONT_SUBSTITUTED"]));

    const paragraphs = layout.blocks.filter((block) => block.kind === "paragraph");
    expect(paragraphs[0]).toMatchObject({ alignment: "center", bold: true });
    expect(paragraphs.find((block) => block.kind === "paragraph" && block.text.startsWith("Thực hiện chỉ đạo"))).toMatchObject({ alignment: "justify" });
    const body = paragraphs.find((block) => block.kind === "paragraph" && block.text.startsWith("Thực hiện chỉ đạo"));
    expect(body && body.kind === "paragraph" ? body.firstLineIndentPt : 0).toBeGreaterThan(20);
  });

  test("native table: one bordered grid with every authored cell, and nothing left outside it", async () => {
    const layout = await layoutOf(page, "native-table-1p");
    const bordered = tablesOf(layout.blocks).filter((table) => table.bordered);
    expect(bordered).toHaveLength(1);
    const cells = bordered[0].rows.map((row) => row.map((cell) => paragraphTexts(cell).join(" ")));
    expect(cells).toEqual([
      ["STT", "Chỉ tiêu", "Đơn vị tính", "Kết quả 9 tháng"],
      ["1", "Tổng thu ngân sách", "Tỷ đồng", "1.254,7"],
      ["2", "Vốn đầu tư công đã giải ngân", "Tỷ đồng", "843,2"],
      ["3", "Doanh nghiệp thành lập mới", "Doanh nghiệp", "1.087"],
    ]);
    expect(cer("native-table-1p", layout)).toBeLessThanOrEqual(0.005);
  });

  test("native plan: each list item is its own paragraph and pages stay separate", async () => {
    const second = await layoutOf(page, "native-list-3p", 2);
    const items = second.blocks.flatMap((block) => (block.kind === "paragraph" ? [block.text] : []));
    expect(items.filter((text) => text.startsWith("- "))).toHaveLength(5);
    expect(items.filter((text) => /^\d\. /.test(text))).toHaveLength(3);
    expect(cer("native-list-3p", second, 1)).toBeLessThanOrEqual(0.005);
    for (const pageIndex of [0, 2]) expect(cer("native-list-3p", await layoutOf(page, "native-list-3p", pageIndex + 1), pageIndex)).toBeLessThanOrEqual(0.005);
  });

  test("native diacritics page keeps bold, italic and centered runs", async () => {
    const layout = await layoutOf(page, "native-diacritics-1p");
    const paragraphs = layout.blocks.flatMap((block) => (block.kind === "paragraph" ? [block] : []));
    expect(paragraphs[0]).toMatchObject({ text: "KIỂM TRA HIỂN THỊ DẤU TIẾNG VIỆT", alignment: "center", bold: true });
    expect(paragraphs.find((block) => block.text.startsWith("Quyết định này"))).toMatchObject({ italic: true });
    expect(paragraphs.find((block) => block.text.startsWith("Nguyễn Thị Thuỷ"))).toMatchObject({ bold: true });
    expect(paragraphs.at(-1)).toMatchObject({ alignment: "center" });
    expect(cer("native-diacritics-1p", layout)).toBeLessThanOrEqual(0.005);
  });

  test("scanned letter: same structure from OCR, stamp kept as one image and its lettering not read as text", async () => {
    const layout = await layoutOf(page, "scan-congvan-1p");
    expect(layout.mode).toBe("ocr");
    expect(layout.warnings).toEqual(expect.arrayContaining(["OCR_REVIEW", "RASTER_REGION"]));
    const tables = tablesOf(layout.blocks);
    expect(tables).toHaveLength(2);
    expect(tables.flatMap((table) => table.rows[0].map(imagesIn)).reduce((a, b) => a + b, 0)).toBe(1);
    expect(flatText(layout.blocks)).not.toContain("KHÔNG CÓ");
    console.log(`CER scan-congvan-1p ${cer("scan-congvan-1p", layout).toFixed(4)}`);
    expect(cer("scan-congvan-1p", layout)).toBeLessThanOrEqual(0.1);
  });

  test("scanned table: every cell of the ruled grid is read and none is lost", async () => {
    const layout = await layoutOf(page, "scan-table-1p");
    const bordered = tablesOf(layout.blocks).filter((table) => table.bordered);
    expect(bordered).toHaveLength(1);
    expect(bordered[0].rows).toHaveLength(4);
    for (const row of bordered[0].rows) {
      expect(row).toHaveLength(4);
      for (const cell of row) expect(paragraphTexts(cell).join("").length).toBeGreaterThan(0);
    }
    console.log(`CER scan-table-1p ${cer("scan-table-1p", layout).toFixed(4)}`);
    // The comma of "1.254,7" is easy to lose at this size; a focused second reading restores it.
    expect(flatText(layout.blocks)).toContain("1.254,7");
    expect(cer("scan-table-1p", layout)).toBeLessThanOrEqual(0.15);
  });

  test("a scan stored sideways reads in the right order", async () => {
    const layout = await layoutOf(page, "scan-rotated-1p");
    const first = layout.blocks[0];
    expect(first).toMatchObject({ kind: "paragraph", alignment: "center" });
    console.log(`CER scan-rotated-1p ${cer("scan-rotated-1p", layout).toFixed(4)}`);
    expect(cer("scan-rotated-1p", layout)).toBeLessThanOrEqual(0.1);
  });

  test("a skewed, noisy scan is straightened and scanner specks do not become columns", async () => {
    const layout = await layoutOf(page, "scan-skewed-noisy-1p");
    expect(tablesOf(layout.blocks)).toHaveLength(2);
    // The year on its own short line is lost to noise on the first reading and recovered on the second.
    expect(normalizeForComparison(flatText(layout.blocks))).toContain("ngày 12 tháng 11 năm 2026");
    console.log(`CER scan-skewed-noisy-1p ${cer("scan-skewed-noisy-1p", layout).toFixed(4)}`);
    expect(cer("scan-skewed-noisy-1p", layout)).toBeLessThanOrEqual(0.12);
  });

  test("a native header above a scanned body keeps the body", async () => {
    const layout = await layoutOf(page, "mixed-header-native-body-scan");
    expect(layout.mode).toBe("ocr");
    const text = flatText(layout.blocks);
    expect(text).toContain("CÔNG VĂN HỎA TỐC");
    expect(text).toContain("Trân trọng cảm ơn");
    console.log(`CER mixed-header-native-body-scan ${cer("mixed-header-native-body-scan", layout).toFixed(4)}`);
    expect(cer("mixed-header-native-body-scan", layout)).toBeLessThanOrEqual(0.08);
  });

  test("a corrupted hidden text layer is replaced by OCR, and the native page of the same file is untouched", async () => {
    const scanned = await layoutOf(page, "mixed-bad-text-layer", 1);
    expect(scanned.mode).toBe("ocr");
    expect(flatText(scanned.blocks)).not.toMatch(/[ÃÂÄÅ]/);
    expect(cer("mixed-bad-text-layer", scanned)).toBeLessThanOrEqual(0.1);
    const native = await layoutOf(page, "mixed-bad-text-layer", 2);
    expect(native.mode).toBe("native");
    expect(cer("mixed-bad-text-layer", native, 1)).toBeLessThanOrEqual(0.005);
  });

  test("forcing OCR ignores a good text layer", async () => {
    const forced = await layoutOf(page, "native-diacritics-1p", 1, true);
    expect(forced.mode).toBe("ocr");
    expect(forced.warnings).toContain("OCR_REVIEW");
    expect(forced.warnings).not.toContain("FONT_SUBSTITUTED");
    console.log(`CER native-diacritics-1p forced OCR ${cer("native-diacritics-1p", forced).toFixed(4)}`);
    expect(cer("native-diacritics-1p", forced)).toBeLessThanOrEqual(0.12);
  });

  test("a photo below scanned text is kept as one image while the text is still read", async () => {
    const layout = await layoutOf(page, "scan-figure-1p");
    expect(layout.blocks.filter((block) => block.kind === "image")).toHaveLength(1);
    expect(layout.warnings).toContain("RASTER_REGION");
    console.log(`CER scan-figure-1p ${cer("scan-figure-1p", layout).toFixed(4)}`);
    expect(cer("scan-figure-1p", layout)).toBeLessThanOrEqual(0.1);
  });

  test("a page with ink that is neither readable nor isolatable fails loudly instead of producing a hollow page", async () => {
    await expect(layoutOf(page, "scan-unreadable-1p")).rejects.toThrow("ConversionError:QUALITY_FAILURE");
  });

  test("a blank page and an oversized page produce valid, empty or text-only layouts", async () => {
    expect((await layoutOf(page, "blank-page-mid", 2)).blocks).toEqual([]);
    const large = await layoutOf(page, "large-page-native");
    expect(flatText(large.blocks)).toBe("Large format page 1");
  });

  test("made no network request after initialization", async () => {
    expect(requestsAfterInit).toEqual([]);
  });
});

test("cancelling OCR stops the recognition within a second", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openApp(page);
  await page.evaluate(() => window.__e2e!.initialize());
  const result = await page.evaluate(([data, name]) => window.__e2e!.abortOcr(data, name, 1, 150), [fixtureBase64("perf-scan-5p"), "perf-scan-5p.pdf"] as const);
  expect(result.aborted).toBe(true);
  expect(result.elapsedMs).toBeLessThan(1000);
  await context.close();
});
