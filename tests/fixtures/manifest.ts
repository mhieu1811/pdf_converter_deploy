import type { ConversionErrorCode, PageMode } from "../../src/converter/types";
import {
  BAD_LAYER_NATIVE_PAGE2,
  BAD_LAYER_SCANNED,
  MIXED_HEADING,
  MIXED_NATIVE_PAGE2,
  MIXED_SCANNED_BODY,
  congvan,
  countArtwork,
  countTables,
  diacritics,
  listPlan,
  longDocument,
  referenceOfBlocks,
  referenceOfLines,
  tableLetter,
  type TemplatePage,
} from "./templates";

export type FixturePage = { mode: PageMode; referenceText: string; criticalFields: string[] };

export type FixtureCase = {
  id: string;
  category: "native" | "scan" | "mixed" | "performance" | "limit" | "invalid" | "edge";
  description: string;
  pdfPath: string;
  pages: FixturePage[];
  expectedTableCount: number;
  expectedArtworkCount: number;
  expectedOutcome: "convert" | "reject";
  rejectCode?: ConversionErrorCode;
};

const pdfPath = (id: string) => `.test-artifacts/fixtures/${id}.pdf`;

function fromTemplate(
  id: string,
  category: FixtureCase["category"],
  description: string,
  template: TemplatePage[],
  mode: PageMode,
): FixtureCase {
  return {
    id,
    category,
    description,
    pdfPath: pdfPath(id),
    pages: template.map((page) => ({
      mode,
      referenceText: referenceOfBlocks(page.blocks),
      criticalFields: page.criticalFields,
    })),
    expectedTableCount: countTables(template),
    expectedArtworkCount: countArtwork(template),
    expectedOutcome: "convert",
  };
}

const simplePage = (mode: PageMode, referenceText: string): FixturePage => ({ mode, referenceText, criticalFields: [] });
const numberedPages = (count: number): FixturePage[] =>
  Array.from({ length: count }, (_, index) => simplePage("native", `Trang ${index + 1}`));

const reject = (
  id: string,
  category: FixtureCase["category"],
  description: string,
  rejectCode: ConversionErrorCode,
): FixtureCase => ({
  id,
  category,
  description,
  pdfPath: pdfPath(id),
  pages: [],
  expectedTableCount: 0,
  expectedArtworkCount: 0,
  expectedOutcome: "reject",
  rejectCode,
});

const MIXED_HEADER_REFERENCE = `${referenceOfLines(MIXED_HEADING)}\n${referenceOfLines(MIXED_SCANNED_BODY)}`;

