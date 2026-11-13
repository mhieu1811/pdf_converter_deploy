import type { PDFDocumentProxy, PDFPageProxy, PDFWorker } from "pdfjs-dist";
import {
  PDFJS_CMAP_URL,
  PDFJS_FONT_URL,
  PDFJS_WASM_URL,
  PDFJS_WORKER_URL,
  createPreloadedBinaryDataFactory,
} from "./assets";
import type { EngineSession } from "./convert";
import {
  ConversionError,
  type Bounds,
  type PageAnalysis,
  type PageMode,
  type RenderedPage,
  type TextSpan,
  type Warning,
} from "./types";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PAGES = 20;
export const MAX_RENDER_PIXELS = 12_000_000;
const MAX_RENDER_SIDE = 16_384;
const OCR_DPI = 200;

export function validateFileSize(size: number): void {
  if (size <= 0) throw new ConversionError("INVALID_PDF", "Tệp trống hoặc không phải là PDF hợp lệ.");
  if (size > MAX_FILE_BYTES) {
    throw new ConversionError("FILE_TOO_LARGE", "Tệp vượt quá giới hạn 10 MiB.");
  }
}

export function validatePageCount(count: number): void {
  if (count < 1) throw new ConversionError("INVALID_PDF", "Tệp PDF không có trang nào.");
  if (count > MAX_PAGES) {
    throw new ConversionError("TOO_MANY_PAGES", `Tệp có ${count} trang, vượt quá giới hạn ${MAX_PAGES} trang.`);
  }
}

/** Pixel size for OCR rendering: about 200 DPI, capped at 12 megapixels. */
export function getRenderSize(widthPt: number, heightPt: number): { width: number; height: number; downscaled: boolean } {
  const scale = OCR_DPI / 72;
  let width = Math.max(1, Math.round(widthPt * scale));
  let height = Math.max(1, Math.round(heightPt * scale));
  const areaFactor = Math.sqrt(MAX_RENDER_PIXELS / (width * height));
  const sideFactor = MAX_RENDER_SIDE / Math.max(width, height);
  const factor = Math.min(1, areaFactor, sideFactor);
  if (factor === 1) return { width, height, downscaled: false };
  width = Math.max(1, Math.floor(width * factor));
  height = Math.max(1, Math.floor(height * factor));
  return { width, height, downscaled: true };
}

const VIETNAMESE_LETTERS = new Set(
  "ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯư",
);
const ALLOWED_SYMBOLS = new Set(
  "\u00a0\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u2022\u00b0\u00b2\u00b3\u00b1\u00d7\u00f7\u20ab\u20ac\u00a7\u00a9\u00ae\u2116\u00b7",
);

function isExpectedCharacter(char: string): boolean {
  const code = char.codePointAt(0)!;
  return (
    (code >= 0x20 && code <= 0x7e) ||
    (code >= 0x1ea0 && code <= 0x1ef9) ||
    (code >= 0x0300 && code <= 0x0309) ||
    code === 0x0323 ||
    VIETNAMESE_LETTERS.has(char) ||
    ALLOWED_SYMBOLS.has(char)
  );
}

/**
 * Detects text layers that cannot be trusted (UTF-8 read as Windows-1252, private-use
 * or replacement glyphs, control characters) by the share of unexpected characters.
 */
export function assessTextQuality(text: string): { suspiciousRatio: number; usable: boolean } {
  const chars = Array.from(text.normalize("NFC").replace(/\s+/g, ""));
  if (chars.length === 0) return { suspiciousRatio: 0, usable: true };
  const suspicious = chars.filter((char) => !isExpectedCharacter(char)).length;
  const suspiciousRatio = suspicious / chars.length;
  return { suspiciousRatio, usable: suspiciousRatio < SUSPICIOUS_LIMIT };
}

const SUSPICIOUS_LIMIT = 0.05;
const IMAGE_DOMINANT = 0.1;
const SPARSE_TEXT = 0.08;

export type PageAnalysisInput = {
  charCount: number;
  textCoverage: number;
  imageCoverage: number;
  suspiciousRatio: number;
};

/**
 * A page is OCRed when its text layer is untrustworthy, or when a substantial image
 * carries the content (a scan, a hidden text layer, or a scanned body under a native header).
 */
export function choosePageMode(input: PageAnalysisInput): PageMode {
  if (input.charCount > 0 && input.suspiciousRatio >= SUSPICIOUS_LIMIT) return "ocr";
  if (input.imageCoverage >= IMAGE_DOMINANT && input.textCoverage < SPARSE_TEXT) return "ocr";
  return "native";
}

