import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { FIXTURES } from "../fixtures/manifest";
import { analyzeFixture, fixtureBase64, normalizeText, openApp } from "./helpers";

const MAX_RENDER_PIXELS = 12_000_000;

async function okResult(page: Page, id: string) {
  const result = await analyzeFixture(page, id);
  if (!result.ok) throw new Error(`${id}: unexpected rejection ${result.code}`);
  return result;
}

test.describe("PDF reading with engines initialized once, then offline", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let page: Page;
  let initialized = false;
  const requestsAfterInit: string[] = [];
  const failuresAfterInit: string[] = [];

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    page.on("request", (request) => {
      if (initialized) requestsAfterInit.push(request.url());
    });
    page.on("requestfailed", (request) => {
      if (initialized) failuresAfterInit.push(request.url());
    });
    await openApp(page);
    const start = Date.now();
    await page.evaluate(() => window.__e2e!.initialize());
    console.log(`cold engine initialization: ${Date.now() - start} ms`);
    initialized = true;
    await context.setOffline(true);
  });

  test.afterAll(async () => {
    await page.evaluate(() => window.__e2e!.dispose()).catch(() => undefined);
    await context.close();
  });

  test("routes every page of every convertible fixture to the expected mode within the render cap", async () => {
    for (const fixture of FIXTURES.filter((item) => item.expectedOutcome === "convert")) {
      const result = await okResult(page, fixture.id);
      expect(result.pageCount, fixture.id).toBe(fixture.pages.length);
      for (const [index, expected] of fixture.pages.entries()) {
        const actual = result.pages[index];
        expect(actual.mode, `${fixture.id} page ${index + 1}`).toBe(expected.mode);
        expect(actual.render.pixelWidth * actual.render.pixelHeight, fixture.id).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
      }
    }
  });

  test("warns when an oversized page is rendered below 200 DPI", async () => {
    const result = await okResult(page, "large-page-native");
    expect(result.pages[0].render.warnings).toEqual(["DOWNSCALED"]);
    const a4 = await okResult(page, "native-congvan-1p");
    expect(a4.pages[0].render.warnings).toEqual([]);
  });

  test("extracts every authored line and critical field from native text layers", async () => {
    for (const fixture of FIXTURES.filter((item) => item.category === "native" || item.id === "perf-native-10p")) {
      const result = await okResult(page, fixture.id);
      for (const [index, expected] of fixture.pages.entries()) {
        const text = normalizeText(result.pages[index].text);
        for (const line of expected.referenceText.split("\n").filter(Boolean)) {
          expect(text, `${fixture.id} page ${index + 1}`).toContain(normalizeText(line));
        }
      }
    }
  });

  test("keeps the native page of a mixed document and OCR-routes the scanned one", async () => {
    const mixed = await okResult(page, "mixed-header-native-body-scan");
    expect(mixed.pages.map((item) => item.mode)).toEqual(["ocr", "native"]);
    expect(normalizeText(mixed.pages[1].text)).toContain("PHỤ LỤC: DANH SÁCH ĐƠN VỊ NHẬN VĂN BẢN");
    const bad = await okResult(page, "mixed-bad-text-layer");
    expect(bad.pages[0].text.trim().length).toBeGreaterThan(0);
    expect(bad.pages[0].mode).toBe("ocr");
  });

  test("reports font weight and slant, rules and artwork geometry", async () => {
    const diacritics = (await okResult(page, "native-diacritics-1p")).pages[0];
    expect(diacritics.spans.some((span) => span.bold)).toBe(true);
    expect(diacritics.spans.some((span) => span.italic)).toBe(true);
    expect(diacritics.spans.some((span) => !span.bold && !span.italic)).toBe(true);

    const letter = (await okResult(page, "native-congvan-1p")).pages[0];
    expect(letter.imageBounds).toHaveLength(1);
    expect(letter.imageCoverage).toBeLessThan(0.03);
    expect(letter.horizontalRules).toHaveLength(0);
    expect(letter.verticalRules).toHaveLength(0);
    for (const span of letter.spans) {
      expect(span.bounds.x).toBeGreaterThanOrEqual(0);
      expect(span.bounds.y).toBeGreaterThanOrEqual(0);
      expect(span.bounds.x + span.bounds.width).toBeLessThanOrEqual(letter.widthPt + 1);
      expect(span.bounds.y + span.bounds.height).toBeLessThanOrEqual(letter.heightPt + 1);
    }

    const table = (await okResult(page, "native-table-1p")).pages[0];
    expect(table.horizontalRules.length).toBeGreaterThanOrEqual(5);
    expect(table.verticalRules.length).toBeGreaterThanOrEqual(5);

    const scan = (await okResult(page, "scan-congvan-1p")).pages[0];
    expect(scan.imageBounds).toHaveLength(1);
    expect(scan.imageCoverage).toBeGreaterThan(0.95);
  });

  test("reports a sideways-stored scan as an upright portrait page", async () => {
    const rotated = (await okResult(page, "scan-rotated-1p")).pages[0];
    expect(rotated.widthPt).toBeCloseTo(595.28, 0);
    expect(rotated.heightPt).toBeCloseTo(841.89, 0);
    expect(rotated.render.pixelWidth).toBeLessThan(rotated.render.pixelHeight);
  });

  test("applies the 10 MiB and 20-page boundaries and rejects bad input with typed errors", async () => {
    for (const fixture of FIXTURES.filter((item) => item.category === "limit" || item.category === "invalid")) {
      const result = await analyzeFixture(page, fixture.id);
      if (fixture.expectedOutcome === "reject") {
        expect(result, fixture.id).toMatchObject({ ok: false, code: fixture.rejectCode });
      } else {
        expect(result.ok, fixture.id).toBe(true);
      }
    }
  });

  test("renders the same document repeatedly on one engine session", async () => {
    const first = await okResult(page, "native-list-3p");
    const second = await okResult(page, "native-list-3p");
    expect(second.pages.map((item) => item.text)).toEqual(first.pages.map((item) => item.text));
  });

  test("writes synthetic previews for manual inspection", async () => {
    const dir = path.resolve(".test-artifacts/previews");
    mkdirSync(dir, { recursive: true });
    for (const id of ["native-congvan-1p", "native-table-1p", "scan-skewed-noisy-1p", "scan-rotated-1p", "mixed-header-native-body-scan"]) {
      const dataUrl = await page.evaluate(([data, name]) => window.__e2e!.previewPng(data, name, 1), [fixtureBase64(id), `${id}.pdf`] as const);
      writeFileSync(path.join(dir, `${id}.png`), Buffer.from(dataUrl.split(",")[1], "base64"));
    }
  });

  test("made no network request after initialization, including blocked ones", async () => {
    expect(requestsAfterInit).toEqual([]);
    expect(failuresAfterInit).toEqual([]);
  });
});

test.describe("startup failures are typed", () => {
  test("a missing OCR model fails initialization with ASSET_LOAD_FAILED", async ({ page }) => {
    await page.route("**/engine/tesseract/lang/vie.traineddata.gz", (route) => route.abort());
    await openApp(page);
    await expect(page.evaluate(() => window.__e2e!.initialize())).rejects.toThrow("ConversionError:ASSET_LOAD_FAILED");
  });

  test("an HTML fallback served in place of a PDF.js font fails with ASSET_LOAD_FAILED", async ({ page }) => {
    await page.route("**/engine/pdfjs/standard_fonts/FoxitFixed.pfb", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html></html>" }),
    );
    await openApp(page);
    await expect(page.evaluate(() => window.__e2e!.initialize())).rejects.toThrow("ConversionError:ASSET_LOAD_FAILED");
  });
});
