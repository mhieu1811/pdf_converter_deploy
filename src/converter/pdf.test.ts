import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_PAGES,
  MAX_RENDER_PIXELS,
  assessTextQuality,
  choosePageMode,
  getRenderSize,
  validateFileSize,
  validatePageCount,
} from "./pdf";
import { ConversionError } from "./types";

const codeOf = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    return error instanceof ConversionError ? error.code : "other";
  }
  return "none";
};

describe("validation limits", () => {
  it("admits exactly 10 MiB and rejects one byte more", () => {
    expect(MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(codeOf(() => validateFileSize(MAX_FILE_BYTES))).toBe("none");
    expect(codeOf(() => validateFileSize(MAX_FILE_BYTES + 1))).toBe("FILE_TOO_LARGE");
  });

  it("admits 20 pages and rejects 21", () => {
    expect(MAX_PAGES).toBe(20);
    expect(codeOf(() => validatePageCount(20))).toBe("none");
    expect(codeOf(() => validatePageCount(21))).toBe("TOO_MANY_PAGES");
  });

  it("rejects an empty file and a document without pages as invalid", () => {
    expect(codeOf(() => validateFileSize(0))).toBe("INVALID_PDF");
    expect(codeOf(() => validatePageCount(0))).toBe("INVALID_PDF");
  });
});

describe("getRenderSize", () => {
  it("renders A4 near 200 DPI without downscaling", () => {
    expect(getRenderSize(595.28, 841.89)).toEqual({ width: 1654, height: 2339, downscaled: false });
  });

  it("keeps landscape orientation", () => {
    const size = getRenderSize(841.89, 595.28);
    expect(size.width).toBeGreaterThan(size.height);
  });

  it("never exceeds 12 megapixels and flags the downscale, even for huge or extreme pages", () => {
    expect(MAX_RENDER_PIXELS).toBe(12_000_000);
    for (const [w, h] of [[2384, 3370], [14400, 14400], [100, 14400], [3370, 2384]]) {
      const size = getRenderSize(w, h);
      expect(size.width * size.height, `${w}x${h}`).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
      expect(size.downscaled).toBe(true);
      expect(size.width).toBeGreaterThanOrEqual(1);
      expect(size.height).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("assessTextQuality", () => {
  it("accepts genuine Vietnamese, English and numeric table text", () => {
    for (const text of [
      "Thành phố Mẫu, ngày 12 tháng 11 năm 2026. Nguyễn Thị Thuỷ — Độc lập - Tự do - Hạnh phúc",
      "Quarterly report: résumé of results 2026",
      "1 Tổng thu ngân sách Tỷ đồng 1.254,7 2 843,2 3 1.087",
    ]) {
      expect(assessTextQuality(text).usable, text).toBe(true);
    }
  });

  it("rejects UTF-8 text that was decoded as Windows-1252", () => {
    const mojibake = new TextDecoder("windows-1252").decode(
      new TextEncoder().encode("Độc lập - Tự do - Hạnh phúc, thông báo lịch làm việc"),
    );
    expect(assessTextQuality(mojibake).usable).toBe(false);
  });

  it("rejects private-use, replacement and control characters", () => {
    expect(assessTextQuality("\uE001\uE002\uE003 \uE004\uE005 \uE006\uE007\uE008 abc").usable).toBe(false);
    expect(assessTextQuality("\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD normal").usable).toBe(false);
    expect(assessTextQuality("\u0001\u0002\u0003\u0004 \u0005\u0006 text here ok").usable).toBe(false);
  });

  it("treats decomposed Vietnamese the same as composed", () => {
    expect(assessTextQuality("Vie\u0302\u0323t Nam hạnh phúc".normalize("NFD")).usable).toBe(true);
  });

  it("has nothing to judge in an empty text layer", () => {
    expect(assessTextQuality("  \n ").suspiciousRatio).toBe(0);
  });
});

describe("choosePageMode", () => {
  const dense = { charCount: 1800, textCoverage: 0.25, imageCoverage: 0, suspiciousRatio: 0 };

  it("extracts native pages", () => {
    expect(choosePageMode(dense)).toBe("native");
  });

  it("keeps a stamp-sized image on a text page native", () => {
    expect(choosePageMode({ ...dense, imageCoverage: 0.012 })).toBe("native");
  });

  it("keeps a page with a figure and real text native", () => {
    expect(choosePageMode({ ...dense, imageCoverage: 0.4, textCoverage: 0.15 })).toBe("native");
  });

  it("OCRs a full-page scan without any text layer", () => {
    expect(choosePageMode({ charCount: 0, textCoverage: 0, imageCoverage: 0.99, suspiciousRatio: 0 })).toBe("ocr");
  });

  it("OCRs a scan whose hidden text layer sits under the picture", () => {
    expect(choosePageMode({ charCount: 600, textCoverage: 0.01, imageCoverage: 0.99, suspiciousRatio: 0 })).toBe("ocr");
  });

  it("does not lose a scanned body under a small native header", () => {
    expect(choosePageMode({ charCount: 45, textCoverage: 0.03, imageCoverage: 0.16, suspiciousRatio: 0 })).toBe("ocr");
  });

  it("routes a corrupted text layer to OCR even without images", () => {
    expect(choosePageMode({ ...dense, suspiciousRatio: 0.3 })).toBe("ocr");
  });

  it("leaves a blank page native", () => {
    expect(choosePageMode({ charCount: 0, textCoverage: 0, imageCoverage: 0, suspiciousRatio: 0 })).toBe("native");
  });
});