type Pdfjs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<Pdfjs> | undefined;

function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist").then((module) => {
    module.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    return module;
  });
  return pdfjsPromise;
}

export async function createPdfWorker(): Promise<PDFWorker> {
  const pdfjs = await loadPdfjs();
  const worker = new pdfjs.PDFWorker({ verbosity: 0 });
  try {
    await worker.promise;
  } catch {
    worker.destroy();
    throw new ConversionError("ASSET_LOAD_FAILED", "Không tải được bộ đọc PDF.");
  }
  return worker;
}

export type PdfSession = {
  readonly pageCount: number;
  analyzePage(pageNumber: number): Promise<PageAnalysis>;
  renderPage(pageNumber: number): Promise<RenderedPage>;
  close(): Promise<void>;
};

function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

export async function openPdf(file: File, session: EngineSession): Promise<PdfSession> {
  validateFileSize(file.size);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasPdfHeader(bytes)) {
    throw new ConversionError("INVALID_PDF", "Tệp không phải là PDF hợp lệ.");
  }
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: bytes,
    worker: session.pdfWorker,
    // Engine data is answered from memory; see assets.ts.
    BinaryDataFactory: createPreloadedBinaryDataFactory(session.pdfData),
    useWorkerFetch: false,
    cMapUrl: PDFJS_CMAP_URL,
    standardFontDataUrl: PDFJS_FONT_URL,
    wasmUrl: PDFJS_WASM_URL,
    enableXfa: false,
    useSystemFonts: false,
    fontExtraProperties: true,
    verbosity: 0,
  });
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => undefined);
    if (error instanceof Error && error.name === "PasswordException") {
      throw new ConversionError("PROTECTED_PDF", "Tệp PDF được bảo vệ bằng mật khẩu nên chưa được hỗ trợ.");
    }
    throw new ConversionError("INVALID_PDF", "Tệp không phải là PDF hợp lệ hoặc đã bị hỏng.");
  }
  try {
    validatePageCount(doc.numPages);
  } catch (error) {
    await task.destroy().catch(() => undefined);
    throw error;
  }
  return new PdfjsSession(pdfjs, doc, () => task.destroy());
}

type Matrix = [number, number, number, number, number, number];

const multiply = (a: ArrayLike<number>, b: ArrayLike<number>): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

