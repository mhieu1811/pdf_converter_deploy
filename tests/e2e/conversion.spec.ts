import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { ConvertSummary } from "../../src/e2eHooks";
import { characterErrorRate } from "../benchmark/cer";
import { inspectDocx } from "../benchmark/docxInspect";
import { FIXTURES, getFixture } from "../fixtures/manifest";
import { fixtureBase64, openApp } from "./helpers";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type Converted = Extract<ConvertSummary, { ok: true }>;

async function convert(page: Page, id: string, forceOcr = false, abortAfterMs?: number): Promise<ConvertSummary> {
  return page.evaluate(([data, name, options]) => window.__e2e!.convert(data, name, options), [fixtureBase64(id), `${id}.pdf`, { forceOcr, abortAfterMs }] as const);
}

async function converted(page: Page, id: string, forceOcr = false): Promise<Converted> {
  const result = await convert(page, id, forceOcr);
  if (!result.ok) throw new Error(`${id}: conversion failed with ${result.code}`);
  return result;
}

const inspect = (result: Converted) => inspectDocx(Uint8Array.from(Buffer.from(result.base64, "base64")));

const cer = (id: string, text: string, pageIndex: number) => characterErrorRate(getFixture(id).pages[pageIndex].referenceText, text);

test.describe("end-to-end conversion with the network blocked", () => {
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

  test("a native letter becomes a well-formed DOCX with real tables, the stamp and exact text", async () => {
    const result = await converted(page, "native-congvan-1p");
    expect(result.mime).toBe(DOCX_MIME);
    expect(result.fileName).toBe("native-congvan-1p.docx");
    expect(result.size).toBeGreaterThan(5000);
    expect(result.pageCount).toBe(1);
    expect(result.warnings).toEqual(expect.arrayContaining(["RASTER_REGION", "FONT_SUBSTITUTED"]));

    const { sections, xml, files } = inspect(result);
    expect(sections).toHaveLength(1);
    expect(sections[0].tables).toBe(2);
    expect(sections[0].borderedTables).toBe(0);
    expect(sections[0].pictures).toBe(1);
    expect(cer("native-congvan-1p", sections[0].text, 0)).toBeLessThanOrEqual(0.005);

    const wellFormed = await page.evaluate((document) => !new DOMParser().parseFromString(document, "application/xml").querySelector("parsererror"), xml);
    expect(wellFormed).toBe(true);
    expect(Object.keys(files).some((name) => name.startsWith("word/media/"))).toBe(true);
  });

  test("reports progress by phase and page, in order", async () => {
    const { progress } = await converted(page, "mixed-header-native-body-scan");
    expect(progress.map((item) => [item.phase, item.page ?? 0])).toEqual([
      ["validating", 0],
      ["analyzing", 1],
      ["ocr", 1],
      ["analyzing", 2],
      ["extracting", 2],
      ["building", 0],
    ]);
    expect(progress.at(-1)).toMatchObject({ totalPages: 2 });
  });

  test("a three-page plan keeps one Word section, and one page, per source page", async () => {
    const result = await converted(page, "native-list-3p");
    const { sections } = inspect(result);
    expect(sections).toHaveLength(3);
    sections.forEach((section, index) => expect(cer("native-list-3p", section.text, index)).toBeLessThanOrEqual(0.005));
  });

  test("a scanned letter converts through OCR with the stamp kept", async () => {
    const result = await converted(page, "scan-congvan-1p");
    expect(result.warnings).toEqual(expect.arrayContaining(["OCR_REVIEW", "RASTER_REGION"]));
    expect(result.progress.some((item) => item.phase === "ocr")).toBe(true);
    const [section] = inspect(result).sections;
    expect(section.pictures).toBe(1);
    console.log(`DOCX CER scan-congvan-1p ${cer("scan-congvan-1p", section.text, 0).toFixed(4)}`);
    expect(cer("scan-congvan-1p", section.text, 0)).toBeLessThanOrEqual(0.03);
  });

  test("a scanned table arrives as one bordered Word table with all sixteen cells", async () => {
    const [section] = inspect(await converted(page, "scan-table-1p")).sections;
    expect(section.borderedTables).toBe(1);
    expect(section.cells).toBe(3 + 16 + 3); // each letterhead/footer row has a spacer cell between its columns
    console.log(`DOCX CER scan-table-1p ${cer("scan-table-1p", section.text, 0).toFixed(4)}`);
    expect(cer("scan-table-1p", section.text, 0)).toBeLessThanOrEqual(0.05);
  });

  test("a mixed document converts each page by its own route", async () => {
    const result = await converted(page, "mixed-bad-text-layer");
    const { sections } = inspect(result);
    expect(sections).toHaveLength(2);
    expect(sections[0].text).not.toMatch(/[ÃÂÄÅ]/);
    expect(cer("mixed-bad-text-layer", sections[0].text, 0)).toBeLessThanOrEqual(0.03);
    expect(cer("mixed-bad-text-layer", sections[1].text, 1)).toBeLessThanOrEqual(0.005);
    expect(result.progress.filter((item) => item.phase === "ocr").map((item) => item.page)).toEqual([1]);
    expect(result.progress.filter((item) => item.phase === "extracting").map((item) => item.page)).toEqual([2]);
  });

  test("forced OCR reads a native page through OCR only", async () => {
    const result = await converted(page, "native-diacritics-1p", true);
    expect(result.progress.some((item) => item.phase === "extracting")).toBe(false);
    expect(result.progress.some((item) => item.phase === "ocr")).toBe(true);
    expect(result.warnings).not.toContain("FONT_SUBSTITUTED");
  });

  test("a blank middle page and an oversized page still produce valid documents", async () => {
    const blank = inspect(await converted(page, "blank-page-mid"));
    expect(blank.sections.map((section) => section.text)).toEqual(["Trang 1", "", "Trang 3"]);
    const large = inspect(await converted(page, "large-page-native"));
    expect(large.sections[0].text).toBe("Large format page 1");
    const widths = [...large.xml.matchAll(/<w:pgSz w:w="(\d+)" w:h="(\d+)"/g)].map((match) => Math.max(Number(match[1]), Number(match[2])));
    expect(Math.max(...widths)).toBeLessThanOrEqual(31680);
  });

  test("the exact limits convert and everything invalid is refused with a typed error and no document", async () => {
    expect((await convert(page, "limit-size-exact")).ok).toBe(true);
    expect((await convert(page, "limit-pages-20")).ok).toBe(true);
    for (const fixture of FIXTURES.filter((item) => item.expectedOutcome === "reject")) {
      expect(await convert(page, fixture.id), fixture.id).toEqual({ ok: false, code: fixture.rejectCode });
    }
  });

  test("a second conversion started during the first is refused, and the first still completes", async () => {
    const { first, second } = await page.evaluate(([data, name]) => window.__e2e!.convertConcurrently(data, name), [fixtureBase64("native-list-3p"), "native-list-3p.pdf"] as const);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, code: "CONVERSION_FAILED" });
  });

  test("a ten-page native document converts quickly", async () => {
    const started = Date.now();
    const result = await converted(page, "perf-native-10p");
    console.log(`perf-native-10p: ${Date.now() - started} ms`);
    expect(result.pageCount).toBe(10);
  });

  test("made no network request after initialization", async () => {
    expect(requestsAfterInit).toEqual([]);
  });
});

test.describe("cancelling a conversion", () => {
  test("between pages leaves the engines usable", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await openApp(page);
    await page.evaluate(() => window.__e2e!.initialize());
    expect(await convert(page, "perf-native-10p", false, 0)).toMatchObject({ ok: false, code: "ABORTED" });
    expect(await page.evaluate(() => window.__e2e!.sessionUsable())).toBe(true);
    expect((await convert(page, "native-congvan-1p")).ok).toBe(true);
    await context.close();
  });

  test("during OCR stops the recognition, returns no document and requires fresh engines", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await openApp(page);
    await page.evaluate(() => window.__e2e!.initialize());
    const started = Date.now();
    expect(await convert(page, "perf-scan-5p", false, 300)).toMatchObject({ ok: false, code: "ABORTED" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(await page.evaluate(() => window.__e2e!.sessionUsable())).toBe(false);
    expect(await convert(page, "native-congvan-1p")).toEqual({ ok: false, code: "CONVERSION_FAILED" });
    await context.close();
  });
});