export const FIXTURES: FixtureCase[] = [
  fromTemplate("native-congvan-1p", "native", "Letter with two-column header, recipient, body, signature block and mock stamp", congvan, "native"),
  fromTemplate("native-table-1p", "native", "Letter with a ruled 4x4 table", tableLetter, "native"),
  fromTemplate("native-list-3p", "native", "Three-page plan with headings, numbered and bulleted items", listPlan, "native"),
  fromTemplate("native-diacritics-1p", "native", "Dense Vietnamese diacritics with bold, italic and centered runs", diacritics, "native"),

  fromTemplate("scan-congvan-1p", "scan", "Clean 192 DPI scan of the letter with mock stamp", congvan, "ocr"),
  fromTemplate("scan-table-1p", "scan", "Clean scan of the table letter", tableLetter, "ocr"),
  fromTemplate("scan-skewed-noisy-1p", "scan", "Letter scan with 1 degree skew, sensor noise and specks", congvan, "ocr"),
  fromTemplate("scan-rotated-1p", "scan", "Diacritics page stored sideways with /Rotate 90", diacritics, "ocr"),

  {
    id: "mixed-header-native-body-scan",
    category: "mixed",
    description: "Page 1: native heading above a scanned-only body; page 2: fully native",
    pdfPath: pdfPath("mixed-header-native-body-scan"),
    pages: [
      { mode: "ocr", referenceText: MIXED_HEADER_REFERENCE, criticalFields: ["Số: 77/SKH-VP", "ngày 20 tháng 11 năm 2026"] },
      simplePage("native", referenceOfLines(MIXED_NATIVE_PAGE2)),
    ],
    expectedTableCount: 0,
    expectedArtworkCount: 0,
    expectedOutcome: "convert",
  },
  {
    id: "mixed-bad-text-layer",
    category: "mixed",
    description: "Page 1: scan with a mojibake hidden text layer; page 2: native",
    pdfPath: pdfPath("mixed-bad-text-layer"),
    pages: [
      { mode: "ocr", referenceText: referenceOfLines(BAD_LAYER_SCANNED), criticalFields: ["Số: 64/TB-SKH"] },
      simplePage("native", referenceOfLines(BAD_LAYER_NATIVE_PAGE2)),
    ],
    expectedTableCount: 0,
    expectedArtworkCount: 0,
    expectedOutcome: "convert",
  },

  fromTemplate("perf-native-10p", "performance", "Ten native text pages", longDocument(10, "Báo cáo tổng hợp"), "native"),
  fromTemplate("perf-scan-5p", "performance", "Five clean scanned pages", longDocument(5, "Báo cáo quét"), "ocr"),

  {
    id: "limit-size-exact",
    category: "limit",
    description: "Valid one-page PDF of exactly 10 MiB",
    pdfPath: pdfPath("limit-size-exact"),
    pages: [simplePage("native", "Trang 1")],
    expectedTableCount: 0,
    expectedArtworkCount: 0,
    expectedOutcome: "convert",
  },
  reject("limit-size-over", "limit", "Valid PDF of 10 MiB plus one byte", "FILE_TOO_LARGE"),
  {
    id: "limit-pages-20",
    category: "limit",
    description: "Twenty native pages",
    pdfPath: pdfPath("limit-pages-20"),
    pages: numberedPages(20),
    expectedTableCount: 0,
    expectedArtworkCount: 0,
    expectedOutcome: "convert",
  },
  reject("limit-pages-21", "limit", "Twenty-one native pages", "TOO_MANY_PAGES"),

  reject("invalid-corrupt", "invalid", "Truncated PDF header with garbage", "INVALID_PDF"),
  reject("invalid-not-pdf", "invalid", "Plain text renamed to .pdf", "INVALID_PDF"),
  reject("protected-pdf", "invalid", "PDF with an /Encrypt dictionary and unknown password", "PROTECTED_PDF"),

  reject("scan-unreadable-1p", "edge", "Scan with ink that is neither text nor an isolatable picture (scattered strokes)", "QUALITY_FAILURE"),
  {
    id: "scan-figure-1p",
    category: "edge",
    description: "Scanned text page with a large dark photo below the text",
    pdfPath: pdfPath("scan-figure-1p"),
    pages: [{ mode: "ocr", referenceText: referenceOfBlocks(diacritics[0].blocks), criticalFields: diacritics[0].criticalFields }],
    expectedTableCount: 0,
    expectedArtworkCount: 1,
    expectedOutcome: "convert",
  },

  {
    id: "blank-page-mid",
    category: "edge",
    description: "Three pages; the middle page is blank",
    pdfPath: pdfPath("blank-page-mid"),
    pages: [simplePage("native", "Trang 1"), simplePage("native", ""), simplePage("native", "Trang 3")],
    expectedTableCount: 0,
    expectedArtworkCount: 0,
    expectedOutcome: "convert",
  },
  {
    id: "large-page-native",
    category: "edge",
    description: "One 2384 x 3370 pt native page that exceeds the render pixel cap at 200 DPI",
    pdfPath: pdfPath("large-page-native"),
    pages: [simplePage("native", "Large format page 1")],
    expectedTableCount: 0,
    expectedArtworkCount: 0,
    expectedOutcome: "convert",
  },
];

export function getFixture(id: string): FixtureCase {
  const fixture = FIXTURES.find((item) => item.id === id);
  if (!fixture) throw new Error(`Unknown fixture: ${id}`);
  return fixture;
}
