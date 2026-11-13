import { describe, expect, it } from "vitest";
import { FIXTURES, getFixture } from "./manifest";

const byCategory = (category: string) => FIXTURES.filter((fixture) => fixture.category === category);

describe("fixture manifest", () => {
  it("has unique ids and PDF paths kept out of production assets", () => {
    const ids = FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fixture of FIXTURES) {
      expect(fixture.pdfPath.startsWith(".test-artifacts/fixtures/")).toBe(true);
      expect(fixture.pdfPath.endsWith(".pdf")).toBe(true);
    }
  });

  it("covers four native, four scanned, two mixed and the two performance documents", () => {
    expect(byCategory("native")).toHaveLength(4);
    expect(byCategory("scan")).toHaveLength(4);
    expect(byCategory("mixed")).toHaveLength(2);
    expect(getFixture("perf-native-10p").pages).toHaveLength(10);
    expect(getFixture("perf-scan-5p").pages).toHaveLength(5);
  });

  it("routes native pages to extraction, scans to OCR and keeps mixed documents mixed", () => {
    for (const fixture of byCategory("native")) {
      expect(fixture.pages.every((page) => page.mode === "native")).toBe(true);
    }
    for (const fixture of byCategory("scan")) {
      expect(fixture.pages.every((page) => page.mode === "ocr")).toBe(true);
    }
    expect(getFixture("mixed-header-native-body-scan").pages.map((page) => page.mode)).toEqual(["ocr", "native"]);
    expect(getFixture("mixed-bad-text-layer").pages.map((page) => page.mode)).toEqual(["ocr", "native"]);
  });

  it("records the authored structure the converter must preserve", () => {
    expect(getFixture("native-table-1p").expectedTableCount).toBe(1);
    expect(getFixture("scan-table-1p").expectedTableCount).toBe(1);
    expect(getFixture("native-congvan-1p").expectedArtworkCount).toBe(1);
    expect(getFixture("scan-congvan-1p").expectedArtworkCount).toBe(1);
    expect(getFixture("native-list-3p").pages).toHaveLength(3);
  });

  it("keeps every critical field inside its page's reference text", () => {
    for (const fixture of FIXTURES) {
      for (const page of fixture.pages) {
        for (const field of page.criticalFields) {
          expect(page.referenceText, `${fixture.id}: ${field}`).toContain(field);
        }
      }
    }
    expect(getFixture("native-congvan-1p").pages[0].criticalFields.length).toBeGreaterThanOrEqual(3);
  });

  it("describes rejected inputs by their expected error code and boundary pairs", () => {
    for (const fixture of FIXTURES.filter((item) => item.expectedOutcome === "reject")) {
      expect(fixture.rejectCode, fixture.id).toBeDefined();
      expect(fixture.pages).toHaveLength(0);
    }
    expect(getFixture("limit-size-exact").expectedOutcome).toBe("convert");
    expect(getFixture("limit-size-over").rejectCode).toBe("FILE_TOO_LARGE");
    expect(getFixture("limit-pages-20").pages).toHaveLength(20);
    expect(getFixture("limit-pages-21").rejectCode).toBe("TOO_MANY_PAGES");
    expect(getFixture("invalid-corrupt").rejectCode).toBe("INVALID_PDF");
    expect(getFixture("invalid-not-pdf").rejectCode).toBe("INVALID_PDF");
    expect(getFixture("protected-pdf").rejectCode).toBe("PROTECTED_PDF");
  });

  it("includes a blank page, an oversized page and Vietnamese text in NFC form", () => {
    expect(getFixture("blank-page-mid").pages[1].referenceText).toBe("");
    expect(getFixture("large-page-native").expectedOutcome).toBe("convert");
    const text = getFixture("native-diacritics-1p").pages[0].referenceText;
    expect(text).toBe(text.normalize("NFC"));
    expect(text).toContain("Nguyễn Thị Thuỷ");
  });
});