function boundsOfPoints(points: [number, number][]): Bounds {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const transformPoint = (m: ArrayLike<number>, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

const MAX_RULE_THICKNESS_PT = 2.5;
const MIN_RULE_LENGTH_PT = 12;

function clippedArea(bounds: Bounds, widthPt: number, heightPt: number): number {
  const width = Math.min(bounds.x + bounds.width, widthPt) - Math.max(bounds.x, 0);
  const height = Math.min(bounds.y + bounds.height, heightPt) - Math.max(bounds.y, 0);
  return width > 0 && height > 0 ? width * height : 0;
}

class PdfjsSession implements PdfSession {
  readonly pageCount: number;

  constructor(
    private readonly pdfjs: Pdfjs,
    private readonly doc: PDFDocumentProxy,
    private readonly destroy: () => Promise<void>,
  ) {
    this.pageCount = doc.numPages;
  }

  async analyzePage(pageNumber: number): Promise<PageAnalysis> {
    const page = await this.doc.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale: 1 });
      const [content, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
      const widthPt = viewport.width;
      const heightPt = viewport.height;

      const spans: TextSpan[] = [];
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
        if (item.str === "") continue;
        const tx = multiply(viewport.transform, item.transform);
        const fontSizePt = Math.hypot(tx[2], tx[3]);
        const length = Math.hypot(tx[0], tx[1]) || 1;
        const direction: [number, number] = [tx[0] / length, tx[1] / length];
        const origin: [number, number] = [tx[4], tx[5]];
        const end: [number, number] = [origin[0] + direction[0] * item.width, origin[1] + direction[1] * item.width];
        const up: [number, number] = [tx[2], tx[3]];
        const bounds = boundsOfPoints([
          origin,
          end,
          [origin[0] + up[0], origin[1] + up[1]],
          [end[0] + up[0], end[1] + up[1]],
        ]);
        const fontName = page.commonObjs.has(item.fontName) ? String(page.commonObjs.get(item.fontName)?.name ?? "") : "";
        spans.push({
          text: item.str,
          bounds,
          fontSizePt,
          bold: /bold|black|heavy|semibold|demi/i.test(fontName),
          italic: /italic|oblique/i.test(fontName),
          fontName: fontName || undefined,
        });
      }

      const { imageBounds, horizontalRules, verticalRules } = this.scanOperators(operators, viewport.transform);
      const pageArea = widthPt * heightPt;
      const textCoverage = Math.min(1, spans.reduce((sum, span) => sum + clippedArea(span.bounds, widthPt, heightPt), 0) / pageArea);
      const imageCoverage = Math.min(1, imageBounds.reduce((sum, bounds) => sum + clippedArea(bounds, widthPt, heightPt), 0) / pageArea);
      const quality = assessTextQuality(text);
      const charCount = text.replace(/\s+/g, "").length;
      return {
        pageNumber,
        widthPt,
        heightPt,
        mode: choosePageMode({ charCount, textCoverage, imageCoverage, suspiciousRatio: quality.suspiciousRatio }),
        text,
        spans,
        imageBounds,
        horizontalRules,
        verticalRules,
        textCoverage,
        imageCoverage,
        suspiciousRatio: quality.suspiciousRatio,
      };
    } finally {
      page.cleanup();
    }
  }

  async renderPage(pageNumber: number): Promise<RenderedPage> {
    const page = await this.doc.getPage(pageNumber);
    try {
      const base = page.getViewport({ scale: 1 });
      const size = getRenderSize(base.width, base.height);
      const viewport = page.getViewport({ scale: size.width / base.width });
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      await page.render({ canvas, viewport }).promise;
      const image = await createImageBitmap(canvas);
      canvas.width = 0;
      canvas.height = 0;
      const warnings: Warning[] = size.downscaled
        ? [{ code: "DOWNSCALED", pageNumber, message: "Trang quá lớn nên được giảm độ phân giải khi nhận dạng chữ." }]
        : [];
      return {
        image,
        widthPt: base.width,
        heightPt: base.height,
        pixelWidth: size.width,
        pixelHeight: size.height,
        warnings,
      };
    } finally {
      page.cleanup();
    }
  }

  async close(): Promise<void> {
    await this.destroy();
  }

  private scanOperators(operators: Awaited<ReturnType<PDFPageProxy["getOperatorList"]>>, viewportTransform: ArrayLike<number>) {
    const { OPS } = this.pdfjs;
    const ids = (...names: (keyof typeof OPS)[]) => new Set(names.map((name) => OPS[name] as number).filter((id) => id !== undefined));
    const paintOps = ids("fill", "eoFill", "stroke", "fillStroke", "eoFillStroke", "closeStroke", "closeFillStroke", "closeEOFillStroke");
    const imageOps = ids("paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject");

    const imageBounds: Bounds[] = [];
    const horizontalRules: Bounds[] = [];
    const verticalRules: Bounds[] = [];
    const stack: Matrix[] = [];
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];

    operators.fnArray.forEach((fn, index) => {
      const args = operators.argsArray[index];
      if (fn === OPS.save) {
        stack.push(ctm);
      } else if (fn === OPS.restore) {
        ctm = stack.pop() ?? ctm;
      } else if (fn === OPS.transform) {
        ctm = multiply(ctm, args as number[]);
      } else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (args?.[0]) ctm = multiply(ctm, args[0] as number[]);
      } else if (fn === OPS.paintFormXObjectEnd) {
        ctm = stack.pop() ?? ctm;
      } else if (imageOps.has(fn)) {
        const full = multiply(viewportTransform, ctm);
        imageBounds.push(boundsOfPoints([[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => transformPoint(full, x, y))));
      } else if (fn === OPS.constructPath && paintOps.has(args[0]) && args[2]) {
        const [minX, minY, maxX, maxY] = Array.from(args[2] as ArrayLike<number>);
        const full = multiply(viewportTransform, ctm);
        const bounds = boundsOfPoints([[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]].map(([x, y]) => transformPoint(full, x, y)));
        if (bounds.height <= MAX_RULE_THICKNESS_PT && bounds.width >= MIN_RULE_LENGTH_PT) horizontalRules.push(bounds);
        else if (bounds.width <= MAX_RULE_THICKNESS_PT && bounds.height >= MIN_RULE_LENGTH_PT) verticalRules.push(bounds);
      }
    });
    return { imageBounds, horizontalRules, verticalRules };
  }
}
